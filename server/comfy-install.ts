/* The ComfyUI on this computer: finding it, remembering which one this person uses, and starting it.
   Remembered in <home>/comfy-install.json, written only (a) when the person confirms a found folder in the Connect
   dialog, or (b) from a ComfyUI they already connected, which reports its own folders. Start runs only a remembered
   install that is still a ComfyUI install at that moment, never whatever a search turns up. */
import {spawn} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
// @ts-expect-error plain ESM helper shared with the start scripts
import {findComfyInstalls, portableAt} from "../scripts/find-comfy.mjs";

export type ComfyInstall = {kind: "portable"; home: string; python: string; main: string} | {kind: "desktop"; home: string; exe: string};
type Saved = {origin: string; install: ComfyInstall};
type Store = Record<string, ComfyInstall>;
const key = (origin: string) => origin.replace(/\/$/, "").toLowerCase();
function store(): Store { try { const data = JSON.parse(readFileSync(file(), "utf8")); return data && typeof data === "object" ? data as Store : {}; } catch { return {}; } }

const file = () => path.resolve(process.env.COMFYFIELD_HOME?.trim() || ".comfyfield", "comfy-install.json");

/** Searches the disk now; pass through a one-minute cache only for display. */
let cache: {at: number; installs: ComfyInstall[]} | undefined;
export function comfyInstalls(fresh = false): ComfyInstall[] {
  if (fresh || !cache || Date.now() - cache.at > 60_000) cache = {at: Date.now(), installs: findComfyInstalls({root: process.cwd()}) as ComfyInstall[]};
  return cache.installs;
}

/** The install remembered for the ComfyUI at this address. */
export function savedInstall(origin: string): Saved | undefined {
  const install = store()[key(origin)];
  return install?.home ? {origin, install} : undefined;
}

export async function rememberInstall(origin: string, install: ComfyInstall) {
  await mkdir(path.dirname(file()), {recursive: true});
  await writeFile(file(), JSON.stringify({...store(), [key(origin)]: install}, null, 2));
}

/** Learns the install from a running local ComfyUI the person connected: it reports its own folders. */
export async function rememberRunning(origin: string) {
  if (savedInstall(origin)) return;
  try {
    const response = await fetch(`${origin}/internal/folder_paths`, {signal: AbortSignal.timeout(3000)});
    const folders = await response.json() as Record<string, unknown>;
    const entry = folders.custom_nodes as string[] | [string[]] | undefined;
    const customNodes = Array.isArray(entry?.[0]) ? (entry![0] as string[])[0] : (entry as string[] | undefined)?.[0];
    if (!customNodes) return;
    const base = path.dirname(customNodes);
    const install = (portableAt(path.dirname(base)) ?? portableAt(base) ?? comfyInstalls(true).find(found => found.kind === "desktop")) as ComfyInstall | undefined;
    if (install) await rememberInstall(origin, install);
  } catch { /* an older ComfyUI without that endpoint: Start stays manual */ }
}

/** Starts an install in its own window, on the port of `origin`. Throws a sentence a person can act on. */
export function launchInstall(install: ComfyInstall, origin: string) {
  const port = new URL(origin).port || "8188";
  if (install.kind === "portable" ? !(existsSync(install.python) && existsSync(install.main)) : !existsSync(install.exe)) throw new Error("ComfyUI is no longer in the folder it was in. Start it yourself, then check again.");
  const child = install.kind === "portable"
    ? spawn(install.python, ["-s", install.main, ...(/python_embeded/i.test(install.python) ? ["--windows-standalone-build"] : []), "--listen", "127.0.0.1", "--port", port], {cwd: install.home, detached: true, stdio: "ignore", windowsHide: false})
    : spawn(install.exe, [], {cwd: install.home, detached: true, stdio: "ignore", windowsHide: false});
  child.on("error", () => { /* the caller's wait for an answer reports it */ });
  child.unref();
}
