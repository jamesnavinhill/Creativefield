import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {readFile} from "node:fs/promises";
import {HttpError, member} from "./auth";
import type {DiskStore} from "./storage";

const workspaceParams = z.object({workspaceId: z.uuid()});
const projectParams = z.object({workspaceId: z.uuid(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/)});
const noteBody = z.object({
  clip: z.string().trim().min(1).max(200),
  frame: z.number().int().min(0).max(1_000_000),
  text: z.string().trim().min(1).max(4000),
  take: z.string().trim().min(1).max(200).optional(),
}).strict();

const importBody = z.object({
  /** A video asset of this project (the rendered previs clip). */
  assetId: z.uuid(),
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  /** The H3 clip it belongs after on the timeline; without it, the clip goes to the end. */
  afterClip: z.string().trim().min(1).max(200).optional(),
}).strict();

type TimelineItem = {clip?: unknown; start?: unknown; in?: unknown; out?: unknown};
/** The timeline frame right after the first placement of a clip, or undefined (the editor then puts
 *  the new clip at the end). The editor moves later clips to make room. Pure. */
export function frameAfter(project: {timeline?: unknown}, clipId: string | undefined): number | undefined {
  if (!clipId || !Array.isArray(project.timeline)) return undefined;
  const placed = (project.timeline as TimelineItem[])
    .filter(item => item?.clip === clipId && Number.isFinite(Number(item.start)) && Number(item.out) > Number(item.in))
    .sort((left, right) => Number(left.start) - Number(right.start))[0];
  return placed ? Number(placed.start) + Number(placed.out) - Number(placed.in) : undefined;
}

/**
 * Pick the local ComfyUI that actually serves the H3 Editor. Several local workers may be
 * registered; only the one answering /h3take/api/projects is the editor's host.
 */
export async function h3WorkerFor(pool: Pool, workspaceId: string) {
  const rows = (await pool.query(
    "SELECT origin FROM workers WHERE workspace_id=$1 AND enabled=true AND kind='local' ORDER BY name,id",
    [workspaceId],
  )).rows as Array<{origin: string}>;
  for (const row of rows) {
    try {
      const probe = await fetch(`${row.origin.replace(/\/+$/, "")}/h3take/api/projects`, {signal: AbortSignal.timeout(4_000)});
      if (probe.ok) return row.origin.replace(/\/+$/, "");
    } catch { /* not the worker that runs the editor */ }
  }
  throw new HttpError(503, "No local worker with the H3 Editor is available");
}

/**
 * The H3 Editor runs as a ComfyUI custom node and keeps its project and media in ComfyUI's
 * output folder. The browser cannot call it directly from CreativeField (cross-origin), so this
 * bridge exposes only the project read, clip bytes and note write that the analysis panel needs.
 * Every route requires current workspace membership and only talks to a local worker.
 */
export async function h3EditorRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  async function workerFor(workspaceId: string) {
    return h3WorkerFor(pool, workspaceId);
  }

  async function workerJson(origin: string, path: string, init?: RequestInit) {
    const response = await fetch(`${origin}${path}`, {...init, signal: AbortSignal.timeout(20_000)});
    const body = await response.text();
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, body.trim().slice(0, 500) || `H3 Editor answered ${response.status}`);
    try { return JSON.parse(body) as unknown; }
    catch { throw new HttpError(502, "H3 Editor returned an invalid answer"); }
  }

  app.get("/api/v1/workspaces/:workspaceId/h3-editor/project/:name", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    return workerJson(await workerFor(workspaceId), `/h3take/api/project/${encodeURIComponent(name)}`);
  });

  app.get("/api/v1/workspaces/:workspaceId/h3-editor/media", async (request, reply) => {
    const {workspaceId} = workspaceParams.parse(request.params);
    await member(pool, request, workspaceId);
    const query = request.query as {filename?: unknown; subfolder?: unknown};
    const filename = typeof query.filename === "string" ? query.filename : "";
    // The editor writes Windows folders with backslashes for generated takes; ComfyUI reads either.
    const subfolder = typeof query.subfolder === "string" ? query.subfolder.replace(/\\/g, "/") : "";
    if (!filename || filename.includes("/") || filename.includes("\\")) throw new HttpError(400, "Unknown clip");
    /* Only the editor's own project media is readable through this bridge. */
    if (!/^h3take_projects\/[A-Za-z0-9][A-Za-z0-9._-]*(\/|$)/.test(subfolder)) throw new HttpError(403, "Not H3 Editor media");
    const origin = await workerFor(workspaceId);
    const upstream = new URL("/view", origin);
    upstream.searchParams.set("filename", filename);
    upstream.searchParams.set("subfolder", subfolder);
    upstream.searchParams.set("type", "output");
    const response = await fetch(upstream, {signal: AbortSignal.timeout(60_000)});
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, "The clip is not available");
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());
    return reply.header("Cache-Control", "private, max-age=60").type(type).send(bytes);
  });

  app.post("/api/v1/workspaces/:workspaceId/h3-editor/project/:name/notes", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    const body = noteBody.parse(request.body);
    return workerJson(await workerFor(workspaceId), `/h3take/api/project/${encodeURIComponent(name)}/ops`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({ops: [{op: "add_note", fields: body}]}),
    });
  });

  /* Bring a video of this CreativeField project into the H3 project as footage, right after the
     clip it was made from (the Film Studio previs clip). Creator role: it changes the H3 project. */
  app.post("/api/v1/workspaces/:workspaceId/h3-editor/project/:name/import", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId, "creator");
    const body = importBody.parse(request.body);
    const asset = (await pool.query("SELECT storage_key,media_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
      [workspaceId, body.projectId, body.assetId])).rows[0] as {storage_key: string; media_type: string} | undefined;
    if (!asset) throw new HttpError(404, "That clip is not in this project");
    if (asset.media_type !== "video") throw new HttpError(400, "Only a video can become an H3 clip");
    const origin = await workerFor(workspaceId);
    /* The project's Film Studio may not exist yet (a new project, or the first clip sent to it): create it, named
       as the Film Studio opens it, instead of refusing the clip. Only this name is created; nothing else changes. */
    const project = await workerJson(origin, `/h3take/api/project/${encodeURIComponent(name)}`).catch(async error => {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
      await workerJson(origin, "/h3take/api/projects", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})});
      return workerJson(origin, `/h3take/api/project/${encodeURIComponent(name)}`);
    }) as {timeline?: unknown};
    const start = frameAfter(project, body.afterClip);
    const form = new FormData();
    form.append("name", body.name);
    form.append("place", "true");
    if (start !== undefined) form.append("start", String(start));
    form.append("file", new Blob([await readFile(await store.file(workspaceId, asset.storage_key))], {type: "video/mp4"}), "previs.mp4");
    const response = await fetch(`${origin}/h3take/api/project/${encodeURIComponent(name)}/import`, {method: "POST", body: form, signal: AbortSignal.timeout(180_000)});
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, text.trim().slice(0, 500) || `H3 Editor answered ${response.status}`);
    const result = JSON.parse(text) as {clip?: string; item?: string | null; frames?: number};
    return {clip: result.clip, item: result.item ?? null, frames: result.frames ?? 0, start: start ?? null};
  });
}
