// One-command start for the downloadable package.
//
//   npm start        (runs node scripts/start-local.mjs)
//
// Runs setup first if needed, starts the embedded PostgreSQL, starts the
// app server against .comfyfield/app.env, waits for /api/v1/health and
// opens the browser. Ctrl+C stops server and database cleanly.

import {createPersistentPostgres} from "./postgres-lifecycle.mjs";
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireSupportedNode, SERVER_PORT, parseEnvContent, pgPort, resolveHomeDir } from "./local-setup-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = resolveHomeDir(projectRoot);
const pgDataDir = path.join(homeDir, "postgres");
const envPath = path.join(homeDir, "app.env");
let serverPort = SERVER_PORT;
const appUrl = () => `http://127.0.0.1:${serverPort}/#video`;

/* Self-healing start (Pad: Current state: release, start flow). Each failure either repairs itself once or ends
   with one sentence that says what to do; never a stack trace. */
const portFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.once("listening", () => probe.close(() => resolve(true)));
  probe.listen(port, "127.0.0.1");
});
async function creativeFieldAt(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).status === "ready";
  } catch { return false; }
}
function openBrowser(target) {
  if (process.env.COMFYFIELD_NO_BROWSER) return;
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}
/** The app and its node editor need two ports side by side. Returns false when CreativeField already runs there. */
async function choosePort() {
  if (await portFree(serverPort) && await portFree(serverPort + 1)) return true;
  if (await creativeFieldAt(serverPort)) return false;
  for (let candidate = serverPort + 2; candidate < serverPort + 40; candidate += 2) {
    if (await portFree(candidate) && await portFree(candidate + 1)) {
      console.log(`[start] Port ${serverPort} is used by another program, so CreativeField uses ${candidate} this time.`);
      serverPort = candidate;
      return true;
    }
  }
  throw new Error(`Ports ${serverPort} to ${serverPort + 40} are all in use. Close other programs or restart the computer, then start again.`);
}
/** npm install with one repair: a broken download cache is the usual cause, and npm can check it itself. */
async function installOnce() {
  try { await run("npm", ["install"]); return; }
  catch {
    console.log("[start] Installing failed. Checking the download cache and trying once more...");
    try { await run("npm", ["cache", "verify"]); } catch { /* the retry below says what is wrong */ }
    try { await run("npm", ["install"]); }
    catch { throw new Error("Installing failed twice. Check the internet connection (a VPN or firewall can block it), then start again."); }
  }
}

function run(command, args) {
  // shell is only needed to resolve npm.cmd on Windows; executable paths
  // (which may contain spaces, e.g. the Node.js install folder) must not
  // go through a shell unquoted.
  const needsShell = process.platform === "win32" && !command.endsWith(".exe");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", shell: needsShell });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

// Signal 0 only asks whether a process exists; it sends nothing.
export function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// A crash or a console close event can leave postmaster.pid behind. Starting
// on that stale file ends in ECONNREFUSED, so move it aside once its process
// is gone. Returns the new path, or null when there was nothing stale.
export async function clearStalePostmaster(directory, io = {}) {
  const read = io.read ?? readFile, move = io.move ?? rename, running = io.running ?? processIsRunning;
  const file = path.join(directory, "postmaster.pid");
  let text;
  try { text = await read(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const pid = Number(String(text).trim().split(/\r?\n/)[0]);
  if (running(pid)) return null;
  const aside = `${file}.stale-${Date.now()}-${process.pid}`;
  await move(file, aside);
  console.log(`[start] Moved a stale postmaster.pid aside; process ${Number.isInteger(pid) && pid > 0 ? pid : "unknown"} is not running.`);
  return aside;
}

async function main() {
  requireSupportedNode();

  // A source download (GitHub ZIP or clone) has no built app yet: install and build once, so nobody
  // has to run npm install / npm run build by hand (GitHub issue #1: ENOENT on dist/index.html).
  if (!existsSync(path.join(projectRoot, "node_modules"))) {
    console.log("[start] First start: installing CreativeField. This takes a few minutes...");
    await installOnce();
  }
  if (!existsSync(path.join(projectRoot, "dist", "index.html"))) {
    console.log("[start] First start: building the app. This takes a minute or two...");
    try { await run("npm", ["run", "build"]); }
    catch {
      // A half-finished install is the usual cause: repair it once, then build again.
      console.log("[start] Building failed. Repairing the install and building once more...");
      await installOnce();
      try { await run("npm", ["run", "build"]); }
      catch { throw new Error("Building the app failed twice. Delete the node_modules folder and start again; if it still fails, open an issue with the lines above."); }
    }
  }

  if (!existsSync(envPath) || !existsSync(path.join(pgDataDir, "PG_VERSION"))) {
    console.log("[start] First run: running automated setup...");
    await run(process.execPath, [path.join(projectRoot, "scripts", "setup-local.mjs")]);
  }

  if (!await choosePort()) {
    console.log(`[start] CreativeField is already running. Opening it: ${appUrl()}`);
    openBrowser(appUrl());
    return;
  }

  const envValues = parseEnvContent(await readFile(envPath, "utf8"));
  const dbMatch = /postgres:\/\/postgres:([^@]+)@/.exec(envValues.DATABASE_URL ?? "");
  if (!dbMatch) throw new Error(`Cannot read the database password from ${envPath}. Restore the matching app.env from a complete backup; keep the existing database and storage intact.`);
  await clearStalePostmaster(pgDataDir);
  // The launcher runs pg_ctl detached in its own process group, so a console
  // Ctrl+C meant for another program never reaches the postmaster.
  const pg = await createPersistentPostgres({
    databaseDir: pgDataDir,
    user: "postgres",
    password: decodeURIComponent(dbMatch[1]),
    port: pgPort(),
    persistent: true,
  });
  await pg.start();
  console.log("[start] Local PostgreSQL running.");

  // Variables set here win over app.env, so a moved port needs no file change.
  const server = spawn(process.execPath, ["--env-file", envPath, "--import", "tsx", "server/main.ts"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: serverPort === SERVER_PORT ? process.env : { ...process.env, PORT: String(serverPort), NODE_EDITOR_PORT: String(serverPort + 1), PUBLIC_ORIGIN: `http://127.0.0.1:${serverPort}` },
  });

  let stopping = false;
  let databaseRestarts = 0;
  let checkingDatabase = false;
  // A dead database would otherwise leave the server answering nothing until
  // the next start. Restarting it once keeps the session open.
  async function keepDatabaseRunning() {
    if (stopping || checkingDatabase || databaseRestarts >= 1) return;
    checkingDatabase = true;
    try {
      let pid;
      try { pid = Number((await readFile(path.join(pgDataDir, "postmaster.pid"), "utf8")).trim().split(/\r?\n/)[0]); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (pid !== undefined && processIsRunning(pid)) return;
      databaseRestarts += 1;
      console.error("[start] Local PostgreSQL stopped while the server was running. Restarting it once.");
      await clearStalePostmaster(pgDataDir);
      await pg.stop();
      await pg.start();
      console.log("[start] Local PostgreSQL is running again.");
    } catch (error) {
      console.error("[start] Local PostgreSQL could not be restarted:", error.message);
    } finally {
      checkingDatabase = false;
    }
  }
  const databaseMonitor = setInterval(() => void keepDatabaseRunning(), 3000);

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(databaseMonitor);
    server.kill();
    try { await pg.stop(); } catch (error) { console.error("[start] Database shutdown needs attention:",error.message); code=1; }
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  server.on("close", (code) => void shutdown(code ?? 0));

  async function waitForHealth() {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/api/v1/health`);
        if (response.ok) return true;
      } catch { /* server not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  if (await waitForHealth()) {
    console.log(`[start] CreativeField is ready at ${appUrl()}`);
    openBrowser(appUrl());
  } else {
    console.error("[start] Server did not become healthy within 60 seconds.");
    await shutdown(1);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    console.error(`
[start] CreativeField could not start: ${error.message}`);
    console.error("[start] Still stuck? Open an issue at https://github.com/rhymeas/Creativefield/issues and paste the lines above.");
    process.exit(1);
  }
}
