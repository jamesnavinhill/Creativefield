import {useEffect, useRef, useState} from "react";
import {Button,Dialog,Meta,Notice,StatusText,TextField} from "../ds";
import {workspacePath, type Call} from "./api";

type Install = {kind: "portable" | "desktop"; home: string};
type OnboardingState = {
  completed: boolean;
  dismissed: boolean;
  /** ComfyUI answering at a usual address on this computer that is not a worker yet. */
  detected?: string[];
  /** ComfyUI installed on this computer but not running. */
  installs?: Install[];
  system: {comfyWorkers: {total: number; online: number; names: string[]}};
};
type Worker = {id: string; origin: string};

/* First start asks for one thing: which ComfyUI to use. States (Pad, Current state: onboarding):
   checking -> connected (a worker is online: closes by itself) | found (ComfyUI answers) | installed (on disk, not
   running) | missing (nothing found).
   found -> connecting -> done. installed -> starting (polls every 3 s, up to 2 min) -> connecting -> done, or back to
   installed with the reason. missing -> checking (Check again) or connecting (an address typed in).
   Every state has a way out: Later closes it; Workspace setup opens the same steps again. */
type Phase = "checking" | "connected" | "found" | "installed" | "starting" | "missing" | "connecting";

const START_WAIT_MS = 120_000, POLL_MS = 3_000;
const label = (origin: string) => origin.endsWith(":8000") ? "ComfyUI Desktop" : "ComfyUI";

export function OnboardingGate({open,workspaceId,call,onClose}:{open: boolean; workspaceId: string; call: Call; onClose: () => void}) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [address, setAddress] = useState("http://127.0.0.1:8188");
  const [error, setError] = useState<{title: string; text: string; details?: string}>();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const finish = async (completed: boolean) => {
    try { await call(workspacePath(workspaceId, "onboarding"), "PUT", completed ? {completed: true} : {dismissed: true}); } catch { /* the setup stays reachable in the workspace bar */ }
    onClose();
  };

  /** Adds the ComfyUI as this computer's worker (or reuses the one already saved for that address) and reads its
      models and nodes once. */
  const connect = async (origin = address.trim()) => {
    setPhase("connecting"); setError(undefined);
    try {
      const known = (await call<Worker[]>(workspacePath(workspaceId, "workers"), "GET")).find(worker => worker.origin.replace(/\/$/, "") === origin.replace(/\/$/, ""));
      const worker = known ?? await call<Worker>(workspacePath(workspaceId, "workers"), "POST", {name: "This computer", origin, kind: "local"});
      await call(workspacePath(workspaceId, `workers/${worker.id}/probe`), "POST");
      await finish(true);
    } catch (cause) {
      setError({title: `${label(origin)} did not answer`, text: "Check that ComfyUI is running at this address, then try again.", details: (cause as Error).message});
      setPhase(state?.detected?.length ? "found" : state?.installs?.length ? "installed" : "missing");
    }
  };

  const read = () => call<OnboardingState>(workspacePath(workspaceId, "onboarding"), "GET");
  const check = async () => {
    setPhase("checking"); setError(undefined);
    try {
      const next = await read();
      setState(next);
      if (next.detected?.length) setAddress(next.detected[0]);
      /* Already connected: nothing to ask, so the first start goes straight to the studio. */
      if (next.system.comfyWorkers.online > 0) { setPhase("connected"); if (!next.completed) await finish(true); return; }
      setPhase(next.detected?.length ? "found" : next.installs?.length ? "installed" : "missing");
    } catch (cause) {
      setError({title: "This computer could not be checked", text: "CreativeField did not answer. Try again in a moment.", details: (cause as Error).message});
      setPhase("missing");
    }
  };
  useEffect(() => { if (open) void check(); }, [open, workspaceId]);

  /** Starts the install found on disk, then waits until it answers and connects it by itself. */
  const start = async () => {
    setPhase("starting"); setError(undefined);
    try { await call(workspacePath(workspaceId, "onboarding/start-comfy"), "POST", {index: 0}); }
    catch (cause) { setError({title: "ComfyUI could not be started", text: "Start it yourself (its start file or app), then check again.", details: (cause as Error).message}); setPhase("installed"); return; }
    const until = Date.now() + START_WAIT_MS;
    while (alive.current && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      try {
        const next = await read();
        if (next.detected?.length) { setState(next); setAddress(next.detected[0]); await connect(next.detected[0]); return; }
      } catch { /* the app restarts or is busy: keep waiting */ }
    }
    if (alive.current) { setError({title: "ComfyUI did not start", text: "It did not answer within 2 minutes. Its own window shows why; fix that, then check again."}); setPhase("installed"); }
  };

  const install = state?.installs?.[0];
  const busy = phase === "checking" || phase === "connecting" || phase === "starting";
  const primary = phase === "installed"
    ? <Button variant="primary" onClick={() => void start()}>Start ComfyUI</Button>
    : phase === "starting" ? <Button variant="primary" disabled>Starting…</Button>
    : <Button variant="primary" disabled={busy || !address.trim()} onClick={() => void connect()}>{phase === "connecting" ? "Connecting…" : phase === "missing" ? "Connect" : `Use this ${label(address)}`}</Button>;
  const footer = phase === "connected"
    ? <Button variant="primary" onClick={() => void finish(true)}>Let's create</Button>
    : <><Button variant="ghost" disabled={phase === "connecting"} onClick={() => void finish(false)}>Later</Button>
      {(phase === "missing" || phase === "installed") && <Button variant="secondary" onClick={() => void check()}>Check again</Button>}
      {primary}</>;

  return <Dialog open={open} title="Connect ComfyUI" onClose={() => void finish(false)} footer={footer}>
    {error && <Notice inline priority={10} title={error.title} details={error.details}>{error.text}</Notice>}
    {phase === "checking" && <StatusText tone="active">Looking for ComfyUI on this computer…</StatusText>}
    {phase === "connected" && <StatusText tone="ok">ComfyUI is connected{state?.system.comfyWorkers.names.length ? ` (${state.system.comfyWorkers.names.join(", ")})` : ""}. Its models appear under Models.</StatusText>}
    {(phase === "found" || phase === "connecting" && !!state?.detected?.length) && <StatusText tone="ok">{label(address)} is running on this computer at {address}.</StatusText>}
    {phase === "installed" && install && <Meta>{install.kind === "desktop" ? "ComfyUI Desktop" : "ComfyUI"} is installed at {install.home} but not running.</Meta>}
    {phase === "starting" && <StatusText tone="active">Starting ComfyUI. Its own window opens; this takes up to a minute.</StatusText>}
    {(phase === "missing" || phase === "connecting" && !state?.detected?.length && !install) && <>
      <Meta>CreativeField makes pictures and videos with your ComfyUI. Start ComfyUI (portable or Desktop), then check again, or type its address.</Meta>
      <TextField label="ComfyUI address" value={address} onChange={setAddress} disabled={phase === "connecting"}/>
    </>}
  </Dialog>;
}
