import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import path from "node:path";
import {access, mkdir, stat} from "node:fs/promises";
import {constants} from "node:fs";
import {HttpError, member} from "./auth";
import {comfyInstalls, launchInstall, rememberInstall, rememberRunning} from "./comfy-install";
import {storageVolume} from "./setup-storage";
import type {ServerConfig} from "./config";

const params = z.object({workspaceId: z.uuid()});
const body = z.object({
  modelsDirectory: z.string().trim().max(2000).nullable().optional(),
  completed: z.boolean().optional(),
  dismissed: z.boolean().optional(),
}).strict();

const TABLE = "CREATE TABLE IF NOT EXISTS onboarding_settings(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, models_directory text, completed boolean NOT NULL DEFAULT false, dismissed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())";

async function ensureTable(pool: Pool) {
  await pool.query(TABLE);
}

/** Where models should live when the person has not chosen a folder yet: an existing configured root wins,
 *  otherwise a single app-owned folder beside the database and storage. */
function defaultModelsDirectory(config: ServerConfig) {
  if (config.modelRoot) return path.resolve(config.modelRoot);
  const home = process.env.COMFYFIELD_HOME?.trim();
  return path.resolve(home ? home : ".comfyfield", "models");
}

async function folderState(directory: string | null, fallback: string) {
  const effective = directory ?? fallback;
  let exists = false, writable = false;
  try {
    const info = await stat(effective);
    exists = info.isDirectory();
    if (exists) await access(effective, constants.W_OK);
    writable = exists;
  } catch { /* missing or unreadable */ }
  const volume = await storageVolume(exists ? effective : path.dirname(effective));
  return {paths: {effective, exists, writable, freeBytes: volume?.freeBytes ?? null}};
}

/** ComfyUI on this computer at its usual addresses (portable/manual 8188, Desktop 8000), so the first start can
 *  offer "Use this ComfyUI" instead of asking for an address. Only the local single-user app looks. */
const LOCAL_COMFY = ["http://127.0.0.1:8188", "http://127.0.0.1:8000", "http://127.0.0.1:8189", "http://127.0.0.1:8190"];

async function detectLocalComfy(known: string[]) {
  const found = await Promise.all(LOCAL_COMFY.filter(origin => !known.includes(origin)).map(async origin => {
    try {
      const response = await fetch(`${origin}/system_stats`, {signal: AbortSignal.timeout(1500)});
      return response.ok && typeof (await response.json() as {system?: unknown}).system === "object" ? origin : undefined;
    } catch { return undefined; }
  }));
  return found.filter((origin): origin is string => !!origin);
}

export async function onboardingRoutes(app: FastifyInstance, pool: Pool, config: ServerConfig) {
  const base = "/api/v1/workspaces/:workspaceId";
  async function read(workspaceId: string) {
    await ensureTable(pool);
    const row = (await pool.query("SELECT models_directory,completed,dismissed FROM onboarding_settings WHERE workspace_id=$1", [workspaceId])).rows[0] as {models_directory: string | null; completed: boolean; dismissed: boolean} | undefined;
    const fallback = defaultModelsDirectory(config);
    const directory = row?.models_directory ?? null;
    const folder = await folderState(directory, fallback);
    const workers = (await pool.query("SELECT name,origin,enabled,inventory FROM workers WHERE workspace_id=$1 ORDER BY name,id", [workspaceId])).rows as Array<{name: string; origin: string; enabled: boolean; inventory?: {online?: boolean}}>;
    const online = workers.filter(worker => worker.enabled && worker.inventory?.online === true);
    const detected = config.localSingleUser ? await detectLocalComfy(workers.map(worker => worker.origin)) : [];
    /* Installed but not running: the first start can offer to start it. */
    const installs = config.localSingleUser && !online.length && !detected.length ? comfyInstalls().map(install => ({kind: install.kind, home: install.home})) : [];
    return {
      detected,
      installs,
      completed: row?.completed ?? false,
      dismissed: row?.dismissed ?? false,
      modelsDirectory: folder.paths.effective,
      modelsDirectoryChosen: directory,
      folder: folder.paths,
      system: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        comfyWorkers: {total: workers.length, online: online.length, names: online.map(worker => worker.name)},
      },
    };
  }

  app.get(`${base}/onboarding`, async request => {
    const {workspaceId} = params.parse(request.params);
    await member(pool, request, workspaceId);
    return read(workspaceId);
  });

  const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  app.post(`${base}/onboarding/start-comfy`, async request => {
    const {workspaceId} = params.parse(request.params);
    await member(pool, request, workspaceId, "admin");
    if (!config.localSingleUser || !LOOPBACK.has(request.ip)) throw new HttpError(403, "ComfyUI can only be started from the app on this computer.");
    /* The person confirms the exact folder shown in the dialog; it is searched again now (no cache) and started only
       when that same folder is still a ComfyUI install, so a folder planted later is never run unseen. */
    const {home} = z.object({home: z.string().min(3).max(1000)}).strict().parse(request.body ?? {});
    const install = comfyInstalls(true).find(found => path.resolve(found.home).toLowerCase() === path.resolve(home).toLowerCase());
    if (!install) throw new HttpError(409, "That ComfyUI folder was not found again. Check again, then confirm the folder shown.");
    /* Desktop answers on 8000, a portable or manual install on 8188. Confirmed here, so Start works later too. */
    const origin = install.kind === "desktop" ? "http://127.0.0.1:8000" : "http://127.0.0.1:8188";
    try { launchInstall(install, origin); } catch (error) { throw new HttpError(409, (error as Error).message); }
    await rememberInstall(origin, install);
    return {state: "starting", kind: install.kind, home: install.home};
  });

  app.put(`${base}/onboarding`, async request => {
    const {workspaceId} = params.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const input = body.parse(request.body ?? {});
    await ensureTable(pool);
    const row = (await pool.query("SELECT models_directory,completed,dismissed FROM onboarding_settings WHERE workspace_id=$1", [workspaceId])).rows[0] as {models_directory: string | null; completed: boolean; dismissed: boolean} | undefined;
    let modelsDirectory = row?.models_directory ?? null;
    if (input.modelsDirectory !== undefined) {
      if (input.modelsDirectory === null || input.modelsDirectory === "") modelsDirectory = null;
      else {
        const chosen = path.resolve(input.modelsDirectory);
        if (!path.isAbsolute(input.modelsDirectory)) throw new HttpError(400, "Choose an absolute folder path.");
        try {
          await mkdir(chosen, {recursive: true});
          const info = await stat(chosen);
          if (!info.isDirectory()) throw new Error("not a directory");
          await access(chosen, constants.W_OK);
        } catch {
          throw new HttpError(400, "That folder cannot be created or written to. Choose another folder.");
        }
        modelsDirectory = chosen;
      }
    }
    const completed = input.completed ?? row?.completed ?? false;
    const dismissed = input.dismissed ?? row?.dismissed ?? false;
    await pool.query(
      `INSERT INTO onboarding_settings(workspace_id,models_directory,completed,dismissed,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(workspace_id) DO UPDATE SET models_directory=EXCLUDED.models_directory,completed=EXCLUDED.completed,dismissed=EXCLUDED.dismissed,updated_at=now()`,
      [workspaceId, modelsDirectory, completed, dismissed],
    );
    /* A connected ComfyUI on this computer tells where it lives, so "Start ComfyUI" works on the next day. */
    if (completed && config.localSingleUser) {
      const local = (await pool.query("SELECT origin FROM workers WHERE workspace_id=$1 AND enabled AND kind='local'", [workspaceId])).rows as Array<{origin: string}>;
      for (const worker of local) if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(worker.origin)) await rememberRunning(worker.origin);
    }
    return {...await read(workspaceId), savedBy: user.id};
  });
}
