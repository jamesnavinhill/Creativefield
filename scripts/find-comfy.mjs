// Finds ComfyUI installs on this computer so CreativeField can start one instead of asking for paths.
//
// Portable / manual: a folder with python_embeded\python.exe (or a venv) and ComfyUI\main.py, or ComfyUI\main.py
// directly. Desktop: the ComfyUI Desktop app's ComfyUI.exe. The search is shallow and bounded: the folders around
// CreativeField (people often unzip both into one parent folder), the drive roots, and
// Desktop / Downloads / Documents. Nothing is started here.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const children = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; } };

/** A portable or manual install rooted at `dir`, or undefined. */
export function portableAt(dir) {
  const embedded = path.join(dir, "python_embeded", "python.exe");
  if (existsSync(embedded) && existsSync(path.join(dir, "ComfyUI", "main.py"))) return { kind: "portable", home: dir, python: embedded, main: path.join(dir, "ComfyUI", "main.py") };
  for (const venv of [".venv", "venv"]) {
    const python = path.join(dir, venv, "Scripts", "python.exe");
    if (existsSync(python) && existsSync(path.join(dir, "main.py"))) return { kind: "portable", home: dir, python, main: path.join(dir, "main.py") };
  }
  return undefined;
}

function desktopApps(env) {
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(local, "Programs", "@comfyorgcomfyui-electron", "ComfyUI.exe"),
    path.join(local, "Programs", "ComfyUI", "ComfyUI.exe"),
    path.join(local, "Programs", "comfyui-electron", "ComfyUI.exe"),
  ].filter((exe) => existsSync(exe)).map((exe) => ({ kind: "desktop", home: path.dirname(exe), exe }));
}

/** Every ComfyUI install found, portable ones first (they start without a window to click through). */
export function findComfyInstalls({ root = process.cwd(), env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  const found = new Map();
  const consider = (dir, depth) => {
    if (!isDir(dir)) return;
    const hit = portableAt(dir);
    if (hit) { found.set(hit.home.toLowerCase(), hit); return; }
    if (depth > 0) for (const child of children(dir)) if (!/^(\$|windows$|program files|programdata|node_modules|\.git)/i.test(path.basename(child))) consider(child, depth - 1);
  };
  if (env.COMFY_HOME) consider(path.resolve(env.COMFY_HOME), 1);
  // The folders around CreativeField, two levels up, each searched two levels deep.
  let up = path.resolve(root);
  for (let i = 0; i < 3; i++) { const parent = path.dirname(up); if (parent === up) break; up = parent; consider(up, 2); }
  for (const place of ["Desktop", "Downloads", "Documents"]) consider(path.join(os.homedir(), place), 2);
  for (const letter of "CDEFGH") {
    const drive = `${letter}:\\`;
    if (!isDir(drive)) continue;
    // Only folders whose name says ComfyUI, so a drive root is never walked as a whole.
    // Also one level down (a tools folder that holds a ComfyUI folder), still only into folders named ComfyUI.
    for (const child of children(drive)) {
      if (/comfy/i.test(path.basename(child))) { consider(child, 2); continue; }
      if (/^(\$|windows$|program files|programdata|users$|recovery|system volume)/i.test(path.basename(child))) continue;
      for (const grand of children(child)) if (/comfy/i.test(path.basename(grand))) consider(grand, 1);
    }
  }
  return [...found.values(), ...desktopApps(env)];
}
