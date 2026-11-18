/* Keep text: a finish for a video result made from a start picture. The person marks the lettering on the picture;
   scripts/text-preserve.py tracks the picture's clean lettering onto every frame (Pad DOC-1343,).
   Runs only in the local app: it needs a Python with OpenCV, which ComfyUI's own Python on this computer has.
   The result is a new video asset whose parent is the original; the original stays as it was. */
import {execFile} from "node:child_process";
import {createReadStream, existsSync} from "node:fs";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import type {ServerConfig} from "./config";
import {newId} from "./crypto";
import type {DiskStore} from "./storage";
import {comfyFolders, comfyPython} from "./model-install";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts", "text-preserve.py");
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** A Python that can import OpenCV: CREATIVEFIELD_PYTHON, then the Python of each ComfyUI on this computer. */
let found: string | undefined;
async function opencvPython(pool: Pool, workspaceId: string): Promise<string> {
  if (found) return found;
  const candidates = [process.env.CREATIVEFIELD_PYTHON?.trim()].filter(Boolean) as string[];
  const workers = (await pool.query("SELECT origin FROM workers WHERE workspace_id=$1 AND enabled AND kind='local'", [workspaceId])).rows as Array<{origin: string}>;
  for (const worker of workers) {
    if (!LOOPBACK.test(worker.origin.replace(/\/$/, ""))) continue;
    const folders = await comfyFolders(worker.origin.replace(/\/$/, "")).catch(() => undefined);
    const python = folders?.base ? comfyPython(folders.base) : undefined;
    if (python && !candidates.includes(python)) candidates.push(python);
  }
  for (const python of candidates) {
    if (!existsSync(python)) continue;
    const ok = await run(python, ["-s", "-c", "import cv2,numpy"], {timeout: 60_000}).then(() => true, () => false);
    if (ok) return (found = python);
  }
  throw new HttpError(409, "Keep text needs OpenCV in ComfyUI's Python, and no ComfyUI on this computer has it. Start ComfyUI and try again.");
}

const body = z.object({
  /** Frames around the lettering, as fractions of the start picture (0..1). */
  boxes: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(4),
}).strict();

export async function keepTextRoutes(app: FastifyInstance, pool: Pool, store: DiskStore, config: ServerConfig) {
  app.post("/api/v1/workspaces/:workspaceId/runs/:runId/keep-text", async request => {
    const {workspaceId, runId} = z.object({workspaceId: z.uuid(), runId: z.uuid()}).parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    if (!config.localSingleUser) throw new HttpError(403, "Keep text runs in the app on your own computer.");
    const {boxes} = body.parse(request.body);
    if (boxes.some(([x0, y0, x1, y1]) => x1 <= x0 || y1 <= y0)) throw new HttpError(400, "Each frame needs a size.");
    const runRow = (await pool.query("SELECT state,project_id,output_ids,invocation FROM runs WHERE workspace_id=$1 AND id=$2", [workspaceId, runId])).rows[0] as
      {state: string; project_id: string; output_ids: string[]; invocation?: {inputs?: Record<string, string>}} | undefined;
    if (!runRow || runRow.state !== "succeeded" || !runRow.output_ids?.length) throw new HttpError(409, "Keep text needs a finished video.");
    const pictureId = runRow.invocation?.inputs?.start_image;
    if (!pictureId) throw new HttpError(409, "This video was not made from a start picture, so there is no clean lettering to keep.");
    const assets = (await pool.query("SELECT id,name,media_type,content_type,storage_key FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [workspaceId, [runRow.output_ids[0], pictureId]])).rows as
      Array<{id: string; name: string; media_type: string; content_type: string; storage_key: string}>;
    const video = assets.find(asset => asset.id === runRow.output_ids[0]), picture = assets.find(asset => asset.id === pictureId);
    if (!video || video.media_type !== "video") throw new HttpError(409, "Keep text needs a finished video.");
    if (!picture) throw new HttpError(409, "The start picture of this video is no longer in the project.");
    const python = await opencvPython(pool, workspaceId);
    const dir = await mkdtemp(path.join(os.tmpdir(), "keep-text-"));
    try {
      const raw = path.join(dir, "raw.mp4"), final = path.join(dir, "keep-text.mp4");
      const videoFile = await store.file(workspaceId, video.storage_key), pictureFile = await store.file(workspaceId, picture.storage_key);
      const {stdout} = await run(python, ["-s", SCRIPT, "apply", videoFile, pictureFile, raw, boxes.map(box => box.join(",")).join(";")], {timeout: 15 * 60_000, maxBuffer: 1 << 24})
        .catch(error => { throw new HttpError(500, `Keep text stopped: ${String((error as {stderr?: string}).stderr || (error as Error).message).trim().split("\n").slice(-2).join(" ")}`); });
      const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {boxes?: Array<{skipped?: string}>};
      if (report.boxes?.length && report.boxes.every(box => box.skipped)) throw new HttpError(422, `The lettering could not be followed: ${report.boxes[0].skipped}. Make the frame a little larger around it.`);
      /* Same picture quality as a render, the original sound kept when there is any. */
      await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-i", videoFile, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", final], {timeout: 10 * 60_000})
        .catch(() => { throw new HttpError(500, "The video could not be written. Check that FFmpeg is installed."); });
      const assetId = newId(), saved = await store.put(workspaceId, createReadStream(final), assetId);
      const name = `${path.parse(video.name).name} · text kept.mp4`;
      await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9,$10)",
        [assetId, workspaceId, runRow.project_id, name, saved.key, saved.sha256, saved.bytes, user.id, video.id, {keepText: {runId, pictureId, boxes, report}}]);
      return {assetId, name, report};
    } finally {
      await rm(dir, {recursive: true, force: true}).catch(() => {});
    }
  });
}
