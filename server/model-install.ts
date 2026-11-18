/* One-click install of what a tool is missing on this computer's ComfyUI: model files and custom node packs.
   Sources come from native-workflows/model-sources.json (built by scripts/model-sources.mjs from the publishers'
   Hugging Face repositories). Files land in the folders ComfyUI itself reports (/internal/folder_paths).

   States (Pad, Current state: models-workers, "Install"):
     idle -> installing -> done | restart (new custom nodes need a ComfyUI restart) | failed | stopped
     restart -> restarting -> done (ComfyUI answers again) | failed
   Each file: queued -> working -> done | failed. Self-healing: a download resumes from its .part file, network
   errors retry four times with growing pauses, every file is checked against its SHA-256 before it is used, and a
   file that already exists is never downloaded again. Disk space is checked before anything starts.
   Only the local single-user app, from this computer, for a ComfyUI on this computer. */
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {createReadStream, createWriteStream, existsSync, readFileSync} from "node:fs";
import {mkdir, rename, stat, statfs, truncate} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import type {FastifyInstance, FastifyRequest} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import type {ServerConfig} from "./config";
import {capabilityReadiness} from "../src/capabilities/readiness";
import type {CapabilityBundle, WorkerInventory} from "../src/capabilities/types";

const run = promisify(execFile);
type Sources = {models: Record<string, {url: string; bytes: number; sha256?: string}>; nodes: Record<string, {repo: string; with?: string[]}>};
const sources: Sources = (() => {
  try {
    const loaded = JSON.parse(readFileSync(path.resolve("native-workflows", "model-sources.json"), "utf8")) as Sources;
    /* Only HTTPS downloads from Hugging Face; anything else in the file is ignored. */
    loaded.models = Object.fromEntries(Object.entries(loaded.models ?? {}).filter(([, source]) => { try { const url = new URL(source.url); return url.protocol === "https:" && url.hostname === "huggingface.co"; } catch { return false; } }));
    return loaded;
  }
  catch { return {models: {}, nodes: {}}; }
})();

/** Folders a node pack registers only once it is installed; until then the files go where that pack looks too. */
const FOLDER_FALLBACK: Record<string, string> = {unet_gguf: "diffusion_models", unet: "diffusion_models", clip_gguf: "text_encoders", clip: "text_encoders"};

export type InstallItem = {kind: "model" | "node"; name: string; bytes: number; done: number; state: "queued" | "working" | "done" | "failed"; error?: string;
  url?: string; sha256?: string; repo?: string; location?: string};
export type InstallJob = {capabilityId: string; workerId: string; title: string;
  state: "installing" | "restart" | "restarting" | "done" | "failed" | "stopped"; items: InstallItem[]; error?: string};
export type InstallPlan = {items: InstallItem[]; bytes: number; manual: string[]};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** What the tool still needs on this worker, split into what can be installed and what stays manual. */
export function installPlan(bundle: CapabilityBundle, inventory: WorkerInventory): InstallPlan {
  const routeId = bundle.manifest.routes.find(route => route.execution === "local_comfy")?.id ?? "local";
  const missing = capabilityReadiness(bundle.manifest, routeId, inventory).missing ?? [];
  const items: InstallItem[] = [], manual: string[] = [], repos = new Set<string>();
  for (const need of missing) {
    if (need.kind === "model") {
      const source = sources.models[need.name];
      if (source) items.push({kind: "model", name: need.name, bytes: source.bytes, done: 0, state: "queued", url: source.url, sha256: source.sha256, location: need.location});
      else manual.push(need.name);
    } else if (need.kind === "node") {
      const source = sources.nodes[need.name];
      if (source) for (const repo of [...(source.with ?? []), source.repo]) repos.add(repo);
      else manual.push(need.name);
    }
  }
  /* Node packs first, in the order their dependencies need (a pack's helpers before the pack), then the files. */
  const nodeItems: InstallItem[] = [...repos].map(repo => ({kind: "node", name: repo.split("/").pop() ?? repo, bytes: 0, done: 0, state: "queued", repo}));
  const all = [...nodeItems, ...items];
  return {items: all, bytes: all.reduce((sum, item) => sum + item.bytes, 0), manual};
}

/** ComfyUI's own folder list, and the ComfyUI folder that holds custom_nodes. */
export async function comfyFolders(origin: string) {
  const response = await fetch(`${origin}/internal/folder_paths`, {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error("ComfyUI did not list its folders. Update ComfyUI, then try again.");
  const folders = await response.json() as Record<string, string[] | [string[], unknown]>;
  const first = (key: string) => { const value = folders[key]; const list = Array.isArray(value?.[0]) ? value[0] as string[] : value as string[] | undefined; return list?.[0]; };
  const customNodes = first("custom_nodes");
  return {first, customNodes, base: customNodes ? path.dirname(customNodes) : undefined};
}

/** The Python that runs this ComfyUI: portable (python_embeded beside it), Desktop or manual (.venv / venv). */
export function comfyPython(base: string) {
  return [path.join(base, "..", "python_embeded", "python.exe"), path.join(base, ".venv", "Scripts", "python.exe"), path.join(base, "venv", "Scripts", "python.exe"), path.join(base, ".venv", "bin", "python")]
    .find(candidate => existsSync(candidate));
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

async function sha256Of(file: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, {highWaterMark: 1 << 22})) { if (signal.aborted) throw new Error("stopped"); hash.update(chunk as Buffer); }
  return hash.digest("hex");
}

/** Downloads one file into `dest`, resuming a .part file; checked against its SHA-256 before it is renamed. */
export async function download(item: InstallItem, dest: string, signal: AbortSignal) {
  if (existsSync(dest)) { item.done = item.bytes; return; }
  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), {recursive: true});
  for (let attempt = 0; ; attempt++) {
    let have = existsSync(part) ? (await stat(part)).size : 0;
    if (have > item.bytes) { await truncate(part, 0); have = 0; }
    item.done = have;
    try {
      if (have < item.bytes) {
        const headers: Record<string, string> = {"user-agent": "CreativeField"};
        if (have) headers.range = `bytes=${have}-`;
        /* The token goes only to Hugging Face itself over HTTPS; fetch drops it on a redirect to another host. */
        const source = new URL(item.url!);
        if (process.env.HF_TOKEN && source.protocol === "https:" && source.hostname === "huggingface.co") headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
        const response = await fetch(item.url!, {headers, signal, redirect: "follow"});
        if (response.status === 401 || response.status === 403) throw Object.assign(new Error("This model needs a Hugging Face sign-in. Set HF_TOKEN, then try again."), {final: true});
        if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}.`);
        if (have && response.status !== 206) { have = 0; item.done = 0; }
        const out = createWriteStream(part, {flags: have ? "a" : "w"});
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            if (!out.write(chunk)) await new Promise(resolve => out.once("drain", resolve));
            item.done += chunk.byteLength;
          }
        } finally { await new Promise(resolve => out.end(resolve)); }
      }
      if (item.sha256 && await sha256Of(part, signal) !== item.sha256) {
        await truncate(part, 0);
        throw new Error("The downloaded file did not match its checksum, so it was discarded.");
      }
      await rename(part, dest);
      item.done = item.bytes;
      return;
    } catch (error) {
      const err = error as Error & {final?: boolean; code?: string};
      if (signal.aborted) throw new Error("stopped");
      if (err.code === "ENOSPC") throw new Error("The disk is full. Free some space, then try again; the download continues where it stopped.");
      if (err.final || attempt >= 3) throw err;
      await pause(3000 * 2 ** attempt);
    }
  }
}

/** Clones a node pack into custom_nodes and installs its Python requirements with ComfyUI's own Python. */
export async function installNodePack(item: InstallItem, customNodes: string, python: string | undefined) {
  const dir = path.join(customNodes, item.name);
  if (!existsSync(dir)) {
    try { await run("git", ["clone", "--depth", "1", item.repo!, dir], {timeout: 10 * 60_000}); }
    catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "Git is not installed. Install Git for Windows, then try again." : `Could not download ${item.name}.`); }
  }
  const requirements = path.join(dir, "requirements.txt");
  if (existsSync(requirements)) {
    if (!python) throw new Error(`Could not find ComfyUI's Python to install what ${item.name} needs.`);
    await run(python, ["-s", "-m", "pip", "install", "-r", requirements], {timeout: 20 * 60_000, maxBuffer: 1 << 26});
  }
}

/** Restarts ComfyUI with exactly the command line it runs with now, so the person's own start options stay. */
export async function restartComfy(origin: string, base: string) {
  if (process.platform !== "win32") throw new Error("Restart ComfyUI yourself to load the new nodes.");
  const port = new URL(origin).port || "80";
  const script = `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction Stop | Select-Object -First 1;
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)";
if (-not $p.CommandLine -or $p.CommandLine -notmatch 'main\\.py') { throw 'not-comfy' }
$dir = Split-Path -Parent $p.ExecutablePath; $cmd = $p.CommandLine; $cwd = $env:COMFY_CWD;
Stop-Process -Id $p.ProcessId -Force; Start-Sleep -Seconds 2;
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('start "ComfyUI" ' + $cmd) -WorkingDirectory $cwd`;
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {env: {...process.env, COMFY_CWD: path.dirname(base)}, timeout: 30_000})
    .catch(() => { throw new Error("CreativeField could not restart ComfyUI. Close its window and start it again to load the new nodes."); });
}

let job: InstallJob | undefined;
let abort: AbortController | undefined;

export async function installRoutes(app: FastifyInstance, pool: Pool, config: ServerConfig, catalogue: CapabilityBundle[]) {
  const base = "/api/v1/workspaces/:workspaceId";
  const params = z.object({workspaceId: z.uuid()});
  const target = z.object({capabilityId: z.string().min(1).max(200), workerId: z.uuid()}).strict();

  /** Only the one person on this computer, for a ComfyUI on this computer. */
  async function guard(request: FastifyRequest, admin = true) {
    const {workspaceId} = params.parse(request.params);
    await member(pool, request, workspaceId, admin ? "admin" : "viewer");
    if (!config.localSingleUser || !LOOPBACK_IPS.has(request.ip)) throw new HttpError(403, "Installing runs only in the app on your own computer.");
    return workspaceId;
  }
  async function workerAndBundle(workspaceId: string, capabilityId: string, workerId: string) {
    const worker = (await pool.query("SELECT id,origin,kind,inventory FROM workers WHERE workspace_id=$1 AND id=$2", [workspaceId, workerId])).rows[0] as {id: string; origin: string; kind: string; inventory: WorkerInventory} | undefined;
    if (!worker || worker.kind === "cloud" || !LOOPBACK_HOSTS.has(new URL(worker.origin).hostname)) throw new HttpError(400, "Install works for ComfyUI on this computer.");
    const bundle = catalogue.find(item => item.manifest.id === capabilityId);
    if (!bundle) throw new HttpError(404, "Unknown tool.");
    return {worker, bundle};
  }

  app.get(`${base}/install/plan`, async request => {
    const workspaceId = await guard(request, false);
    const {capabilityId, workerId} = target.parse(request.query);
    const {worker, bundle} = await workerAndBundle(workspaceId, capabilityId, workerId);
    const plan = installPlan(bundle, worker.inventory ?? {online: false, nodes: [], models: [], credentials: []});
    return {bytes: plan.bytes, files: plan.items.length, manual: plan.manual, items: plan.items.map(({kind, name, bytes}) => ({kind, name, bytes}))};
  });

  app.get(`${base}/install`, async request => { await guard(request, false); return job ?? {state: "idle"}; });

  app.post(`${base}/install/stop`, async request => { await guard(request); abort?.abort(); return job ?? {state: "idle"}; });

  app.post(`${base}/install`, async request => {
    const workspaceId = await guard(request);
    const {capabilityId, workerId} = target.parse(request.body ?? {});
    if (job?.state === "installing" || job?.state === "restarting") throw new HttpError(409, "An install is already running.");
    const {worker, bundle} = await workerAndBundle(workspaceId, capabilityId, workerId);
    const plan = installPlan(bundle, worker.inventory ?? {online: false, nodes: [], models: [], credentials: []});
    if (!plan.items.length) throw new HttpError(409, plan.manual.length ? "What this tool still needs cannot be installed automatically. Models shows the files." : "Nothing is missing.");
    const folders = await comfyFolders(worker.origin).catch(error => { throw new HttpError(409, (error as Error).message); });
    if (!folders.base || !folders.customNodes) throw new HttpError(409, "ComfyUI did not say where its folders are. Update ComfyUI, then try again.");
    /* Room for everything still to download, plus 2 GB to spare. */
    const targets = new Map<InstallItem, string>();
    for (const item of plan.items.filter(entry => entry.kind === "model")) {
      const folder = folders.first(item.location ?? "") ?? folders.first(FOLDER_FALLBACK[item.location ?? ""] ?? "");
      if (!folder || item.name.split(/[\\/]/).includes("..")) throw new HttpError(409, `ComfyUI has no folder for ${item.name}.`);
      targets.set(item, path.join(folder, item.name));
    }
    const firstTarget = [...targets.values()][0];
    if (firstTarget) {
      await mkdir(path.dirname(firstTarget), {recursive: true});
      const disk = await statfs(path.dirname(firstTarget));
      const free = disk.bavail * disk.bsize;
      if (free < plan.bytes + 2e9) throw new HttpError(409, `This needs ${gb(plan.bytes)} and the disk has ${gb(free)} free. Free some space, then try again.`);
    }
    job = {capabilityId, workerId, title: bundle.manifest.title, state: "installing", items: plan.items};
    abort = new AbortController();
    const current = job, signal = abort.signal;
    void (async () => {
      const python = comfyPython(folders.base!);
      let nodesAdded = false;
      for (const item of current.items) {
        if (signal.aborted) break;
        item.state = "working";
        try {
          if (item.kind === "node") { await installNodePack(item, folders.customNodes!, python); nodesAdded = true; }
          else await download(item, targets.get(item)!, signal);
          item.state = "done";
        } catch (error) {
          item.state = "failed"; item.error = (error as Error).message;
          if (signal.aborted) break;
          current.state = "failed"; current.error = item.error;
          return;
        }
      }
      if (signal.aborted) { current.state = "stopped"; return; }
      if (nodesAdded) {
        current.state = "restarting";
        try {
          await restartComfy(worker.origin, folders.base!);
          for (let tries = 0; tries < 60; tries++) {
            await pause(3000);
            if (await fetch(`${worker.origin}/system_stats`, {signal: AbortSignal.timeout(2000)}).then(r => r.ok, () => false)) { current.state = "done"; return; }
          }
          current.state = "restart"; current.error = "ComfyUI did not come back after the restart. Start it again yourself.";
        } catch (error) { current.state = "restart"; current.error = (error as Error).message; }
        return;
      }
      current.state = "done";
    })();
    return job;
  });
}
