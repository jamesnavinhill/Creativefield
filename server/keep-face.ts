/* Keep face: a finish for a video result with a real person's face (,).
   SAM 3 looks at a few frames for "face" and "eyes"; the frame with two open eyes and the largest face
   becomes the face reference. The unchanged area-only H3 graph (h3-object-swap-hyperflow-area) then
   renders only the tracked face again from that reference, so the face keeps one identity through
   3D head turns while every other pixel stays the source's. The result is a normal run beside the original. */
import {execFile} from "node:child_process";
import {createReadStream} from "node:fs";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import {promisify} from "node:util";
import type {Pool} from "pg";
import sharp from "sharp";
import type {CapabilityBundle} from "../src/capabilities/types";
import type {ApiGraph} from "../src/workflow/build";
import {HttpError} from "./auth";
import {ComfyAnalysisClient} from "./comfy-analysis-runner";
import {hashToken, newId} from "./crypto";
import {transaction} from "./db";
import {canonical, enqueuePreparedRun, prepareInvocation} from "./run-submission";
import {TRACK_STRIDE, fadeWeight, planFaceCrop, planFixesSomething, writeCropClip} from "./face-crop";
import type {DiskStore} from "./storage";

const run = promisify(execFile);
const ffmpeg = () => process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = () => process.env.FFPROBE_PATH ?? "ffprobe";

/** The graph that renders the face again: shipped, unchanged, as a menu workflow. */
export const KEEP_FACE_CAPABILITY = "h3-object-swap-hyperflow-area";
/** What it is told; the picture carries the identity, the video the expression and motion. */
/** The picture gives only who the person is; the video gives how they look in each moment. A single reference picture
 *  otherwise carries its smile or closed eyes into every frame (,). */
export const KEEP_FACE_CHANGE_TO = "The picture provides only the facial identity: bone structure, face shape, eyes, nose, brows, lips and beard. Do not copy the expression, mouth position, eye state or head direction from the picture. Expression, gaze, mouth and head rotation come from the video. Same art style, rendering and light as the video.";
/** The image edit that turns the chosen frame into a neutral identity portrait before the face pass. */
export const KEEP_FACE_NEUTRAL_PROMPT = "Picture 1 shows a person's face. Make a clean identity portrait of exactly this same person: same face shape, eyes, nose, brows, lips, facial hair, hair and headwear, same art style, rendering and light. Neutral relaxed expression, mouth closed, lips together, no smile, eyes open looking straight into the camera, head facing the camera.";
/** The menu's image edit graph, used here only to neutralise the reference. */
export const KEEP_FACE_NEUTRALISER = "minimax-h3-image-edit";
/** Frames SAM 3 looks at; enough to find a frontal moment in a 15 s clip. */
export const KEEP_FACE_CANDIDATES = 8;
/** Space kept around the face in the reference, as a share of the face's width. */
const PADDING = 0.35;
/** A face smaller than this (box height in pixels) is too small to carry an identity; such a clip is left as it is. */
export const MIN_FACE_HEIGHT = 96;
/** A second eye counts when it is at least this share of the first (a far eye in three-quarter view). */
const SECOND_EYE_SHARE = 0.15;
const FPS = 24, MAX_SECONDS = 15;

export type FaceCandidate = {frame: number; faceArea: number; box?: [number, number, number, number]; eyes: number[]};

/** The frame whose face serves as reference: two open eyes first, then the larger smaller eye, then the larger face. */
export function pickFaceFrame(candidates: readonly FaceCandidate[]): FaceCandidate | undefined {
  const scored = candidates.filter(candidate => candidate.box && candidate.faceArea > 0 && candidate.box[3] - candidate.box[1] >= MIN_FACE_HEIGHT).map(candidate => {
    const eyes = [...candidate.eyes].sort((a, b) => b - a), both = eyes.length >= 2 && eyes[1] >= eyes[0] * SECOND_EYE_SHARE;
    return {candidate, key: [both ? 1 : 0, both ? eyes[1] : 0, candidate.faceArea]};
  });
  scored.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
  return scored[0]?.candidate;
}

/** The reference crop: the face box plus padding, kept inside the frame. */
export function referenceCrop(box: [number, number, number, number], width: number, height: number) {
  const [x0, y0, x1, y1] = box, pad = Math.round((x1 - x0) * PADDING);
  const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
  return {left, top, width: Math.min(width, x1 + pad) - left, height: Math.min(height, y1 + pad) - top};
}

/** Evenly spread frame indices, always with the last frame (a turn toward the camera usually ends there). */
export function candidateFrames(frameCount: number, count = KEEP_FACE_CANDIDATES): number[] {
  if (frameCount <= count) return Array.from({length: frameCount}, (_, index) => index);
  return [...new Set(Array.from({length: count}, (_, index) => Math.round(index * (frameCount - 1) / (count - 1))))];
}

/** Frames of the last picture appended to every Keep face source: the graph's loader cuts the sound to the frames it
 *  loads and the H3 chain then comes up two frames short ("audio window 0:73 exceeds 0:71",). The loader reads
 *  these extra frames; the render window (clip_seconds) stays the clip's own length. */
export const SOURCE_TAIL_FRAMES = 2;

/** Far-face pass (face-crop.ts) is parked (, user 2026-11-21): it works (crop, render, paste back), but one
 *  3 s clip costs 4-9 min of GPU for a small gain. Off until renders are cheaper; the stitch runs only on runs
 *  that carry invocation.faceCrop, which nothing creates while this is false. */
export const KEEP_FACE_FAR_PATH = false;

/** Controls for the area-only graph: the whole clip (up to 15 s), the face, 736p. */
export function keepFaceControls(frameCount: number, seed: number) {
  const seconds = Math.min(MAX_SECONDS, frameCount / FPS);
  return {prompt: "face", change_to: KEEP_FACE_CHANGE_TO, source_seconds: Math.min(MAX_SECONDS, (frameCount + SOURCE_TAIL_FRAMES) / FPS), clip_seconds: Math.max(2.5, Math.min(MAX_SECONDS, Math.round((seconds + 0.05) * 100) / 100)), resolution: "736p", seed};
}

/** Pixel count, box and connected parts of a white-on-black mask, measured on a copy at most 256 px wide. */
export async function maskStats(png: Buffer, width: number, height: number): Promise<{area: number; box?: [number, number, number, number]; parts: number[]}> {
  const scale = Math.min(1, 256 / width), w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const data = await sharp(png).greyscale().resize(w, h, {fit: "fill"}).raw().toBuffer();
  const seen = new Uint8Array(w * h), parts: number[] = [];
  let area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let start = 0; start < w * h; start++) {
    if (data[start] < 128 || seen[start]) continue;
    let size = 0; const stack = [start]; seen[start] = 1;
    while (stack.length) {
      const at = stack.pop()!, x = at % w, y = (at - x) / w; size++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (const next of [x > 0 ? at - 1 : -1, x < w - 1 ? at + 1 : -1, y > 0 ? at - w : -1, y < h - 1 ? at + w : -1]) {
        if (next >= 0 && !seen[next] && data[next] >= 128) { seen[next] = 1; stack.push(next); }
      }
    }
    area += size; parts.push(size);
  }
  if (!area) return {area: 0, parts: []};
  const back = (value: number) => Math.round(value / scale);
  return {area: back(back(area)), box: [back(x0), back(y0), Math.min(width, back(x1 + 1)), Math.min(height, back(y1 + 1))], parts: parts.sort((a, b) => b - a)};
}

/** The image edit graph with one picture: the face crop, made neutral (same identity, mouth closed, eyes open, facing the camera). */
export function neutralGraph(template: ApiGraph, image: string, prefix: string, seed: number): ApiGraph {
  const graph = structuredClone(template);
  for (const id of ["11", "12", "13"]) delete graph[id];
  for (const key of ["images.image_2", "images.image_3", "images.image_4"]) delete graph["5"].inputs[key];
  graph["10"].inputs.image = image;
  Object.assign(graph["5"].inputs, {prompt: KEEP_FACE_NEUTRAL_PROMPT});
  Object.assign(graph["1"].inputs, {aspect_ratio: "3:4 (Portrait Standard)", megapixels: 1});
  graph["7"].inputs.noise_seed = seed;
  graph["9"].inputs.filename_prefix = prefix;
  return graph;
}

/** One SAM 3 pass on one frame: a face mask and an eyes mask. */
function samGraph(image: string, prefix: string): ApiGraph {
  const detect = (text: string, id: string): ApiGraph => ({
    [`${id}:text`]: {class_type: "CLIPTextEncode", inputs: {text, clip: ["model", 1]}},
    [`${id}:detect`]: {class_type: "SAM3_Detect", inputs: {model: ["model", 0], image: ["image", 0], conditioning: [`${id}:text`, 0], threshold: 0.35, refine_iterations: 2, individual_masks: false}},
    [`${id}:image`]: {class_type: "MaskToImage", inputs: {mask: [`${id}:detect`, 0]}},
    [`${id}:save`]: {class_type: "SaveImage", inputs: {images: [`${id}:image`, 0], filename_prefix: `${prefix}-${id}`}},
  });
  return {
    image: {class_type: "LoadImage", inputs: {image}},
    model: {class_type: "CheckpointLoaderSimple", inputs: {ckpt_name: "sam3.1_multiplex_fp16.safetensors"}},
    ...detect("face", "face"), ...detect("eyes", "eyes"),
  };
}

async function probe(file: string) {
  const {stdout} = await run(ffprobe(), ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,nb_read_frames", "-of", "json", file], {timeout: 120_000, windowsHide: true});
  const streams = (JSON.parse(stdout).streams ?? []) as Array<{codec_type: string; width?: number; height?: number; nb_read_frames?: string}>;
  const video = streams.find(stream => stream.codec_type === "video");
  if (!video?.width || !video.height || !Number(video.nb_read_frames)) throw new HttpError(422, "The video could not be read.");
  return {width: video.width, height: video.height, frames: Number(video.nb_read_frames), audio: streams.some(stream => stream.codec_type === "audio")};
}

const frameAt = async (file: string, index: number) => (await run(ffmpeg(), ["-v", "error", "-nostdin", "-i", file, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], {encoding: "buffer", timeout: 60_000, maxBuffer: 64 << 20, windowsHide: true})).stdout as Buffer;

/** Whether a finished run asks for Keep face: its manifest has the switch and it is on (on by default). */
export function wantsKeepFace(manifest: Pick<CapabilityBundle["manifest"], "controls">, controls: Record<string, unknown> | undefined): boolean {
  const control = manifest.controls.find(entry => entry.id === "keep_face" && entry.type === "boolean");
  return !!control && (controls?.keep_face ?? control.default) === true;
}

export type KeepFaceRun = {id: string; workspace_id: string; project_id: string; worker_id: string; created_by: string; scene?: number | null; shot?: number | null};
export type KeepFaceOutcome = {runId: string; frame: number} | {skipped: string};

/** Median height of the faces SAM 3 found (0 when none). */
export function medianFaceHeight(candidates: readonly FaceCandidate[]): number {
  const heights = candidates.filter(candidate => candidate.box).map(candidate => candidate.box![3] - candidate.box![1]).sort((a, b) => a - b);
  return heights.length ? heights[Math.floor(heights.length / 2)] : 0;
}

/** SAM 3 face and eyes masks on the given frames; keeps each frame picture in `pictures` when given. */
async function detectFaces(comfy: ComfyAnalysisClient, videoFile: string, facts: {width: number; height: number}, frames: number[], runId: string, pictures?: Map<number, Buffer>): Promise<FaceCandidate[]> {
  const prompts: string[] = [];
  for (const index of frames) {
    const png = await frameAt(videoFile, index); pictures?.set(index, png);
    const name = await comfy.upload(`keep-face-${runId}-${index}.png`, png, "image/png");
    prompts.push(await comfy.submit(samGraph(name, `keep-face/${runId}-${index}`)));
  }
  const done = await comfy.waitAll(prompts, {timeoutMs: 10 * 60_000});
  const candidates: FaceCandidate[] = [];
  for (const [position, execution] of done.entries()) {
    const faceFile = execution.outputs["face:save"]?.[0], eyesFile = execution.outputs["eyes:save"]?.[0];
    if (execution.status !== "completed" || !faceFile || !eyesFile) continue;
    const face = await maskStats(await comfy.download(faceFile), facts.width, facts.height);
    const eyes = await maskStats(await comfy.download(eyesFile), facts.width, facts.height);
    candidates.push({frame: frames[position], faceArea: face.area, box: face.box, eyes: eyes.parts});
  }
  return candidates;
}

/** Queue the face pass on a finished video run. Called by the executor when the run's Keep face switch is on. */
export async function queueKeepFace(deps: {pool: Pool; store: DiskStore; catalogue: CapabilityBundle[]}, run: KeepFaceRun, videoAssetId: string): Promise<KeepFaceOutcome> {
  const {pool, store, catalogue} = deps, workspaceId = run.workspace_id;
  const pack = catalogue.find(bundle => bundle.manifest.id === KEEP_FACE_CAPABILITY);
  if (!pack) return {skipped: "the HyperFlow area workflow is not in this app"};
  const worker = (await pool.query("SELECT origin,kind FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled", [workspaceId, run.worker_id])).rows[0] as {origin: string; kind: string} | undefined;
  if (worker?.kind !== "local") return {skipped: "Keep face runs on a ComfyUI on this computer"};
  const video = (await pool.query("SELECT id,name,media_type,storage_key FROM assets WHERE workspace_id=$1 AND id=$2", [workspaceId, videoAssetId])).rows[0] as
    {id: string; name: string; media_type: string; storage_key: string} | undefined;
  if (!video || video.media_type !== "video") return {skipped: "the run made no video"};
  const key = `keep-face:${run.id}`;
  const prior = (await pool.query("SELECT id FROM runs WHERE workspace_id=$1 AND idempotency_key=$2", [workspaceId, key])).rows[0] as {id: string} | undefined;
  if (prior) return {runId: prior.id, frame: -1};

  const videoFile = await store.file(workspaceId, video.storage_key), facts = await probe(videoFile);
  const comfy = new ComfyAnalysisClient({origin: worker.origin});
  const pictures = new Map<number, Buffer>();
  const candidates = await detectFaces(comfy, videoFile, facts, candidateFrames(facts.frames), run.id, pictures);
  /* A face that is small in the frame goes the far-face way: crop, render big, paste back. Decided on the median
     face, not the largest: a head turned away reads as a big "face" (all hair) in SAM 3. */
  if (KEEP_FACE_FAR_PATH && fadeWeight(medianFaceHeight(candidates), facts.height) > 0.01 && candidates.some(candidate => candidate.box)) return await queueFarFace(deps, run, pack, comfy, video, videoFile, facts, key);
  const best = pickFaceFrame(candidates);
  if (!best?.box) return {skipped: `no face of at least ${MIN_FACE_HEIGHT} px was found`};
  const crop = referenceCrop(best.box, facts.width, facts.height);
  const crop_ = await sharp(pictures.get(best.frame)!).extract(crop).png().toBuffer();
  /* A neutral identity portrait, so the frame's smile or closed eyes do not spread over the clip. Falls back to the crop. */
  let reference = crop_, neutral = false;
  const editor = catalogue.find(bundle => bundle.manifest.id === KEEP_FACE_NEUTRALISER)?.template;
  if (editor) {
    try {
      const name = await comfy.upload(`keep-face-${run.id}-reference.png`, crop_, "image/png");
      const [made] = await comfy.waitAll([await comfy.submit(neutralGraph(editor, name, `keep-face/${run.id}-neutral`, 1117))], {timeoutMs: 5 * 60_000});
      const file = made.status === "completed" ? made.outputs["9"]?.[0] : undefined;
      if (file) { reference = await comfy.download(file); neutral = true; }
    } catch (error) { console.warn(`[keep-face] ${run.id}: the reference stays the frame crop: ${(error as Error).message}`); }
  }

  /* The H3 chain reads sound from the source; a silent clip gets silence a little longer than its picture. */
  const dir = await mkdtemp(path.join(os.tmpdir(), "keep-face-")), created: string[] = [];
  try {
    let sourceVideoId = video.id;
    const assets: Array<{id: string; name: string; type: "image" | "video"; content: string; file: string | Buffer; metadata: unknown}> = [];
    /* The H3 chain refuses sound that does not outlast the picture ("audio window 0:73 exceeds 0:71" on a clip whose
       sound and picture were both 3.04 s,): the sound is padded with a quarter second of silence; a silent
       clip gets silence. */
    {
      const padded = path.join(dir, "with-sound.mp4");
      const tail = ["-vf", `tpad=stop_mode=clone:stop=${SOURCE_TAIL_FRAMES}`, "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p"];
      const seconds = String((facts.frames + SOURCE_TAIL_FRAMES) / FPS + 0.25);
      await run_(facts.audio
        ? ["-v", "error", "-y", "-i", videoFile, "-map", "0:v", "-map", "0:a:0", ...tail, "-af", "apad", "-t", seconds, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", padded]
        : ["-v", "error", "-y", "-i", videoFile, "-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", ...tail, "-c:a", "aac", "-movflags", "+faststart", padded]);
      sourceVideoId = newId();
      assets.push({id: sourceVideoId, name: `${path.parse(video.name).name} · ${facts.audio ? "sound padded" : "with silent sound"}.mp4`, type: "video", content: "video/mp4", file: padded, metadata: {keepFace: {runId: run.id, role: "source"}}});
    }
    const referenceId = newId();
    assets.push({id: referenceId, name: `${path.parse(video.name).name} · face reference.png`, type: "image", content: "image/png", file: reference, metadata: {keepFace: {runId: run.id, role: "reference", frame: best.frame, crop, neutral}}});
    return await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceId + key]);
      const again = (await client.query("SELECT id FROM runs WHERE workspace_id=$1 AND idempotency_key=$2", [workspaceId, key])).rows[0] as {id: string} | undefined;
      if (again) return {runId: again.id, frame: best.frame};
      for (const asset of assets) {
        const saved = await store.put(workspaceId, typeof asset.file === "string" ? createReadStream(asset.file) : Readable.from(asset.file), asset.id);
        created.push(saved.key);
        await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [asset.id, workspaceId, run.project_id, asset.name, asset.type, asset.content, saved.key, saved.sha256, saved.bytes, run.created_by, video.id, JSON.stringify(asset.metadata)]);
      }
      const body = {projectId: run.project_id, workerId: run.worker_id, idempotencyKey: key, capabilityId: KEEP_FACE_CAPABILITY, version: pack.manifest.version, routeId: "local",
        inputs: {source_video: sourceVideoId, character_image: referenceId}, controls: keepFaceControls(facts.frames, 202), audioPolicy: "preserve" as const};
      const prepared = await prepareInvocation(client, catalogue, workspaceId, body, store);
      const queued = await enqueuePreparedRun(client, workspaceId, run.created_by, prepared, key, hashToken(canonical(body)), {scene: run.scene ?? 1, shot: run.shot ?? 1});
      return {runId: queued.id as string, frame: best.frame};
    });
  } catch (error) {
    for (const file of created) await store.remove(workspaceId, file).catch(() => {});
    throw error;
  } finally {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
}

const run_ = (args: string[]) => run(ffmpeg(), args, {timeout: 5 * 60_000, windowsHide: true}).catch(() => { throw new Error("The video could not be prepared for Keep face. Check that FFmpeg is installed."); });

/** Picture roles of the finished run that can give a far face its identity, best first. */
const IDENTITY_ROLES = ["character_image", "first_frame", "source_image", "reference_image", "image"];

/** The far-face pass (face-crop.ts): SAM 3 tracks the face on every TRACK_STRIDE-th frame, the planned square is cut
 *  out at 768 px and rendered with the area graph, and the executor pastes the render back (invocation.faceCrop).
 *  The identity comes from the run's own input picture when it has one; a far face in the clip is too small for it. */
async function queueFarFace(deps: {pool: Pool; store: DiskStore; catalogue: CapabilityBundle[]}, run: KeepFaceRun, pack: CapabilityBundle, comfy: ComfyAnalysisClient,
  video: {id: string; name: string}, videoFile: string, facts: {width: number; height: number; frames: number; audio: boolean}, key: string): Promise<KeepFaceOutcome> {
  const {pool, store, catalogue} = deps, workspaceId = run.workspace_id;
  const pictures = new Map<number, Buffer>();
  const tracked = await detectFaces(comfy, videoFile, facts, trackFrames(facts.frames), `${run.id}-track`, pictures);
  const plan = planFaceCrop(tracked.map(sample => ({frame: sample.frame, box: sample.box})), facts.width, facts.height, facts.frames);
  if (!plan) return {skipped: "no face was found to track"};
  if (!planFixesSomething(plan)) return {skipped: "the face is close enough; H3 keeps it as made"};

  const identity = (await pool.query("SELECT i.role,a.id FROM run_inputs i JOIN assets a ON a.id=i.asset_id AND a.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND i.run_id=$2 AND a.media_type='image'", [workspaceId, run.id])).rows as Array<{role: string; id: string}>;
  const own = identity.sort((a, b) => (IDENTITY_ROLES.indexOf(a.role) + 99) % 99 - (IDENTITY_ROLES.indexOf(b.role) + 99) % 99)[0]?.id;
  const largest = tracked.filter(sample => sample.box).sort((a, b) => (b.box![3] - b.box![1]) - (a.box![3] - a.box![1]))[0];

  const dir = await mkdtemp(path.join(os.tmpdir(), "far-face-")), created: string[] = [];
  try {
    let source = videoFile;
    if (!facts.audio) {
      source = path.join(dir, "with-sound.mp4");
      await run_(["-v", "error", "-y", "-i", videoFile, "-f", "lavfi", "-t", String(facts.frames / FPS + 0.25), "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", source]);
    }
    const cropFile = path.join(dir, "face-crop.mp4");
    await writeCropClip(source, plan, FPS, cropFile, SOURCE_TAIL_FRAMES);
    const assets: Array<{id: string; name: string; type: "image" | "video"; content: string; file: string | Buffer; metadata: unknown}> = [];
    const cropId = newId();
    assets.push({id: cropId, name: `${path.parse(video.name).name} · face crop.mp4`, type: "video", content: "video/mp4", file: cropFile, metadata: {keepFace: {runId: run.id, role: "face-crop", side: plan.side}}});
    let referenceId = own;
    if (!referenceId && largest?.box) {
      const crop = referenceCrop(largest.box, facts.width, facts.height);
      const picture = await sharp(pictures.get(largest.frame)!).extract(crop).resize({height: 512, kernel: "lanczos3"}).png().toBuffer();
      referenceId = newId();
      assets.push({id: referenceId, name: `${path.parse(video.name).name} · face reference.png`, type: "image", content: "image/png", file: picture, metadata: {keepFace: {runId: run.id, role: "reference", frame: largest.frame, crop}}});
    }
    if (!referenceId) return {skipped: "no picture to take the face from"};
    return await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceId + key]);
      const again = (await client.query("SELECT id FROM runs WHERE workspace_id=$1 AND idempotency_key=$2", [workspaceId, key])).rows[0] as {id: string} | undefined;
      if (again) return {runId: again.id, frame: -1};
      for (const asset of assets) {
        const saved = await store.put(workspaceId, typeof asset.file === "string" ? createReadStream(asset.file) : Readable.from(asset.file), asset.id);
        created.push(saved.key);
        await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [asset.id, workspaceId, run.project_id, asset.name, asset.type, asset.content, saved.key, saved.sha256, saved.bytes, run.created_by, video.id, JSON.stringify(asset.metadata)]);
      }
      const body = {projectId: run.project_id, workerId: run.worker_id, idempotencyKey: key, capabilityId: KEEP_FACE_CAPABILITY, version: pack.manifest.version, routeId: "local",
        inputs: {source_video: cropId, character_image: referenceId}, controls: keepFaceControls(facts.frames, 202), audioPolicy: "preserve" as const};
      const prepared = await prepareInvocation(client, catalogue, workspaceId, body, store);
      (prepared.invocation as Record<string, unknown>).faceCrop = {...plan, sourceAssetId: video.id};
      const queued = await enqueuePreparedRun(client, workspaceId, run.created_by, prepared, key, hashToken(canonical(body)), {scene: run.scene ?? 1, shot: run.shot ?? 1});
      return {runId: queued.id as string, frame: largest?.frame ?? 0};
    });
  } catch (error) {
    for (const file of created) await store.remove(workspaceId, file).catch(() => {});
    throw error;
  } finally {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
}

/** Frames SAM 3 tracks the face on: every TRACK_STRIDE-th frame and the last one. */
export function trackFrames(frameCount: number): number[] {
  const frames = Array.from({length: Math.ceil(frameCount / TRACK_STRIDE)}, (_, index) => index * TRACK_STRIDE);
  if (frames.at(-1) !== frameCount - 1) frames.push(frameCount - 1);
  return frames;
}
