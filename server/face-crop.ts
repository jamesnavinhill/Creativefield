/* Far-face fix (ported from PixelAI Labs H3 FaceFix, MIT, onto SAM 3 and HyperFlow flash;).
   H3 smudges faces that are small in the frame. Keep face then crops a square around the tracked face,
   scales it to 768 px so the face is big for the model, renders only the face again with the area-only
   HyperFlow graph, and pastes it back. A size fade gives small faces the full fix and leaves close faces
   as H3 made them.

   States of one far-face pass (the run's invocation.faceCrop carries the plan):
     tracked  -> SAM 3 boxes on sampled frames, interpolated to every frame
     planned  -> one crop side for the clip, a smoothed centre and a fade weight per frame
     skipped  -> no face found, or every weight is 0 (faces are close: the whole-frame pass applies)
     queued   -> the crop clip is an asset; the area run renders it
     stitched -> the render is pasted back on the source; the run publishes the stitched clip
     kept     -> stitching failed: the run publishes the crop render as made (never a broken clip) */
import {execFile, spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const ffmpeg = () => process.env.FFMPEG_PATH ?? "ffmpeg";

/** Side of the square the face is rendered at (the area graph renders it at 736p). */
export const CROP_RENDER_SIDE = 768;
/* SAM 3 "face" boxes take in hair and forehead: about twice the height of the YOLO face box FaceFix measures
   (a 55 px face measured 120 px in the first real run). So FaceFix's crop factor 2.5 becomes 1.6 here, and its
   fade from 110 to 180 px becomes 220 to 360 px of SAM 3 box at 1080p. */
/** Crop side as a multiple of the SAM 3 face box height. */
export const CROP_FACTOR = 1.6;
/** SAM 3 face box heights at 1080p: full fix at or under the first, none from the second. */
export const FULL_FIX_PX = 220, NO_FIX_PX = 360;
/** Every n-th frame goes to SAM 3; the rest are interpolated. */
export const TRACK_STRIDE = 6;
/** Frames on each side the crop centre and face height are averaged over (no jitter in the crop). */
const SMOOTH = 6;

export type Box = [number, number, number, number];
export type FaceCropPlan = {
  contract: "face_crop_v1";
  width: number; height: number; frames: number;
  side: number;                 // crop side in source pixels (square)
  x: number[]; y: number[];     // top-left of the crop, per frame
  weight: number[];             // paste strength per frame, 0..1
  faceHeight: number[];         // face height per frame, source pixels
};

const smoothstep = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };

/** Fix strength for a face this tall in a clip this tall: 1 for far faces, 0 for close ones. */
export function fadeWeight(faceHeight: number, clipHeight: number): number {
  const scale = clipHeight / 1080, low = FULL_FIX_PX * scale, high = Math.max(low + 1, NO_FIX_PX * scale);
  return 1 - smoothstep((faceHeight - low) / (high - low));
}

/** A box for every frame from boxes on some frames: linear between samples, held before the first and after the last. */
export function interpolateBoxes(samples: ReadonlyArray<{frame: number; box?: Box}>, frames: number): Array<Box | undefined> {
  const known = samples.filter(sample => sample.box).sort((a, b) => a.frame - b.frame) as Array<{frame: number; box: Box}>;
  if (!known.length) return Array.from({length: frames}, () => undefined);
  return Array.from({length: frames}, (_, frame) => {
    const after = known.findIndex(sample => sample.frame >= frame);
    if (after === 0) return [...known[0].box] as Box;
    if (after === -1) return [...known.at(-1)!.box] as Box;
    const a = known[after - 1], b = known[after], t = (frame - a.frame) / (b.frame - a.frame);
    return a.box.map((value, index) => value + (b.box[index] - value) * t) as Box;
  });
}

const average = (values: number[], at: number, radius: number) => {
  let sum = 0, count = 0;
  for (let i = Math.max(0, at - radius); i <= Math.min(values.length - 1, at + radius); i++) { sum += values[i]; count++; }
  return sum / count;
};

/** The crop for a clip: one square side (FaceFix's crop factor on the median face), a smoothed centre per frame,
 *  kept inside the frame, and the fade weight per frame. Undefined when no face was found. */
export function planFaceCrop(samples: ReadonlyArray<{frame: number; box?: Box}>, width: number, height: number, frames: number): FaceCropPlan | undefined {
  const boxes = interpolateBoxes(samples, frames);
  if (!boxes[0]) return undefined;
  const all = boxes as Box[];
  const cx = all.map(box => (box[0] + box[2]) / 2), cy = all.map(box => (box[1] + box[3]) / 2), fh = all.map(box => box[3] - box[1]);
  const sorted = [...fh].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  const side = Math.round(Math.min(width, height, Math.max(64, median * CROP_FACTOR)) / 2) * 2;
  /* Frames where SAM 3 saw no face nearby (she turned away: only hair) get no paste; the strength ramps
     back in over a few frames so a lost face does not pop. */
  const found = samples.filter(sample => sample.box).map(sample => sample.frame);
  const seen = Array.from({length: frames}, (_, frame) => {
    const gap = Math.min(...found.map(at => Math.abs(at - frame)));
    return gap <= TRACK_STRIDE ? 1 : gap >= 2 * TRACK_STRIDE ? 0 : smoothstep((2 * TRACK_STRIDE - gap) / TRACK_STRIDE);
  });
  const x: number[] = [], y: number[] = [], weight: number[] = [], faceHeight: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const centreX = average(cx, frame, SMOOTH), centreY = average(cy, frame, SMOOTH), face = average(fh, frame, SMOOTH);
    x.push(Math.round(Math.max(0, Math.min(width - side, centreX - side / 2))));
    y.push(Math.round(Math.max(0, Math.min(height - side, centreY - side / 2))));
    faceHeight.push(Math.round(face));
    weight.push(Math.round(fadeWeight(face, height) * 1000) / 1000 * seen[frame]);
  }
  return {contract: "face_crop_v1", width, height, frames, side, x, y, weight, faceHeight};
}

/** Whether the plan changes anything: some frame has a far face. */
export const planFixesSomething = (plan: FaceCropPlan) => plan.weight.some(value => value > 0.01);

/** The paste mask for one crop: a soft ellipse around the face (the crop is 2.5 face heights, the face sits in the
 *  middle), so the edge of the square never shows and the background around the face stays the source's. */
export function pasteMask(side: number): Float32Array {
  const mask = new Float32Array(side * side), c = (side - 1) / 2, rx = side * 0.3, ry = side * 0.36, feather = 0.28;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const d = Math.hypot((x - c) / rx, (y - c) / ry);
    mask[y * side + x] = d <= 1 - feather ? 1 : d >= 1 ? 0 : smoothstep((1 - d) / feather);
  }
  return mask;
}

/** Raw RGB frames of a video, one Buffer per frame (the clip is at most 15 s). */
async function readFrames(file: string, width: number, height: number, scale?: number): Promise<Buffer[]> {
  const args = ["-v", "error", "-nostdin", "-i", file, ...(scale ? ["-vf", `scale=${scale}:${scale}:flags=lanczos`] : []), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
  const {stdout} = await run(ffmpeg(), args, {encoding: "buffer", maxBuffer: 2 ** 31 - 1, timeout: 10 * 60_000, windowsHide: true});
  const size = (scale ?? width) * (scale ?? height) * 3, frames: Buffer[] = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

/** Encode raw RGB frames to H.264, taking every sound track from `audioFrom` when given. */
async function writeFrames(frames: Buffer[], width: number, height: number, fps: number, out: string, audioFrom?: string, padAudio = false): Promise<void> {
  // The H3 chain needs sound that outlasts the picture: a quarter second of padding.
  const seconds = (frames.length / fps + 0.25).toFixed(6);
  const audio = !audioFrom ? [] : padAudio
    ? ["-i", audioFrom, "-map", "0:v", "-map", "1:a:0?", "-af", "apad", "-t", seconds, "-c:a", "aac", "-b:a", "192k"]
    : ["-i", audioFrom, "-map", "0:v", "-map", "1:a?", "-c:a", "copy", "-map_metadata:s:a", "1:s:a"];
  const args = ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    ...audio,
    "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg(), args, {windowsHide: true, stdio: ["pipe", "ignore", "pipe"]});
    let error = "";
    (child.stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${error.slice(0, 300)}`)));
    (async () => { for (const frame of frames) if (!child.stdin.write(frame)) await new Promise(r => child.stdin.once("drain", r)); child.stdin.end(); })().catch(reject);
  });
}

/** The crop clip the area graph renders: the planned square of every frame at 768 px, with the source's sound. */
export async function writeCropClip(source: string, plan: FaceCropPlan, fps: number, out: string, tailFrames = 0): Promise<void> {
  const frames = await readFrames(source, plan.width, plan.height);
  const crops: Buffer[] = [];
  for (let i = 0; i < Math.min(frames.length, plan.frames); i++) {
    crops.push(await sharp(frames[i], {raw: {width: plan.width, height: plan.height, channels: 3}})
      .extract({left: plan.x[i], top: plan.y[i], width: plan.side, height: plan.side})
      .resize(CROP_RENDER_SIDE, CROP_RENDER_SIDE, {kernel: "lanczos3"}).raw().toBuffer());
  }
  for (let i = 0; i < tailFrames && crops.length; i++) crops.push(crops.at(-1)!);
  await writeFrames(crops, CROP_RENDER_SIDE, CROP_RENDER_SIDE, fps, out, source, true);
}

/** Paste the rendered crop back onto the source with the soft mask and each frame's weight; keeps the source's sound.
 *  Hands the stitched file to `use`. Frames past the render's end stay the source's. */
export async function withStitchedFace<T>(source: string, rendered: string, plan: FaceCropPlan, fps: number, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "face-stitch-"));
  try {
    const frames = await readFrames(source, plan.width, plan.height), faces = await readFrames(rendered, 0, 0, plan.side);
    const mask = pasteMask(plan.side), w = plan.width;
    for (let i = 0; i < Math.min(frames.length, faces.length, plan.frames); i++) {
      const strength = plan.weight[i];
      if (strength <= 0.001) continue;
      const frame = frames[i], face = faces[i], x0 = plan.x[i], y0 = plan.y[i];
      for (let y = 0; y < plan.side; y++) {
        const row = (y0 + y) * w;
        for (let x = 0; x < plan.side; x++) {
          const a = mask[y * plan.side + x] * strength;
          if (a <= 0) continue;
          const d = (row + x0 + x) * 3, s = (y * plan.side + x) * 3;
          frame[d] = Math.round(frame[d] + (face[s] - frame[d]) * a);
          frame[d + 1] = Math.round(frame[d + 1] + (face[s + 1] - frame[d + 1]) * a);
          frame[d + 2] = Math.round(frame[d + 2] + (face[s + 2] - frame[d + 2]) * a);
        }
      }
    }
    const out = path.join(dir, "stitched.mp4");
    await writeFrames(frames, plan.width, plan.height, fps, out, source);
    return await use(out);
  } finally {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
}
