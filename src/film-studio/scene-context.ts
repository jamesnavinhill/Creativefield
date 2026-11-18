/*
 * The whole-clip scene description on the studio side ( TASK-A). The frames are the ones the
 * analysis already holds: the middle frame of every shot, plus one more frame for each further five
 * seconds of a longer shot, at most eight in one request. Nothing is captured again.
 */
import type {AnalysisScan, SceneContext} from "./analysis-contract";

export type SceneFrame = {shotIndex: number; timeSec: number; image: string};

/** Frames per scene request: the server accepts at most this many images. */
export const SCENE_REQUEST_FRAMES = 8;
/** A shot longer than this gets one more frame for each further interval. */
const SCENE_INTERVAL_SEC = 5;

/** The frames for the vision pass over a scan, in time order, thinned evenly to the request limit. */
export function sceneFrames(scan: Pick<AnalysisScan, "shots">): SceneFrame[] {
  const picks: SceneFrame[] = [];
  for (const shot of scan.shots) {
    const frames = shot.frames ?? [];
    if (!frames.length) continue;
    const timeOf = (index: number) => shot.keyframes[index]?.timeSec ?? shot.startSec;
    const chosen = new Set<number>([Math.floor((frames.length - 1) / 2)]);
    for (let mark = shot.startSec + SCENE_INTERVAL_SEC; mark < shot.endSec - 1; mark += SCENE_INTERVAL_SEC) {
      let nearest = 0;
      for (let index = 1; index < frames.length; index++) {
        if (Math.abs(timeOf(index) - mark) < Math.abs(timeOf(nearest) - mark)) nearest = index;
      }
      chosen.add(nearest);
    }
    for (const index of [...chosen].sort((left, right) => left - right)) {
      picks.push({shotIndex: shot.index, timeSec: timeOf(index), image: frames[index]});
    }
  }
  picks.sort((left, right) => left.timeSec - right.timeSec || left.shotIndex - right.shotIndex);
  if (picks.length <= SCENE_REQUEST_FRAMES) return picks;
  // Keep the first and the last frame and spread the rest evenly over the clip.
  const kept = new Set<number>();
  for (let step = 0; step < SCENE_REQUEST_FRAMES; step++) kept.add(Math.round((step * (picks.length - 1)) / (SCENE_REQUEST_FRAMES - 1)));
  return [...kept].sort((left, right) => left - right).map((index) => picks[index]);
}

/**
 * Ask the server to describe the clip. Never throws: a missing model, a timeout or a bad answer gives
 * null, and the analysis continues with the typed per-shot decisions.
 */
export async function describeScene(workspaceId: string, cacheKey: string, frames: SceneFrame[], options: {signal?: AbortSignal} = {}): Promise<SceneContext | null> {
  if (!frames.length) return null;
  try {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/scene`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      credentials: "same-origin",
      body: JSON.stringify({cacheKey, frames}),
      signal: options.signal ?? AbortSignal.timeout(200_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {scene?: SceneContext};
    return payload.scene ?? null;
  } catch {
    return null;
  }
}

/** The scene's first brief line: where, how many people and how they sit or stand, what happens. */
export function sceneLine(scene: SceneContext): string {
  const count = scene.people.length;
  const poses = [...new Set(scene.people.map((person) => person.pose).filter((pose) => pose !== "unknown"))];
  const people = count === 0 ? "no people" : `${count} ${count === 1 ? "person" : "people"}${poses.length ? `, ${poses.join(" and ")}` : ""}`;
  return `Scene: ${[scene.place, people, scene.action].filter(Boolean).join(". ")}.`;
}
