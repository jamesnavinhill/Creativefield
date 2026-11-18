/*
 * The analysis contract shared by the studio (browser) and the team server.
 *
 * One clip, one reproducible analysis: the cache key is built from the clip's
 * SHA-256 plus the exact model ids and pyramid parameters, so the same clip and
 * the same settings always resolve to the same stored score. The server owns the
 * heavy stages (clip scan, resolution pyramid, geometry) and stores each stage's
 * result; the studio owns the score YAML it commits back into the cache.
 *
 * No DOM or Node APIs live here: both the client bundle and the server import
 * this module, and everything in it is pure.
 *
 * Progress is modelled per shot: a shot moves pending -> blockout (cuts known)
 * -> refining (a batch is running) -> spatial (measured positions) -> edited
 * (the person changed it). The transitions are in `shot-status.ts`.
 */
import type {ShotStatus} from "./shot-status";

// Version 4: the person pass now runs first as the skip confirmation (SAM3 on keyframes), tracks
// are associated time-aware across keyframes, and the camera-height fallback localizes roots when
// the person head is above the prior ray. Earlier analyses are deliberately re-scanned.
// Version 5: every shot with a MoGe mesh gets its set rebuilt (depth-banded voxels,
// merged into columns), estimated shots use the mesh instead of a flat backdrop, and no-person
// shots are environment shots with camera and set instead of a skip.
// Version 6 ( acceptance): every person mask of a keyframe is cut from the set mesh
// (two people no longer leave the second as set blocks), and a large top-cut mask is a face
// close-up person instead of a no-person shot.
// Version 7 (2026-11-13): the score keeps the measured camera direction instead of aiming at the
// people, and a shot without a floor reads its pitch and height from the upright person.
// Version 8 (2026-11-13): stage x was mirrored (image right came out as stage left); fixed at
// the source (sceneBasis, rootFromAnchorBearing). Older analyses are mirrored and recomputed.
// Version 9 (2026-11-15, Phase 3 of LATER-2240): one person split by SAM into masks (shirt and
// trousers) is measured as one outline, and a shot with an untrusted floor takes its scale from
// the people. Older analyses had two small figures and a scene about three times too small.
// Version 10 (2026-11-15): SAM3 runs once per keyframe, so every mask belongs to its frame; the video
// mode returned an extra tracked mask that the frame guess turned into a phantom second person.
// Version 11 (2026-11-15): with three or more keyframes, a person seen in only one of them is dropped
// when another person is seen in all of them (a ghost double in a blended source frame).
// Version 13 (2026-11-15,): DA3-Base multiview on the keyframes gives the camera path over the
// shot (MoGe anchor gives up and metric scale); people and set points move into the anchor frame.
// Version 16 (2026-11-15,): the set is fitted as oriented boxes, slabs and upright cylinders per
// connected part of the stage points instead of voxel stairs.
// Version 23 (2026-11-16,): one vision pass describes the whole clip (scene) before the shots are measured.
// Version 22 (2026-11-16): a shot without a camera path has as many people as are seen at once (a pan
// made eight of two), nobody stands closer than 0.8 m, no set box blocks the camera, and the people set
// the scale of the room when no floor was found; a floor the people contradict is not used.
// Version 24 (2026-11-17, TASK-B): the stored scene steers the geometry. A people shot takes the
// scene's people count (and keeps at most that many measured tracks); motion-blur, object and graphic shots
// get no person pass; a shot whose people all sit uses 1.3 m for the person-height anchor.
export const ANALYSIS_CONTRACT_VERSION = 24;

/** Resolution levels and keyframe policy; a change invalidates the cache. */
export type PyramidParams = {
  /** Proxy width for the decision frames (fast vision pass). */
  decisionWidth: number;
  /** Proxy/still width for the geometry and person passes. */
  geometryWidth: number;
  /** How many keyframes a shot geometry run may use (start/middle/end plus motion). */
  keyframesPerShot: number;
};

export type AnalysisModelIds = {
  /** Local decision model tag, e.g. d3:2b. */
  decision: string;
  /** MoGe checkpoint filename. */
  geometry: string;
  /** SAM 3.1 checkpoint filename. */
  persons: string;
};

export type AnalysisParams = {
  version: number;
  models: AnalysisModelIds;
  pyramid: PyramidParams;
};

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  version: ANALYSIS_CONTRACT_VERSION,
  models: {
    decision: "d3:2b",
    geometry: "moge_2_vitl_normal_fp16.safetensors",
    persons: "sam3.1_multiplex_fp16.safetensors",
  },
  pyramid: {decisionWidth: 320, geometryWidth: 640, keyframesPerShot: 3},
};

/** The key that makes an analysis reproducible: clip bytes + models + pyramid. */
export function analysisCacheKey(clipSha256: string, params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS): string {
  const {models, pyramid, version} = params;
  return [
    `contract${version}`,
    clipSha256,
    models.decision,
    models.geometry,
    models.persons,
    `${pyramid.decisionWidth}x${pyramid.geometryWidth}`,
    `kf${pyramid.keyframesPerShot}`,
  ].join("|");
}

/** Stable little hash for a score text, so "same score" is one comparison on both sides. */
export function scoreHash(yaml: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < yaml.length; index++) {
    hash ^= yaml.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const folded = (hash >>> 0).toString(16).padStart(8, "0");
  return `${folded}-${yaml.length.toString(16)}`;
}

export type ClipFacts = {
  sha256: string;
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  aspectRatio: number;
  /** Hard cuts in seconds, authoritative for the shot list. */
  cuts: number[];
  /** Where the clip came from: an uploaded file (default) or a captured YouTube embed. */
  source?: "file" | "youtube";
  /** The YouTube id when `source` is "youtube"; the analysis cache key is derived from it. */
  videoId?: string;
};

export type KeyframeRole = "start" | "middle" | "end" | "motion";

export type ShotKeyframe = {index: number; timeSec: number; role: KeyframeRole};

/** One shot of the analysed clip plus the decision frames the studio may send to the vision model. */
export type AnalysisShot = {
  index: number;
  startSec: number;
  endSec: number;
  keyframes: ShotKeyframe[];
  /** JPEG data URLs at `decisionWidth`, aligned with `keyframes`. */
  frames: string[];
};

/** One person of the scene description; the same person keeps one id across shots. */
export type ScenePerson = {id: string; look: string; pose: "sitting" | "standing" | "walking" | "lying" | "unknown"; facing: string};

/** A large thing in the scene: furniture, wall, planter, vehicle. */
export type SceneProp = {kind: string; label: string; depth: "foreground" | "midground" | "background"; side: "left" | "center" | "right"};

/** What one shot shows: people, a blur from a camera move, an object close-up, environment or a graphic. */
export type SceneShot = {shotIndex: number; content: "people" | "object-closeup" | "motion-blur" | "environment" | "graphic"; people: string[]; description: string};

/** The vision model's description of the whole clip, stored with the analysis. */
export type SceneContext = {model: string; setting: "interior" | "exterior" | "unknown"; place: string; action: string; people: ScenePerson[]; props: SceneProp[]; shots: SceneShot[]};

export type ShotDecision = {
  shotIndex: number;
  people: number;
  size: "wide" | "medium" | "close";
  motion: "static" | "dolly" | "pan" | "handheld";
  needsStaging: number;
};

/** The floor plane in camera coordinates: normal pointing away from the floor, offset in metres. */
export type GeometryFloor = {normal: [number, number, number]; offsetM: number; inliers: number; confidence: number};

/**
 * Camera approximation for one shot, in metres/degrees, measured against the floor plane.
 *
 * Conventions (kept identical to the evaluator, see score/evaluate.ts):
 * - `fovDeg` is the HORIZONTAL field of view on the 36 mm full-frame gate;
 *   `lensMm = 18 / tan(fovDeg / 2)` (use the helpers below, never a second formula).
 * - `pitchDeg` is positive when the real camera looks down (it is above the floor).
 * - `yawDeg` is 0 when the monocular keyframe gives no absolute yaw (the normal case);
 *   the score camera is derived from the measured positions instead, so a frontal
 *   subject legitimately ends up behind a target-facing cue.
 * - The score camera that reproduces the shot sits at eye = (0, heightM, 0) and looks at
 *   the primary measured subject at (xM, 0.9 * personHeightM, zM); geometry positions are
 *   camera-relative with xM to the right and zM forward along the camera axis.
 */
export type GeometryCamera = {
  heightM: number;
  pitchDeg: number;
  /** Camera yaw relative to the floor frame; the studio derives the score cue from the positions. */
  yawDeg: number;
  fovDeg: number;
  lensMm: number;
  confidence: number;
  /**
   * The camera over the shot: one pose per keyframe whose camera DA3 multiview recovered,
   * in time order, the anchor itself included. Stage
   * coordinates of the anchor keyframe (x left, y up, z forward, the anchor camera at
   * (0, heightM, 0) looking down +z). Absent or a single pose: the camera stands still.
   */
  path?: CameraPathPose[];
};

/** One measured camera pose on the shot's camera path. yawDeg > 0 turns towards stage +x (left). */
export type CameraPathPose = {timeSec: number; xM: number; zM: number; heightM: number; yawDeg: number; pitchDeg: number};

/** Full-frame gate width used by the evaluator's optics. */
export const SENSOR_WIDTH_MM = 36;

/** Horizontal FOV (36 mm gate) -> prime lens in millimetres, the evaluator's convention. */
export function lensMmFromHorizontalFov(fovDeg: number): number {
  const fov = Math.min(170, Math.max(0.5, fovDeg));
  return (SENSOR_WIDTH_MM / 2) / Math.tan((fov * Math.PI) / 360);
}

/** Prime lens in millimetres -> horizontal FOV (36 mm gate). */
export function horizontalFovFromLensMm(lensMm: number): number {
  const lens = Math.max(1, lensMm);
  return (2 * Math.atan((SENSOR_WIDTH_MM / 2) / lens) * 180) / Math.PI;
}

/** One person's root position at one keyframe, in metres on the floor plane. */
export type PersonKeyframe = {
  /** Absolute clip time in seconds (same base as shot start/end). */
  timeSec: number;
  xM: number;
  zM: number;
  confidence: number;
};

export type PersonTrack = {
  id: string;
  label?: string;
  /**
   * The raw measured person height in metres, before the plausibility clamp. Kept so a
   * measurement at the clamp boundary (e.g. 0.98 m or 2.3 m) is visible instead of being
   * silently rounded into the band; `null`/absent when the pass could not measure it.
   */
  rawHeightM?: number;
  /**
   * The person height used by the score synthesizer, clamped to the plausible band
   * (1.2..2.1 m). The raw value stays in `rawHeightM`.
   */
  heightM: number;
  keyframes: PersonKeyframe[];
};

/**
 * How a shot's geometry was obtained. `measured` = floor plane fitted and person roots placed on
 * it. `estimated` = no usable floor (close-up / inset), so the camera and the subject distance were
 * estimated from the person's apparent size in the image (person-height or head-size anchor) and the
 * MoGe FOV; the root is derived from that distance and the image bearing. The UI must show this
 * difference as "Measured" vs "Estimated (no floor)" and never as a problem.
 */
export type GeometryQuality = "measured" | "estimated";

/** What the estimated geometry is based on, kept for the UI and for acceptance evidence. */
export type ShotEstimate = {
  /** Which anchor gave the distance: a full visible person (1.75 m) or a head (~0.233 m). */
  basis: "person-height" | "head-size";
  /** Real-world size of the anchor in metres (1.75 person or 1.75/7.5 head). */
  anchorM: number;
  /** Measured anchor size in pixels. */
  anchorPx: number;
  /** Distance to the person in metres derived from focal length and anchor size. */
  subjectDistanceM: number;
  /** Where the camera height came from: a neighbouring measured shot's floor, or person eye level. */
  /** person-feet / person-head: height and pitch read from the upright person (no floor, 2026-11-13). */
  cameraHeightSource: "neighbor-floor" | "eye-level" | "person-feet" | "person-head";
  /** The measured neighbour shot the camera height was borrowed from, if any. */
  neighborShotIndex?: number;
  /** Keyframe (absolute clip seconds) whose mask provided the anchor. */
  keyframeTimeSec: number;
};

/**
 * One grey block of the roughly rebuilt set. The geometry stage samples the MoGe point
 * cloud, removes the person points, voxelizes what remains and merges occupied cells into boxes in
 * stage coordinates (metres, floor at y=0, camera at the origin looking down +z). The diorama draws
 * them as the scene; close-ups without a floor get a background wall at the estimated depth.
 */
export type SceneBlock = {
  /** Centre of the box in stage coordinates, metres; yM is the centre height above the floor. */
  xM: number;
  yM: number;
  zM: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** wall = backdrop/side, object = furniture/tree/car, ground = low ground clutter. */
  kind?: "wall" | "background" | "object" | "ground";
  /**
   *: "cylinder" is an upright cylinder of diameter sizeX (= sizeZ); absent or "box" is a
   * box. yawDeg turns it about the vertical (three.js rotation.y, degrees); absent = axis-aligned.
   */
  shape?: "box" | "cylinder";
  yawDeg?: number;
};

export type ShotGeometry = {
  shotIndex: number;
  floor: GeometryFloor;
  camera: GeometryCamera;
  persons: PersonTrack[];
  source: {model: string; keyframeSeconds: number[]; runtimeMs: number};
  /** Absent means "measured" (older cache entries); the server sets it explicitly. */
  quality?: GeometryQuality;
  /** Present only when quality is "estimated". */
  estimate?: ShotEstimate;
  /** The roughly rebuilt set for this shot; at most a few hundred blocks. */
  set?: SceneBlock[];
  /** How the set blocks were obtained, for the UI and the acceptance evidence. */
  setSource?: "moge-pointcloud" | "background-estimate";
};

/**
 * A shot that was deliberately not measured: no person detected (d3 people_count 0) or no
 * usable floor / foot point in the shot. The studio keeps the heuristic blockout and retries
 * nothing, so the skip is stored next to the cached geometries and reported per shot.
 */
export type ShotSkip = {shotIndex: number; reason: string};

export type AnalysisTimings = {
  hashMs: number;
  cutsMs: number;
  keyframesMs: number;
  decisionsMs: number;
  geometryMs: number;
  totalMs: number;
};

export type AnalysisCacheState = {
  hit: boolean;
  /** full = scoreYaml is the complete analysed score; partial = cuts/decisions cached, geometry missing. */
  stage: "full" | "partial" | "miss";
  storedAt?: string;
};

/** What stages the cache still misses; the studio keeps refining them in batches. */
export type PendingStages = {decisions: boolean; geometry: boolean};

/** The scan answer: everything the studio needs for first paint and for the refine batches. */
export type AnalysisScan = {
  contractVersion: number;
  cacheKey: string;
  clip: ClipFacts;
  params: AnalysisParams;
  shots: AnalysisShot[];
  statuses: ShotStatus[];
  decisions: ShotDecision[];
  /** The whole-clip scene description, when the vision pass has run ( TASK-A). */
  scene: SceneContext | null;
  geometries: ShotGeometry[];
  /** Shots that are deliberately not measured (no person / no floor); cached so they are not retried. */
  skips: ShotSkip[];
  /** Cached score (full hit) or the cut-only blockout built for first paint (miss). */
  scoreYaml: string;
  scoreHash: string;
  timings: AnalysisTimings;
  cache: AnalysisCacheState;
  pending: PendingStages;
};

export type GeometryBatchRequest = {cacheKey: string; shotIndices: number[]};

export type GeometryBatchResult = {
  cacheKey: string;
  geometries: ShotGeometry[];
  errors: Array<{shotIndex: number; message: string}>;
  timings: {batchMs: number; modelMs: number};
};

/** The studio writes its score back so the next identical run is a cache hit in under 100 ms. */
export type AnalysisCacheCommit = {
  cacheKey: string;
  decisions?: ShotDecision[];
  geometries?: ShotGeometry[];
  /** Shots deliberately left as blockout (no person / no floor); stored so the next run skips them. */
  skips?: ShotSkip[];
  scoreYaml: string;
  scoreHash: string;
  statuses: ShotStatus[];
  timings?: Partial<AnalysisTimings>;
};

export type AnalysisCacheCommitResult = {cacheKey: string; stored: boolean; scoreHash: string; complete: boolean};

/** Full-width proxy/frame sizes the server keeps for a clip; used by the geometry stage. */
export type AnalysisArtifacts = {
  /** 320 px proxy for decision frames, relative to the analysis cache directory. */
  decisionProxy: string;
  /** 640 px proxy for geometry stills and per-shot clips. */
  geometryProxy: string;
};

/* ── YouTube tab capture: the client keeps only keyframe stills, never a video file ── */

/** What the client captured from the embedded player; part of the YouTube cache key. */
export type AnalysisCaptureParams = {
  /** Sample rate of the cut scan in frames per second. */
  fps: number;
  /** Keyframes kept per shot (start/middle/end). */
  keyframes: number;
  /**
   * The analysed section of the source video in its own seconds (a YouTube link with t=). Shot times
   * stay relative to the section start; absent means the whole video from 0.
   */
  section?: {startSec: number; endSec: number};
};

/** One JPEG still of a captured shot: decision frame at 320 px or geometry still at 640 px. */
export type AnalysisFrameStill = {timeSec: number; role: KeyframeRole; dataUrl: string};

/** One captured shot: timestamps come from the player clock, frames are 320 px decision JPEGs. */
export type AnalysisFrameShot = {
  index: number;
  startSec: number;
  endSec: number;
  keyframes: ShotKeyframe[];
  /** 320 px JPEG data URLs aligned with keyframes, for the vision decisions. */
  frames: string[];
  /** 640 px JPEG stills for the geometry stage, one per keyframe. */
  stills: AnalysisFrameStill[];
};

/** The client's captured analysis input (no clip file, no download). `shots` is optional so a
 *  repeated analysis of the same videoId can ask for the cache hit without capturing again. */
export type AnalysisFrameScanRequest = {
  videoId: string;
  capture: AnalysisCaptureParams;
  clip: {durationSec: number; width: number; height: number; aspectRatio: number};
  shots?: AnalysisFrameShot[];
  params?: AnalysisParams;
};

/** Cache token for a YouTube analysis; the real clip key uses the uploaded file's SHA-256. */
export function youtubeClipToken(videoId: string): string {
  return `youtube:${videoId}`;
}

/** True when a cache token was produced by a YouTube tab capture rather than a file upload. */
export function isYoutubeClipToken(token: string): boolean {
  return token.startsWith("youtube:");
}

/**
 * Cache key for a YouTube analysis: videoId + capture parameters + model/pyramid versions. No clip
 * SHA is possible, so the token replaces it in the same slot; the file key format is unchanged.
 */
export function youtubeAnalysisCacheKey(videoId: string, capture: AnalysisCaptureParams, params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS): string {
  const {models, pyramid, version} = params;
  return [
    `contract${version}`,
    youtubeClipToken(videoId),
    models.decision,
    models.geometry,
    models.persons,
    `${pyramid.decisionWidth}x${pyramid.geometryWidth}`,
    `kf${pyramid.keyframesPerShot}`,
    `capture:${capture.fps}x${capture.keyframes}`,
    // A section is its own analysis: 10 s from 1:23 never answers for the whole video.
    ...(capture.section ? [`section:${capture.section.startSec}-${capture.section.endSec}`] : []),
  ].join("|");
}

export type ShotBatch = {indices: number[]; start: number};

/** Split shot indices into sequential batches of at most `size` (the decision route's image cap). */
export function shotBatches(count: number, size = 8): ShotBatch[] {
  const limit = Math.max(1, Math.floor(size));
  const batches: ShotBatch[] = [];
  for (let start = 0; start < count; start += limit) {
    batches.push({indices: Array.from({length: Math.min(limit, count - start)}, (_, offset) => start + offset), start});
  }
  return batches;
}
