/*
 * Decision-model proxy: forwards a compact state + typed questions to a local
 * System One server (Kev through Ollama). The studio uses this only for cheap
 * triage; if no model is running the route says exactly what to install and the
 * client keeps its deterministic heuristic.
 */
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import {readAnalysisCache, upsertAnalysisCache} from "./analysis-cache";
import type {SceneContext, ScenePerson, SceneProp, SceneShot} from "../src/film-studio/analysis-contract";

const MAX_STATE = 24_000;
const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/;
const body = z.object({
  state: z.string().min(1).max(MAX_STATE),
  images: z.array(z.string().max(4_000_000)).max(8).optional(),
  questions: z.record(z.string().min(1).max(64), z.record(z.string(), z.unknown())),
  model: z.string().min(1).max(80).optional(),
}).strict().refine((input) => Object.keys(input.questions).length <= 30, {message: "At most 30 questions per decision request"});

/** Ollama takes raw base64 in `images`; the browser sends data URLs. */
export function imagePayload(images: string[] | undefined): string[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => {
    const match = IMAGE.exec(image);
    if (!match) throw new HttpError(400, "Decision images must be jpeg, png or webp data URLs.");
    return match[1];
  });
}

export async function decisionRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/decision", {bodyLimit: 1024 * 1024}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const input = body.parse(request.body ?? {});
    const images = imagePayload(input.images);
    const base = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = await resolveModel(base, input.model, !!images?.length);
    let response: Response;
    try {
      response = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({model, state: input.state, questions: input.questions, ...(images ? {images} : {})}),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new HttpError(503, "The decision model is not running. Install Ollama, then pull a model with `ollama pull kev:0.8b-q8` and retry.");
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !payload) throw new HttpError(502, (payload?.error as string | undefined) ?? `The decision model answered ${response.status}.`);
    return {
      answers: (payload.answers ?? payload) as Record<string, unknown>,
      model: (payload.model as string | undefined) ?? model,
    };
  });
}

/** Pick the installed decision model for the request: d3 for image questions, Kev for text. */
export function pickDecisionModel(names: string[], requested?: string, vision = false): string {
  if (requested) return requested;
  const size = (name: string) => Number(new RegExp(":(\\d+(?:\\.\\d+)?)b").exec(name)?.[1] ?? 99);
  const smallest = (candidates: string[]) => [...candidates].sort((left, right) => size(left) - size(right) || left.length - right.length)[0];
  const candidates = names.filter((name) => /^(d3|kev)(?::|$)/.test(name));
  if (vision) {
    const d3 = candidates.filter((name) => /^d3(?::|$)/.test(name));
    if (d3.length) return smallest(d3);
  }
  const kev = candidates.filter((name) => /^kev(?::|$)/.test(name));
  if (kev.length) return smallest(kev);
  if (candidates.length) return smallest(candidates);
  return vision ? "d3:2b" : "kev";
}

async function resolveModel(base: string, requested: string | undefined, vision: boolean): Promise<string> {
  if (requested) return requested;
  const env = vision ? process.env.DECISION_MODEL ?? process.env.VISION_DECISION_MODEL : process.env.KEV_MODEL ?? process.env.DECISION_MODEL;
  if (env) return env;
  try {
    const response = await fetch(`${base}/api/tags`, {signal: AbortSignal.timeout(3000)});
    if (response.ok) {
      const payload = (await response.json()) as {models?: Array<{name?: string}>};
      const names = (payload.models ?? []).map((entry) => entry.name).filter((name): name is string => typeof name === "string");
      return pickDecisionModel(names, undefined, vision);
    }
  } catch {
    // Fall through to the documented default and let the error explain it.
  }
  return pickDecisionModel([], undefined, vision);
}

/* ------------------------------------------------------------------------------------------------
 * Scene pass ( TASK-A): one vision call describes the whole clip from up to eight frames,
 * so later stages know how many people there are, how they stand and what each shot shows. The
 * answer is stored with the cached analysis. A missing model or a bad answer never fails the
 * analysis: the studio keeps the typed per-shot decisions.
 * ---------------------------------------------------------------------------------------------- */

export const SCENE_MAX_FRAMES = 8;
/** Eight frames of a 16:9 clip need about 9,000 tokens; 8,192 was too small ( TASK-A). */
export const SCENE_CONTEXT_TOKENS = 16384;
const SCENE_MODELS = ["qwen3-vl:4b", "gemma3:4b"];
const POSES = ["sitting", "standing", "walking", "lying", "unknown"] as const;
const CONTENTS = ["people", "object-closeup", "motion-blur", "environment", "graphic"] as const;

/** The JSON Ollama must return: enforced through `format`, validated again on our side. */
export const SCENE_FORMAT = {
  type: "object",
  required: ["setting", "place", "action", "people", "props", "shots"],
  properties: {
    setting: {type: "string", enum: ["interior", "exterior", "unknown"]},
    place: {type: "string"},
    action: {type: "string"},
    people: {type: "array", maxItems: 6, items: {type: "object", required: ["id", "look", "pose", "facing"], properties: {id: {type: "string"}, look: {type: "string"}, pose: {type: "string", enum: [...POSES]}, facing: {type: "string"}}}},
    props: {type: "array", maxItems: 8, items: {type: "object", required: ["kind", "label", "depth", "side"], properties: {kind: {type: "string"}, label: {type: "string"}, depth: {type: "string", enum: ["foreground", "midground", "background"]}, side: {type: "string", enum: ["left", "center", "right"]}}}},
    shots: {type: "array", items: {type: "object", required: ["shotIndex", "content", "people", "description"], properties: {shotIndex: {type: "integer"}, content: {type: "string", enum: [...CONTENTS]}, people: {type: "array", items: {type: "string"}}, description: {type: "string"}}}},
  },
} as const;

/** The image labels and the instructions: what to describe, and what a blur or an object is. */
export function scenePrompt(frames: Array<{shotIndex: number; timeSec: number}>): string {
  const labels = frames.map((frame, index) => `Image ${index + 1}: shot ${frame.shotIndex}, ${frame.timeSec.toFixed(1)} s.`).join("\n");
  return [
    "You describe one short video clip from the images below. They are frames of the same clip, in time order.",
    labels,
    "Answer with one JSON object only:",
    "- setting (interior, exterior or unknown), place (what kind of room or outdoor place, at most 80 characters), action (what happens across the clip, at most 120 characters).",
    "- people: every person you can clearly see, at most 6, with ids p1, p2, and so on. The same person keeps the same id in every image. look: a few words (hair, clothing, at most 60 characters). pose: sitting, standing, walking, lying or unknown. facing: camera, left, right, away, or the id of the person they face.",
    "- props: large things only (table, chair, wall, planter, door, window, counter, vehicle), at most 8, with depth (foreground, midground, background) and side (left, center, right).",
    "- shots: one entry per shot index listed above. content: people, object-closeup, motion-blur, environment or graphic. people: the ids of the people visible in that shot. description: one sentence, at most 100 characters.",
    "A frame mostly blurred by a fast camera move is motion-blur. A frame showing mainly an object or a hand is object-closeup. Count only people you can see; a hand or a head in a blur is not a person.",
  ].join("\n");
}

/** Validate and clamp the model's answer: unknown shots and person ids are dropped, long text is cut. */
export function parseSceneAnswer(raw: unknown, sent: number[], model: string): SceneContext {
  const answer = raw as Record<string, unknown> | null;
  if (!answer || typeof answer !== "object") throw new HttpError(502, "The vision model did not describe the scene.");
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const allowedShots = new Set(sent);
  const people = (Array.isArray(answer.people) ? answer.people : []).slice(0, 6).map((entry, index) => {
    const person = entry as Record<string, unknown>;
    const pose = (POSES as readonly string[]).includes(String(person.pose)) ? (person.pose as ScenePerson["pose"]) : "unknown";
    return {id: text(person.id, 12) || `p${index + 1}`, look: text(person.look, 60), pose, facing: text(person.facing, 20)};
  });
  const personIds = new Set(people.map((person) => person.id));
  const props = (Array.isArray(answer.props) ? answer.props : []).slice(0, 8).map((entry) => {
    const prop = entry as Record<string, unknown>;
    const depth = ["foreground", "midground", "background"].includes(String(prop.depth)) ? (prop.depth as SceneProp["depth"]) : "midground";
    const side = ["left", "center", "right"].includes(String(prop.side)) ? (prop.side as SceneProp["side"]) : "center";
    return {kind: text(prop.kind, 20) || "other", label: text(prop.label, 60), depth, side};
  });
  const shots = (Array.isArray(answer.shots) ? answer.shots : [])
    .map((entry) => entry as Record<string, unknown>)
    .filter((shot) => typeof shot.shotIndex === "number" && allowedShots.has(shot.shotIndex))
    .map((shot) => ({
      shotIndex: shot.shotIndex as number,
      content: ((CONTENTS as readonly string[]).includes(String(shot.content)) ? shot.content : "environment") as SceneShot["content"],
      people: (Array.isArray(shot.people) ? shot.people : []).map((id) => text(id, 12)).filter((id) => personIds.has(id)),
      description: text(shot.description, 100),
    }));
  if (!shots.length) throw new HttpError(502, "The vision model answered without any shot.");
  const setting = ["interior", "exterior"].includes(String(answer.setting)) ? (answer.setting as SceneContext["setting"]) : "unknown";
  return {model, setting, place: text(answer.place, 80), action: text(answer.action, 120), people, props, shots};
}

/** The scene model: SCENE_MODEL, else the first of SCENE_MODELS that Ollama has. It never pulls a model. */
export function pickSceneModel(names: string[], requested?: string): string | null {
  if (requested) return requested;
  if (process.env.SCENE_MODEL) return process.env.SCENE_MODEL;
  return SCENE_MODELS.find((candidate) => names.includes(candidate)) ?? null;
}

const sceneBody = z.object({
  cacheKey: z.string().min(10).max(600),
  frames: z.array(z.object({shotIndex: z.number().int().min(0).max(10_000), timeSec: z.number().min(0).max(100_000), image: z.string().max(4_000_000)})).min(1).max(SCENE_MAX_FRAMES),
}).strict();

export async function sceneRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/scene", {bodyLimit: 8 * 1024 * 1024}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const input = sceneBody.parse(request.body ?? {});
    const cached = await readAnalysisCache(pool, workspaceId, input.cacheKey);
    if (!cached || !cached.clip) throw new HttpError(404, "Scan the clip before describing its scene.");
    const images = imagePayload(input.frames.map((frame) => frame.image)) ?? [];
    const base = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    let names: string[] = [];
    try {
      const tags = (await (await fetch(`${base}/api/tags`, {signal: AbortSignal.timeout(3000)})).json()) as {models?: Array<{name?: string}>};
      names = (tags.models ?? []).map((entry) => entry.name ?? "").filter(Boolean);
    } catch {
      throw new HttpError(503, "The vision model is not running. Install Ollama, then run `ollama pull qwen3-vl:4b`, and retry.");
    }
    const model = pickSceneModel(names);
    if (!model) throw new HttpError(503, "No scene model is installed. Run `ollama pull qwen3-vl:4b`, then retry.");
    let response: Response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format: SCENE_FORMAT,
          options: {temperature: 0, num_ctx: SCENE_CONTEXT_TOKENS, num_predict: 6144},
          messages: [{role: "user", content: `/no_think\n${scenePrompt(input.frames)}`, images}],
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new HttpError(503, "The vision model did not answer. Check that Ollama is running.");
    }
    const payload = (await response.json().catch(() => null)) as {message?: {content?: string}; error?: string} | null;
    if (!response.ok || !payload?.message?.content) throw new HttpError(502, payload?.error ?? `The vision model answered ${response.status}.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.message.content);
    } catch {
      throw new HttpError(502, "The vision model did not return JSON.");
    }
    const scene = parseSceneAnswer(parsed, input.frames.map((frame) => frame.shotIndex), model);
    await upsertAnalysisCache(pool, workspaceId, input.cacheKey, {scene, stages: {scene: true}});
    return {scene};
  });
}
