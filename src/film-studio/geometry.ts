/*
 * Pure monocular-geometry math for the film studio's analysis stage.
 *
 * Input is the metric point cloud MoGe-2 wrote into a GLB, in OpenCV camera
 * space: +X right, +Y down, +Z forward, metres. Everything here is deterministic
 * (seeded RANSAC, least squares) and DOM/Node free, so the team server imports it
 * unchanged and test/geometry.test.ts can feed it synthetic camera scenes.
 *
 * Output conventions are the analysis contract's (see analysis-contract.ts):
 * - The floor plane is stored as a unit normal pointing away from the floor (up)
 *   plus offsetM, with the camera at the origin; camera height = offsetM.
 * - pitchDeg is positive when the real camera looks down.
 * - Positions are camera-relative metres on the floor: +xM right, +zM forward
 *   along the camera's optical axis, so a person in front of the camera has a
 *   positive zM and a person to the right a positive xM.
 */
import {lensMmFromHorizontalFov, type GeometryFloor, type SceneBlock} from "./analysis-contract";

export type Vec3 = [number, number, number];

export type CameraIntrinsics = {
  /** Focal length in pixels on the x axis, at `width`. */
  fxPx: number;
  /** Focal length in pixels on the y axis, at `height`. */
  fyPx: number;
  width: number;
  height: number;
};

/** The measured floor plane in camera coordinates (normal points up, away from the floor). */
export type FloorPlane = {
  normal: Vec3;
  /** Distance from the camera to the plane in metres (= camera height). */
  offsetM: number;
  inliers: number;
  /** Inlier ratio of the candidate point cloud, 0..1. */
  confidence: number;
  candidateCount: number;
  rmsM: number;
};

export type FloorOptions = {
  /** Inlier band around the plane in metres. */
  maxDistanceM?: number;
  iterations?: number;
  seed?: number;
  /** Reject a fit with fewer inliers than this. */
  minInliers?: number;
  /** Cap on candidate points (deterministic stride subsampling). */
  maxPoints?: number;
};

/** Horizontal-FOV fit from UV <-> camera-space vertices (least squares). */
export type FovFit = {
  horizontalFovDeg: number;
  verticalFovDeg: number;
  fxPx: number;
  fyPx: number;
  /** RMS reprojection residual in pixels (0 for an exact pinhole point map). */
  rmsPx: number;
  samples: number;
  squarePixels: boolean;
  confidence: number;
};

/** The measured camera approximation the studio's score camera is derived from. */
export type CameraMeasurement = {
  heightM: number;
  pitchDeg: number;
  /** Always 0: a monocular keyframe has no absolute yaw; positions carry the framing. */
  yawDeg: number;
  fovDeg: number;
  lensMm: number;
  confidence: number;
  basis: SceneBasis;
};

/** The camera-relative floor frame: up (floor normal), forward (camera axis on the floor) and right. */
export type SceneBasis = {up: Vec3; forward: Vec3; right: Vec3};

export type GroundPoint = {
  xM: number;
  zM: number;
  /** Straight-line floor distance from the camera in metres. */
  distanceM: number;
  /** The point in camera space (metres). */
  cameraPoint: Vec3;
};

export type PersonHeight = {rawM: number; heightM: number; plausible: boolean};

const EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < EPSILON) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** Deterministic PRNG (mulberry32): a seeded RANSAC is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pointAt = (points: Float32Array, index: number): Vec3 => [points[index * 3], points[index * 3 + 1], points[index * 3 + 2]];

/** Camera-space samples that can plausibly be part of a floor: in front of the camera, finite, not absurdly far. */
function floorCandidates(points: Float32Array, maxPoints: number): {indices: number[]; stride: number} {
  const total = Math.floor(points.length / 3);
  const indices: number[] = [];
  for (let index = 0; index < total; index++) {
    const x = points[index * 3];
    const y = points[index * 3 + 1];
    const z = points[index * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (z < 0.15 || z > 80 || Math.abs(x) > 80 || Math.abs(y) > 40) continue;
    indices.push(index);
  }
  const stride = Math.max(1, Math.ceil(indices.length / Math.max(1, maxPoints)));
  return {indices: stride > 1 ? indices.filter((_, order) => order % stride === 0) : indices, stride};
}

/** Plane through three points, oriented up and normalised; null for degenerate samples. */
function planeThrough(a: Vec3, b: Vec3, c: Vec3): {normal: Vec3; offsetM: number} | null {
  let normal = normalize(cross(sub(b, a), sub(c, a)));
  if (length(normal) < 0.5) return null;
  // A floor normal points up; in camera space "up" is -Y.
  if (normal[1] > 0) normal = scale(normal, -1);
  if (normal[1] > -0.5) return null; // steeper than 60 deg of camera pitch is not a floor
  const offsetM = -dot(normal, a);
  if (offsetM < 0.35 || offsetM > 9) return null; // camera height plausibility
  return {normal, offsetM};
}

function countInliers(points: Float32Array, indices: number[], normal: Vec3, offsetM: number, maxDistanceM: number): {count: number; squared: number; inliers: number[]} {
  const inliers: number[] = [];
  let squared = 0;
  for (const index of indices) {
    const residual = dot(normal, pointAt(points, index)) + offsetM;
    if (Math.abs(residual) <= maxDistanceM) {
      inliers.push(index);
      squared += residual * residual;
    }
  }
  return {count: inliers.length, squared, inliers};
}

/** Smallest-eigenvalue eigenvector of a symmetric 3x3 matrix (Jacobi rotations). */
function smallestEigenvector(matrix: number[][]): Vec3 {
  const a = matrix.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 12; sweep++) {
    let offDiagonal = 0;
    for (let row = 0; row < 3; row++) for (let column = row + 1; column < 3; column++) offDiagonal += a[row][column] * a[row][column];
    if (offDiagonal < 1e-18) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let index = 1; index < 3; index++) if (a[index][index] < a[best][best]) best = index;
  return normalize([v[0][best], v[1][best], v[2][best]]);
}

/** Least-squares refit of a plane through its inliers (PCA normal). */
function refinePlane(points: Float32Array, inliers: number[]): {normal: Vec3; offsetM: number} | null {
  if (inliers.length < 3) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const index of inliers) {
    cx += points[index * 3];
    cy += points[index * 3 + 1];
    cz += points[index * 3 + 2];
  }
  const count = inliers.length;
  cx /= count;
  cy /= count;
  cz /= count;
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const index of inliers) {
    const dx = points[index * 3] - cx;
    const dy = points[index * 3 + 1] - cy;
    const dz = points[index * 3 + 2] - cz;
    covariance[0][0] += dx * dx;
    covariance[0][1] += dx * dy;
    covariance[0][2] += dx * dz;
    covariance[1][1] += dy * dy;
    covariance[1][2] += dy * dz;
    covariance[2][2] += dz * dz;
  }
  covariance[1][0] = covariance[0][1];
  covariance[2][0] = covariance[0][2];
  covariance[2][1] = covariance[1][2];
  let normal = smallestEigenvector(covariance);
  if (length(normal) < 0.5) return null;
  if (normal[1] > 0) normal = scale(normal, -1);
  return {normal, offsetM: -(normal[0] * cx + normal[1] * cy + normal[2] * cz)};
}

/**
 * Deterministic RANSAC floor plane from camera-space points.
 * Returns null when no plausible, sufficiently supported floor is found.
 */
export function fitFloorPlane(points: Float32Array, options: FloorOptions = {}): FloorPlane | null {
  const maxDistanceM = options.maxDistanceM ?? 0.03;
  const iterations = options.iterations ?? 256;
  const seed = options.seed ?? 0x5eed1234;
  const minInliers = options.minInliers ?? 40;
  const {indices} = floorCandidates(points, options.maxPoints ?? 60_000);
  if (indices.length < Math.max(3, minInliers)) return null;
  const random = mulberry32(seed);
  let best: {normal: Vec3; offsetM: number; inliers: number[]; squared: number} | null = null;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const a = indices[Math.floor(random() * indices.length)];
    const b = indices[Math.floor(random() * indices.length)];
    const c = indices[Math.floor(random() * indices.length)];
    if (a === b || b === c || a === c) continue;
    const plane = planeThrough(pointAt(points, a), pointAt(points, b), pointAt(points, c));
    if (!plane) continue;
    const inlierInfo = countInliers(points, indices, plane.normal, plane.offsetM, maxDistanceM);
    if (!best || inlierInfo.count > best.inliers.length || (inlierInfo.count === best.inliers.length && inlierInfo.squared < best.squared)) {
      best = {...plane, inliers: inlierInfo.inliers, squared: inlierInfo.squared};
    }
  }
  if (!best || best.inliers.length < minInliers) return null;
  const refined = refinePlane(points, best.inliers) ?? {normal: best.normal, offsetM: best.offsetM};
  if (refined.normal[1] > -0.2 || refined.offsetM <= 0.2 || refined.offsetM > 9) return null;
  // Recount against the refined plane so inliers/confidence describe the returned plane.
  const final = countInliers(points, indices, refined.normal, refined.offsetM, maxDistanceM);
  if (final.count < minInliers) return null;
  return {
    normal: refined.normal,
    offsetM: refined.offsetM,
    inliers: final.count,
    confidence: clamp(final.count / indices.length, 0, 1),
    candidateCount: indices.length,
    rmsM: Math.sqrt(final.squared / Math.max(1, final.count)),
  };
}

/** A floor plane is only usable if it really is the floor: near-vertical up-normal, plausible camera height, enough support. */
export const FLOOR_MAX_TILT_DEG = 25;
export const FLOOR_MIN_HEIGHT_M = 0.6;
export const FLOOR_MAX_HEIGHT_M = 2.6;
export const FLOOR_MIN_INLIERS = 40;

export type FloorGateOptions = {
  maxTiltDeg?: number;
  minHeightM?: number;
  maxHeightM?: number;
  minInliers?: number;
};

/**
 * The plausibility gate for a fitted floor (: a shot without a usable floor
 * is not measured). A clothing/close-up plane passes RANSAC with a wildly tilted
 * normal and a short camera height; a wall passes with a horizontal normal. Both
 * must be rejected, or the studio gets a fabricated pitch.
 */
export type FloorVerdict = {
  ok: boolean;
  /** Angle between the floor up-normal and vertical, degrees (0 = a level floor). */
  tiltDeg: number;
  /** Why the floor is unusable; empty when ok. */
  reasons: string[];
};

export function floorPlausibility(
  floor: Pick<FloorPlane, "normal" | "offsetM" | "inliers">,
  options: FloorGateOptions = {},
): FloorVerdict {
  const maxTiltDeg = options.maxTiltDeg ?? FLOOR_MAX_TILT_DEG;
  const minHeightM = options.minHeightM ?? FLOOR_MIN_HEIGHT_M;
  const maxHeightM = options.maxHeightM ?? FLOOR_MAX_HEIGHT_M;
  const minInliers = options.minInliers ?? FLOOR_MIN_INLIERS;
  const normal = normalize(floor.normal);
  // Camera +Y is down, so the floor's up-normal should be close to (0, -1, 0).
  const tiltDeg = normal[1] === 0 && normal[0] === 0 && normal[2] === 0 ? 180 : (Math.acos(clamp(-normal[1], -1, 1)) * 180) / Math.PI;
  const reasons: string[] = [];
  if (!(tiltDeg <= maxTiltDeg)) reasons.push(`tilt ${tiltDeg.toFixed(1)} deg > ${maxTiltDeg} deg`);
  if (!(floor.offsetM >= minHeightM && floor.offsetM <= maxHeightM)) {
    reasons.push(`camera height ${floor.offsetM.toFixed(2)} m outside ${minHeightM}..${maxHeightM} m`);
  }
  if (!(floor.inliers >= minInliers)) reasons.push(`only ${floor.inliers} inliers < ${minInliers}`);
  return {ok: reasons.length === 0, tiltDeg, reasons};
}

/** The camera-relative floor frame used for xM/zM positions. */
export function sceneBasis(floor: Pick<FloorPlane, "normal">): SceneBasis {
  const up = normalize(floor.normal);
  const cameraForward: Vec3 = [0, 0, 1];
  let forward = normalize(sub(cameraForward, scale(up, dot(cameraForward, up))));
  if (length(forward) < 0.5) {
    // Camera pointing straight down/up: any consistent direction works, pick +Z.
    forward = normalize(sub([0, 0, 1], scale(up, dot([0, 0, 1], up)))) as Vec3;
    if (length(forward) < 0.5) forward = [1, 0, 0];
  }
  // Stage +x is the stage camera's LEFT: a camera looking along +z with +y up (three.js) has its
  // screen right at -x. So image right maps to -x; forward x up gave +x and mirrored every
  // reconstruction left to right (2026-11-13, test/stage-orientation.test.ts).
  const right = normalize(cross(up, forward));
  return {up, forward, right};
}

/** Camera height and pitch measured against the floor plane. */
export function cameraFromFloor(floor: Pick<FloorPlane, "normal" | "offsetM" | "confidence">): {heightM: number; pitchDeg: number; yawDeg: number; confidence: number} {
  const normal = normalize(floor.normal);
  return {
    heightM: floor.offsetM,
    // Level camera: normal (0,-1,0) -> 0 deg. Looking down tilts normal.z negative.
    pitchDeg: (Math.atan2(-normal[2], -normal[1]) * 180) / Math.PI,
    yawDeg: 0,
    confidence: clamp(floor.confidence, 0, 1),
  };
}

/**
 * Least-squares horizontal/vertical FOV from the mesh's UV <-> camera-space positions.
 * MoGe unprojects pixel centres with normalised intrinsics, so UVs reproduce the
 * pinhole model exactly and the fit is a robust way to recover the lens.
 */
export function fitFovFromUv(positions: Float32Array, uvs: Float32Array, width: number, height: number, options: {maxSamples?: number} = {}): FovFit | null {
  if (width < 2 || height < 2) return null;
  const vertexCount = Math.min(Math.floor(positions.length / 3), Math.floor(uvs.length / 2));
  if (vertexCount < 8) return null;
  const maxSamples = options.maxSamples ?? 80_000;
  const stride = Math.max(1, Math.ceil(vertexCount / maxSamples));
  let sumXX = 0;
  let sumUX = 0;
  let sumYY = 0;
  let sumVY = 0;
  let samples = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += stride) {
    const z = positions[vertex * 3 + 2];
    if (!(z > 0.1) || !Number.isFinite(z)) continue;
    const xn = positions[vertex * 3] / z;
    const yn = positions[vertex * 3 + 1] / z;
    if (!Number.isFinite(xn) || !Number.isFinite(yn)) continue;
    // Pixel centres: uv is per-pixel index / (size - 1).
    const uCenter = (uvs[vertex * 2] * (width - 1) + 0.5) / width - 0.5;
    const vCenter = (uvs[vertex * 2 + 1] * (height - 1) + 0.5) / height - 0.5;
    sumXX += xn * xn;
    sumUX += uCenter * xn;
    sumYY += yn * yn;
    sumVY += vCenter * yn;
    samples += 1;
  }
  if (samples < 8 || sumXX < EPSILON || sumYY < EPSILON) return null;
  // Least squares through the origin: uCenter = fxNorm * xn  ->  fxNorm = sum(uCenter*xn) / sum(xn^2).
  const fxNorm = sumUX / sumXX;
  const fyNorm = sumVY / sumYY;
  if (!(fxNorm > 0) || !(fyNorm > 0) || !Number.isFinite(fxNorm) || !Number.isFinite(fyNorm)) return null;
  const fxPx = fxNorm * width;
  const fyPx = fyNorm * height;
  const horizontalFovDeg = (2 * Math.atan(width / (2 * fxPx)) * 180) / Math.PI;
  const verticalFovDeg = (2 * Math.atan(height / (2 * fyPx)) * 180) / Math.PI;
  if (!(horizontalFovDeg > 3 && horizontalFovDeg < 175)) return null;
  // Residual check: for an exact point map the fit is exact; a poor fit means the
  // UVs do not correspond to this point cloud (wrong width/height or a corrupt mesh).
  let squaredResidual = 0;
  let checked = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += stride) {
    const z = positions[vertex * 3 + 2];
    if (!(z > 0.1) || !Number.isFinite(z)) continue;
    const expectedU = fxPx * (positions[vertex * 3] / z);
    const expectedV = fyPx * (positions[vertex * 3 + 1] / z);
    const uPx = uvs[vertex * 2] * (width - 1);
    const vPx = uvs[vertex * 2 + 1] * (height - 1);
    squaredResidual += (uPx - (width / 2 - 0.5) - expectedU) ** 2 + (vPx - (height / 2 - 0.5) - expectedV) ** 2;
    checked += 1;
  }
  const rmsPx = Math.sqrt(squaredResidual / Math.max(1, checked));
  const squarePixels = Math.abs(fxPx - fyPx) / Math.max(fxPx, fyPx) < 0.02;
  return {
    horizontalFovDeg,
    verticalFovDeg,
    fxPx,
    fyPx,
    rmsPx,
    samples,
    squarePixels,
    confidence: clamp(1 - rmsPx / 3, 0, 1) * (squarePixels ? 1 : 0.75),
  };
}

/** Combine the floor and lens measurements into the contract's camera approximation. */
export function measureCamera(floor: Pick<FloorPlane, "normal" | "offsetM" | "confidence">, fov: Pick<FovFit, "horizontalFovDeg" | "confidence"> | null): CameraMeasurement {
  const floorCamera = cameraFromFloor(floor);
  const fovDeg = fov ? Math.min(170, Math.max(5, fov.horizontalFovDeg)) : 60;
  const fovConfidence = fov ? clamp(fov.confidence, 0, 1) : 0.2;
  const basis = sceneBasis(floor);
  return {
    heightM: floorCamera.heightM,
    pitchDeg: floorCamera.pitchDeg,
    yawDeg: 0,
    fovDeg,
    lensMm: lensMmFromHorizontalFov(fovDeg),
    confidence: clamp(0.65 * floorCamera.confidence + 0.35 * fovConfidence, 0, 1),
    basis,
  };
}

/** The camera-space point of the floor directly below the camera: the origin of xM/zM. */
export function floorOriginCamera(floor: Pick<FloorPlane, "normal" | "offsetM">): Vec3 {
  const normal = normalize(floor.normal);
  // The camera is at the origin above the floor; -normal points at the floor.
  return scale(normal, -floor.offsetM);
}

/** Convert a floor position to camera space (the inverse of groundPointFromPixel). */
export function cameraPointFromScene(floor: Pick<FloorPlane, "normal" | "offsetM">, basis: SceneBasis, xM: number, zM: number): Vec3 {
  return add(add(floorOriginCamera(floor), scale(basis.right, xM)), scale(basis.forward, zM));
}

/** Project a camera-space point to pixel coordinates; null behind the camera. */
export function projectToPixel(intrinsics: CameraIntrinsics, point: Vec3): {px: number; py: number} | null {
  if (!(point[2] > 1e-4)) return null;
  return {
    px: intrinsics.width / 2 - 0.5 + (intrinsics.fxPx * point[0]) / point[2],
    py: intrinsics.height / 2 - 0.5 + (intrinsics.fyPx * point[1]) / point[2],
  };
}

/** Unit camera-space ray through a pixel. */
export function rayFromPixel(intrinsics: CameraIntrinsics, px: number, py: number): Vec3 {
  const direction: Vec3 = [(px - (intrinsics.width / 2 - 0.5)) / intrinsics.fxPx, (py - (intrinsics.height / 2 - 0.5)) / intrinsics.fyPx, 1];
  return normalize(direction);
}

/**
 * Where a pixel's ray meets the floor plane, in the camera-relative scene frame.
 * This is how a person's foot point becomes a metric root position.
 */
export function groundPointFromPixel(floor: Pick<FloorPlane, "normal" | "offsetM">, intrinsics: CameraIntrinsics, px: number, py: number): GroundPoint | null {
  const normal = normalize(floor.normal);
  const ray = rayFromPixel(intrinsics, px, py);
  const denominator = dot(normal, ray);
  if (Math.abs(denominator) < 1e-6) return null;
  const distance = -floor.offsetM / denominator;
  if (!(distance > 0)) return null;
  const cameraPoint = scale(ray, distance);
  const basis = sceneBasis(floor);
  const xM = dot(cameraPoint, basis.right);
  const zM = dot(cameraPoint, basis.forward);
  return {xM, zM, distanceM: Math.hypot(xM, zM), cameraPoint};
}

/**
 * Place a person's root on the floor from a head pixel and the ~1.7 m height prior.
 *
 * Used when the feet are outside the frame (walking-towards-camera shots): the mask
 * top is the head, so the ray through it reaches a point `priorHeightM` above the
 * floor; dropping that point straight down the floor normal gives the root. This is
 * the anchor explicitly allows; it is not a measurement of the height.
 */
export type HeadPriorGroundPoint = GroundPoint & {
  /** The head height above the floor that produced this root (the prior, or the camera-height fallback). */
  headHeightM: number;
  /** True when the prior was below the measured camera height and the ray pointed above the horizon. */
  usedCameraHeightFallback: boolean;
};

export function groundPointFromHeadPrior(
  floor: Pick<FloorPlane, "normal" | "offsetM">,
  intrinsics: CameraIntrinsics,
  headPixel: {px: number; py: number},
  priorHeightM: number,
): HeadPriorGroundPoint | null {
  if (!(priorHeightM > 0)) return null;
  const normal = normalize(floor.normal);
  const ray = rayFromPixel(intrinsics, headPixel.px, headPixel.py);
  const denominator = dot(normal, ray);
  if (Math.abs(denominator) < 1e-6) return null;
  const rootAtHeadHeight = (headHeightM: number): HeadPriorGroundPoint | null => {
    // Height above the floor of a point t*ray is n.(t*ray) + offsetM.
    const distance = (headHeightM - floor.offsetM) / denominator;
    if (!(distance > 0)) return null;
    const headPoint = scale(ray, distance);
    const root = sub(headPoint, scale(normal, headHeightM));
    const basis = sceneBasis(floor);
    const xM = dot(root, basis.right);
    const zM = dot(root, basis.forward);
    return {xM, zM, distanceM: Math.hypot(xM, zM), cameraPoint: root, headHeightM, usedCameraHeightFallback: false};
  };
  const withPrior = rootAtHeadHeight(priorHeightM);
  if (withPrior) return withPrior;
  // MoGe's metric scale can overestimate the camera height: if the head pixel is above the
  // horizon the head must be above the camera eye level, so a floor prior below the measured
  // camera height has no solution. Fall back to "head just above camera eye level", which
  // keeps a person-rooted shot measurable instead of silently skipping it.
  const fallbackHeadHeightM = floor.offsetM + Math.max(0.1, priorHeightM * 0.1);
  const withFallback = rootAtHeadHeight(fallbackHeadHeightM);
  if (!withFallback) return null;
  return {...withFallback, usedCameraHeightFallback: true};
}

/** The ~1.7 m person scale anchor used when a keyframe cannot measure the height. */
export const PERSON_HEIGHT_PRIOR_M = 1.75;

/**
 * How high the mask top is above the floor for a person standing at (xM, zM):
 * find the height along the floor normal whose projection lands on the mask top.
 */
export function personHeightFromMaskTop(
  floor: Pick<FloorPlane, "normal" | "offsetM">,
  intrinsics: CameraIntrinsics,
  root: {xM: number; zM: number},
  topPixel: {px: number; py: number},
  options: {minM?: number; maxM?: number; stepM?: number} = {},
): number | null {
  const basis = sceneBasis(floor);
  const rootPoint = cameraPointFromScene(floor, basis, root.xM, root.zM);
  const minM = options.minM ?? 0.4;
  const maxM = options.maxM ?? 2.6;
  const stepM = options.stepM ?? 0.005;
  let bestHeight = Number.NaN;
  let bestSquared = Number.POSITIVE_INFINITY;
  for (let height = minM; height <= maxM + EPSILON; height += stepM) {
    const projected = projectToPixel(intrinsics, add(rootPoint, scale(basis.up, height)));
    if (!projected) continue;
    const squared = (projected.px - topPixel.px) ** 2 + (projected.py - topPixel.py) ** 2;
    if (squared < bestSquared) {
      bestSquared = squared;
      bestHeight = height;
    }
  }
  return Number.isFinite(bestHeight) ? bestHeight : null;
}

/** The ~1.7 m person-height sanity anchor: report the raw value, clamp only outside 1.2..2.1 m. */
/**
 * The people as the ruler of a shot (Phase 3, LATER-2240). MoGe's metric depth can be off by a
 * large factor (a grey CG render measured a 1.75 m figure as 0.62 m). When the measured people
 * agree that the whole scene is too small or too large - their median raw height outside the
 * plausible band - every length of the shot (floor offset, camera height, positions, set) is
 * scaled by prior / median, so the person comes out 1.75 m and the place keeps its proportions.
 * Inside the band, or without a measured person, the scene stays as measured (1). Pure.
 */
export function peopleScale(rawHeightsM: readonly (number | null | undefined)[], bounds: {minM?: number; maxM?: number} = {}): number {
  const heights = rawHeightsM.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0.05).sort((a, b) => a - b);
  if (!heights.length) return 1;
  const middle = heights.length / 2;
  const median = heights.length % 2 ? heights[Math.floor(middle)] : (heights[middle - 1] + heights[middle]) / 2;
  if (plausiblePersonHeight(median, bounds).plausible) return 1;
  // A factor beyond 6 is not a scale error any more but a wrong detection; keep the measurement.
  const factor = PERSON_HEIGHT_PRIOR_M / median;
  return factor > 1 / 6 && factor < 6 ? factor : 1;
}

export function plausiblePersonHeight(rawM: number, bounds: {minM?: number; maxM?: number} = {}): PersonHeight {
  const minM = bounds.minM ?? 1.2;
  const maxM = bounds.maxM ?? 2.1;
  const finite = Number.isFinite(rawM) ? rawM : 0;
  return {rawM: finite, heightM: clamp(finite, minM, maxM), plausible: finite >= minM && finite <= maxM};
}

/** Real-world size of the anchors used by the estimated (no-floor) geometry. */
export const PERSON_HEIGHT_ANCHOR_M = 1.75;
/** A human head is ~1/7.5 of the body height (used when only head + shoulders are visible). */
export const HEAD_HEIGHT_ANCHOR_M = PERSON_HEIGHT_ANCHOR_M / 7.5;
/** Head width in metres (~0.15 m), used when only the head width is anchorable (very close face). */
export const HEAD_WIDTH_ANCHOR_M = 0.15;
/** Eye level as a fraction of body height, for the estimated camera height. */
export const EYE_LEVEL_RATIO = 0.93;

/**
 * Distance to a subject of known real size from its apparent size in pixels:
 * d = fxPx * anchorM / anchorPx (pinhole, small-angle assumption).
 */
export function distanceFromAnchorSize(fxPx: number, anchorM: number, anchorPx: number): number | null {
  if (!(fxPx > 0) || !(anchorM > 0) || !(anchorPx > 0)) return null;
  const distanceM = (fxPx * anchorM) / anchorPx;
  if (!Number.isFinite(distanceM) || distanceM < 0.15 || distanceM > 250) return null;
  return distanceM;
}

/** Eye height of a standing person: the estimated camera height when no floor is measurable. */
export function eyeLevelCameraHeightM(personHeightM = PERSON_HEIGHT_ANCHOR_M): number {
  return EYE_LEVEL_RATIO * personHeightM;
}

export type EstimatedRoot = {xM: number; zM: number; bearingRad: number};

/**
 * The root of a person at a known distance from the camera, from their mask centre pixel:
 * the pixel's x bearing through the pinhole camera gives the lateral offset.
 */
export function rootFromAnchorBearing(input: {fxPx: number; centroidPx: number; imageWidth: number; distanceM: number}): EstimatedRoot | null {
  if (!(input.fxPx > 0) || !(input.imageWidth > 2) || !(input.distanceM > 0)) return null;
  // tan(bearing) = (x - cx) / fx, with the pixel-centre convention used everywhere else.
  const tanBearing = (input.centroidPx - (input.imageWidth / 2 - 0.5)) / input.fxPx;
  const bearingRad = Math.atan(tanBearing);
  // Image right is stage -x (the stage camera looks along +z; see sceneBasis).
  return {xM: -input.distanceM * Math.sin(bearingRad), zM: input.distanceM * Math.cos(bearingRad), bearingRad};
}

/** A synthetic level floor for the estimated geometry: the schema needs a floor, nothing was fitted. */
export function syntheticLevelFloor(cameraHeightM: number): FloorPlane {
  return {normal: [0, -1, 0], offsetM: cameraHeightM, inliers: 0, confidence: 0, candidateCount: 0, rmsM: 0};
}
/** Camera-space point (OpenCV: +X right, +Y down, +Z forward) -> stage coordinates (floor y=0). */
export function stagePointFromCamera(floor: Pick<FloorPlane, "normal" | "offsetM">, basis: SceneBasis, cameraPoint: Vec3): Vec3 {
  const normal = normalize(floor.normal);
  // Relative to the floor origin below the camera; the camera sits offsetM above it.
  const relative = add(cameraPoint, scale(normal, floor.offsetM));
  return [dot(relative, basis.right), dot(relative, basis.up), dot(relative, basis.forward)];
}

export type SceneVoxelOptions = {
  /** Voxel edge in metres (0.5 default; 0.25 for short-range shots). */
  voxelSizeM?: number;
  /** Cells with fewer points than this are dropped (15 default). */
  minPointsPerCell?: number;
  /** Hard cap on returned blocks (200 default, contract allows 260). */
  maxBlocks?: number;
  /** Plausibility bounds in stage metres. */
  yMinM?: number;
  yMaxM?: number;
  zMinM?: number;
  zMaxM?: number;
  xMaxAbsM?: number;
  /** Stage-space person roots: blocks covering a person (0.4 m clearance, 0..2.2 m) are dropped. */
  personRoots?: Array<{xM: number; zM: number}>;
  personClearanceM?: number;
  /** Blocks farther than this z are labelled "background". */
  subjectDistanceM?: number;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Voxelize stage-space points into the coarse "set blocks" the studio draws: 0.5 m cells,
 * x-runs merged, then z-runs merged, implausible cells dropped, person footprints cleared,
 * capped and sorted deterministically. Pure: the same points always give the same blocks.
 */
export function voxelizeStagePoints(points: ArrayLike<number>, options: SceneVoxelOptions = {}): SceneBlock[] {
  const voxel = Math.max(0.1, options.voxelSizeM ?? 0.5);
  const minPoints = Math.max(1, Math.round(options.minPointsPerCell ?? 15));
  const maxBlocks = Math.max(1, Math.round(options.maxBlocks ?? 200));
  const yMin = options.yMinM ?? -0.4;
  const yMax = options.yMaxM ?? 4;
  const zMin = options.zMinM ?? 0.3;
  const zMax = options.zMaxM ?? 30;
  const xMax = options.xMaxAbsM ?? 25;
  type Cell = {ix: number; iy: number; iz: number; count: number};
  const cells = new Map<string, Cell>();
  const count = Math.floor(points.length / 3);
  for (let index = 0; index < count; index++) {
    const x = points[index * 3];
    const y = points[index * 3 + 1];
    const z = points[index * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (y < yMin || y > yMax || z < zMin || z > zMax || Math.abs(x) > xMax) continue;
    const ix = Math.floor(x / voxel);
    const iy = Math.floor(y / voxel);
    const iz = Math.floor(z / voxel);
    const key = `${ix}|${iy}|${iz}`;
    const cell = cells.get(key);
    if (cell) cell.count += 1;
    else cells.set(key, {ix, iy, iz, count: 1});
  }
  if (cells.size === 0) return [];
  // 1. Merge runs along x (same y/z row).
  type Box = {ix0: number; ix1: number; iy: number; iz0: number; iz1: number; count: number};
  const rows = new Map<string, Cell[]>();
  for (const cell of cells.values()) {
    if (cell.count < minPoints) continue;
    const key = `${cell.iy}|${cell.iz}`;
    const row = rows.get(key);
    if (row) row.push(cell);
    else rows.set(key, [cell]);
  }
  const xBoxes: Box[] = [];
  for (const row of rows.values()) {
    row.sort((left, right) => left.ix - right.ix);
    let start = row[0];
    let previous = row[0];
    let total = row[0].count;
    const flush = () => xBoxes.push({ix0: start.ix, ix1: previous.ix, iy: start.iy, iz0: start.iz, iz1: start.iz, count: total});
    for (let index = 1; index < row.length; index++) {
      const cell = row[index];
      if (cell.ix === previous.ix + 1) {
        previous = cell;
        total += cell.count;
        continue;
      }
      flush();
      start = cell;
      previous = cell;
      total = cell.count;
    }
    flush();
  }
  // 2. Merge runs along z (same y and same x span).
  const zGroups = new Map<string, Box[]>();
  for (const box of xBoxes) {
    const key = `${box.iy}|${box.ix0}|${box.ix1}`;
    const group = zGroups.get(key);
    if (group) group.push(box);
    else zGroups.set(key, [box]);
  }
  const merged: Box[] = [];
  for (const group of zGroups.values()) {
    group.sort((left, right) => left.iz0 - right.iz0);
    let current = {...group[0]};
    for (let index = 1; index < group.length; index++) {
      const box = group[index];
      if (box.iz0 <= current.iz1 + 1) {
        current.iz1 = Math.max(current.iz1, box.iz1);
        current.count += box.count;
      } else {
        merged.push(current);
        current = {...box};
      }
    }
    merged.push(current);
  }
  // 2b. Merge runs along y (same x and z span): a wall becomes one column, not a stack of slabs,
  //     so the block budget covers the whole set instead of a few layers of it.
  type Column = {ix0: number; ix1: number; iy0: number; iy1: number; iz0: number; iz1: number; count: number};
  const yGroups = new Map<string, Box[]>();
  for (const box of merged) {
    const key = `${box.ix0}|${box.ix1}|${box.iz0}|${box.iz1}`;
    const group = yGroups.get(key);
    if (group) group.push(box);
    else yGroups.set(key, [box]);
  }
  const columns: Column[] = [];
  for (const group of yGroups.values()) {
    group.sort((left, right) => left.iy - right.iy);
    let current: Column = {ix0: group[0].ix0, ix1: group[0].ix1, iy0: group[0].iy, iy1: group[0].iy, iz0: group[0].iz0, iz1: group[0].iz1, count: group[0].count};
    for (let index = 1; index < group.length; index++) {
      const box = group[index];
      if (box.iy === current.iy1 + 1) {
        current.iy1 = box.iy;
        current.count += box.count;
      } else {
        columns.push(current);
        current = {ix0: box.ix0, ix1: box.ix1, iy0: box.iy, iy1: box.iy, iz0: box.iz0, iz1: box.iz1, count: box.count};
      }
    }
    columns.push(current);
  }
  // 3. Blocks, with person clearance and labels.
  const clearance = Math.max(0, options.personClearanceM ?? 0.4);
  const blocks: Array<SceneBlock & {pointCount: number}> = [];
  for (const box of columns) {
    const sizeX = (box.ix1 - box.ix0 + 1) * voxel;
    const sizeY = (box.iy1 - box.iy0 + 1) * voxel;
    const sizeZ = (box.iz1 - box.iz0 + 1) * voxel;
    const centre: [number, number, number] = [
      (box.ix0 + (box.ix1 - box.ix0 + 1) / 2) * voxel,
      box.iy0 * voxel + sizeY / 2,
      (box.iz0 + (box.iz1 - box.iz0 + 1) / 2) * voxel,
    ];
    const boxY0 = box.iy0 * voxel;
    const boxY1 = boxY0 + sizeY;
    const coversPerson = (options.personRoots ?? []).some((root) => {
      if (!(boxY1 > 0 && boxY0 < 2.2)) return false;
      const reach = clearance + Math.max(sizeX, sizeZ) / 2;
      return Math.hypot(centre[0] - root.xM, centre[2] - root.zM) < reach;
    });
    if (coversPerson) continue;
    let kind: NonNullable<SceneBlock["kind"]> = "object";
    if (centre[1] - sizeY / 2 <= 0.3 && sizeY <= 0.6) kind = "ground";
    else if (sizeY >= 1.2 && sizeY > Math.max(sizeX, sizeZ)) kind = "wall";
    else if (options.subjectDistanceM !== undefined && centre[2] > options.subjectDistanceM + 0.5) kind = "background";
    blocks.push({
      xM: round2(centre[0]),
      yM: round2(centre[1]),
      zM: round2(centre[2]),
      sizeX: round2(sizeX),
      sizeY: round2(sizeY),
      sizeZ: round2(sizeZ),
      kind,
      pointCount: box.count,
    });
  }
  // 4. Cap: keep the blocks closest to the camera carrying the most points.
  blocks.sort((left, right) => right.pointCount / (1 + right.zM) - left.pointCount / (1 + left.zM));
  const kept = blocks.slice(0, maxBlocks);
  kept.sort((left, right) => left.zM - right.zM || left.xM - right.xM || left.yM - right.yM);
  return kept.map(({pointCount: _pointCount, ...block}) => block);
}

/** Depth bands of the rebuilt set: fine cells near the camera, coarser ones far away. */
export const SET_DEPTH_BANDS: ReadonlyArray<{zMinM: number; zMaxM: number; voxelSizeM: number; maxBlocks: number}> = [
  {zMinM: 0.3, zMaxM: 4, voxelSizeM: 0.12, maxBlocks: 260},
  {zMinM: 4, zMaxM: 10, voxelSizeM: 0.25, maxBlocks: 200},
  {zMinM: 10, zMaxM: 30, voxelSizeM: 0.5, maxBlocks: 140},
];
/** Upper bound of a shot's set over all bands (the contract allows this many blocks). */
export const MAX_SET_BLOCKS = SET_DEPTH_BANDS.reduce((total, band) => total + band.maxBlocks, 0);

/**
 * The rebuilt set of one shot: the stage points voxelized per depth band (a cell covers a
 * similar image area in every band, so near furniture keeps its shape and the far background
 * does not eat the block budget), then concatenated in camera-distance order. Pure.
 */
export function voxelizeSetBands(points: ArrayLike<number>, options: Omit<SceneVoxelOptions, "voxelSizeM" | "maxBlocks" | "zMinM" | "zMaxM"> = {}): SceneBlock[] {
  const blocks: SceneBlock[] = [];
  for (const band of SET_DEPTH_BANDS) {
    blocks.push(...voxelizeStagePoints(points, {...options, voxelSizeM: band.voxelSizeM, maxBlocks: band.maxBlocks, zMinM: band.zMinM, zMaxM: band.zMaxM}));
  }
  return blocks;
}

/**
 * A level floor tilted by the camera pitch, for a shot whose floor could not be fitted: the set
 * points are then placed for a camera at `cameraHeightM` looking `pitchDeg` down (positive) or up.
 * The inverse of cameraFromFloor's pitch: normal (0, -cos p, -sin p).
 */
export function pitchedLevelFloor(cameraHeightM: number, pitchDeg: number): FloorPlane {
  const pitch = (pitchDeg * Math.PI) / 180;
  return {normal: [0, -Math.cos(pitch), -Math.sin(pitch)], offsetM: cameraHeightM, inliers: 0, confidence: 0, candidateCount: 0, rmsM: 0};
}

/**
 * The estimated backdrop for a no-floor close-up: a wall strictly BEHIND the subject (never in
 * front of or at the camera) plus a thin near-camera floor strip.
 *
 * Wall: front face at subjectDistanceM + WALL_GAP (0.4..0.8 m, at least +0.2 m), depth
 * 0.3..0.5 m, width from the horizontal FOV at that depth, height 2.6..2.8 m spanning y 0..2.8.
 * Floor strip: 0.02 m thick, z from 0.3 m to the subject distance (it may come near the camera).
 * No block intersects the camera zone (z < 0.3 m or |x| < 0.2 m right at the camera), no wall
 * block sits between camera and subject, and wall blocks overlapping a person root (0.3 m in
 * x/z) are dropped.
 */
export function estimatedBackdropBlocks(input: {
  subjectDistanceM: number;
  horizontalFovDeg: number;
  cameraHeightM: number;
  personRoots?: Array<{xM: number; zM: number}>;
  maxBlocks?: number;
}): SceneBlock[] {
  const distance = Math.max(0.6, input.subjectDistanceM);
  const halfTan = Math.tan((Math.min(170, Math.max(5, input.horizontalFovDeg)) * Math.PI) / 360);
  const wallGap = Math.min(0.8, Math.max(0.4, 0.4 + distance * 0.05));
  const wallDepth = 0.4;
  const wallFrontZ = distance + wallGap;
  const wallCentreZ = wallFrontZ + wallDepth / 2;
  // Width taken at the wall depth (+ margin) so the wall always covers the whole FOV behind the subject.
  const width = Math.max(1.2, 2 * halfTan * (wallFrontZ + 0.5));
  const wallHeight = 2.8;
  const columns = 4;
  const rows = 3;
  const clearance = 0.3;
  const personRoots = input.personRoots ?? [];
  const overlapsPerson = (xMin: number, xMax: number, zMin: number, zMax: number): boolean =>
    personRoots.some((root) => root.xM + clearance > xMin && root.xM - clearance < xMax && root.zM + clearance > zMin && root.zM - clearance < zMax);
  const blocks: SceneBlock[] = [];
  const columnWidth = width / columns;
  const rowHeight = wallHeight / rows;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const xM = -width / 2 + columnWidth / 2 + column * columnWidth;
      if (overlapsPerson(xM - columnWidth / 2, xM + columnWidth / 2, wallCentreZ - wallDepth / 2, wallCentreZ + wallDepth / 2)) continue;
      blocks.push({
        xM: round2(xM),
        yM: round2(rowHeight / 2 + row * rowHeight),
        zM: round2(wallCentreZ),
        sizeX: round2(columnWidth),
        sizeY: round2(rowHeight),
        sizeZ: round2(wallDepth),
        kind: "background",
      });
    }
  }
  // A THIN floor strip from just in front of the camera (z >= 0.3) up to the subject distance.
  const stripSegments = 3;
  const stripStartZ = 0.3;
  const stripEndZ = Math.max(stripStartZ + 0.1, Math.min(distance, wallFrontZ - 0.2));
  const stripLength = (stripEndZ - stripStartZ) / stripSegments;
  for (let index = 0; index < stripSegments; index++) {
    const zMin = round2(stripStartZ + index * stripLength);
    const zMax = round2(zMin + stripLength);
    const zMid = (zMin + zMax) / 2;
    const stripWidth = Math.max(0.4, 2 * halfTan * zMid);
    const xM = 0;
    // Only the wall's blocks and this thin floor strip may be near the camera; keep the floor flat.
    if (overlapsPerson(xM - stripWidth / 2, xM + stripWidth / 2, zMin, zMax)) continue;
    blocks.push({
      xM,
      yM: 0.01,
      zM: round2(zMid),
      sizeX: round2(stripWidth),
      sizeY: 0.02,
      sizeZ: round2(zMax - zMin),
      kind: "ground",
    });
  }
  void input.cameraHeightM;
  const cap = Math.max(1, Math.round(input.maxBlocks ?? 200));
  return blocks.slice(0, cap);
}
/** Convert a measured floor + lens pair into the shared contract's floor value. */
export function toContractFloor(floor: FloorPlane): GeometryFloor {
  return {normal: [...floor.normal] as [number, number, number], offsetM: floor.offsetM, inliers: floor.inliers, confidence: floor.confidence};
}

export const VERTICAL_PERSON_HEIGHT_M = 1.75;

/** Eigenvector of the smallest eigenvalue of a symmetric n x n matrix (cyclic Jacobi). */
function smallestEigenvectorN(matrix: number[][]): number[] {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (a[i][i] < a[best][best]) best = i;
  return v.map((row) => row[best]);
}

/** Where a camera stood and where it looked, in the frame of the points it saw. */
export type PixelCamera = {center: Vec3; forward: Vec3};

/**
 * Recover a camera from pixel <-> point pairs of one view (, DA3 multiview meshes: every
 * vertex is a pixel unprojected into the shared world frame). Direct linear transform on
 * normalised coordinates; the centre is the null space of the projection and the viewing
 * direction its third row, both unaffected by how the pixel axes are scaled or flipped.
 */
export function cameraFromPixelPoints(points: ArrayLike<number>, pixels: ArrayLike<number>, options: {maxPairs?: number} = {}): PixelCamera | null {
  const total = Math.min(Math.floor(points.length / 3), Math.floor(pixels.length / 2));
  const pairs: Array<[number, number, number, number, number]> = [];
  const stride = Math.max(1, Math.ceil(total / (options.maxPairs ?? 4000)));
  for (let index = 0; index < total; index += stride) {
    const x = points[index * 3];
    const y = points[index * 3 + 1];
    const z = points[index * 3 + 2];
    const u = pixels[index * 2];
    const w = pixels[index * 2 + 1];
    if ([x, y, z, u, w].every(Number.isFinite)) pairs.push([x, y, z, u, w]);
  }
  if (pairs.length < 12) return null;
  const mean = [0, 0, 0, 0, 0];
  for (const pair of pairs) for (let k = 0; k < 5; k++) mean[k] += pair[k] / pairs.length;
  let spread = 0;
  let pixelSpread = 0;
  for (const pair of pairs) {
    spread += Math.hypot(pair[0] - mean[0], pair[1] - mean[1], pair[2] - mean[2]) / pairs.length;
    pixelSpread += Math.hypot(pair[3] - mean[3], pair[4] - mean[4]) / pairs.length;
  }
  if (!(spread > 1e-9) || !(pixelSpread > 1e-9)) return null;
  const ata = Array.from({length: 12}, () => new Array<number>(12).fill(0));
  const accumulate = (row: number[]) => {
    for (let i = 0; i < 12; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < 12; j++) ata[i][j] += row[i] * row[j];
    }
  };
  for (const pair of pairs) {
    const X = (pair[0] - mean[0]) / spread;
    const Y = (pair[1] - mean[1]) / spread;
    const Z = (pair[2] - mean[2]) / spread;
    const u = (pair[3] - mean[3]) / pixelSpread;
    const v = (pair[4] - mean[4]) / pixelSpread;
    accumulate([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z, -u]);
    accumulate([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z, -v]);
  }
  const p = smallestEigenvectorN(ata);
  const m = [
    [p[0], p[1], p[2]],
    [p[4], p[5], p[6]],
    [p[8], p[9], p[10]],
  ];
  const t = [p[3], p[7], p[11]];
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-15) return null;
  // C = -M^-1 t (Cramer's rule).
  const solve = (column: number) => {
    const copy = m.map((row) => [...row]);
    for (let r = 0; r < 3; r++) copy[r][column] = -t[r];
    return (copy[0][0] * (copy[1][1] * copy[2][2] - copy[1][2] * copy[2][1]) - copy[0][1] * (copy[1][0] * copy[2][2] - copy[1][2] * copy[2][0]) + copy[0][2] * (copy[1][0] * copy[2][1] - copy[1][1] * copy[2][0])) / det;
  };
  const centerNormalized: Vec3 = [solve(0), solve(1), solve(2)];
  const center: Vec3 = [mean[0] + spread * centerNormalized[0], mean[1] + spread * centerNormalized[1], mean[2] + spread * centerNormalized[2]];
  let forward = normalize([m[2][0], m[2][1], m[2][2]]);
  // The seen points lie in front of the camera.
  let ahead = 0;
  for (const pair of pairs) ahead += Math.sign((pair[0] - center[0]) * forward[0] + (pair[1] - center[1]) * forward[1] + (pair[2] - center[2]) * forward[2]);
  if (ahead < 0) forward = scale(forward, -1);
  return {center, forward};
}

/** Move one stage point from a keyframe camera frame into the anchor frame: world = R(yawRad) * scale * point + (txM, 0, tzM). */
export function registeredStagePoint(registration: {yawRad: number; txM: number; tzM: number; scale?: number}, point: Vec3): Vec3 {
  const cos = Math.cos(registration.yawRad);
  const sin = Math.sin(registration.yawRad);
  const scale = registration.scale ?? 1;
  const x = point[0] * scale;
  const z = point[2] * scale;
  return [x * cos + z * sin + registration.txM, point[1] * scale, -x * sin + z * cos + registration.tzM];
}

/**
 * Metric scale of one depth map against another of the same view (: DA3 multiview depth is
 * relative, MoGe is metric): both meshes are binned by their UVs, and the median ratio of the
 * per-cell median camera distance is the factor that turns `other` lengths into `reference`
 * lengths. The UV v axis is tried both ways; the tighter ratio spread wins. Null when too few
 * cells overlap.
 */
export function depthScaleBetween(
  reference: {points: ArrayLike<number>; uvs: ArrayLike<number>},
  other: {points: ArrayLike<number>; uvs: ArrayLike<number>},
  options: {cellsX?: number; cellsY?: number} = {},
): {scale: number; spread: number; cells: number} | null {
  const cellsX = options.cellsX ?? 48;
  const cellsY = options.cellsY ?? 27;
  const binned = (mesh: {points: ArrayLike<number>; uvs: ArrayLike<number>}, flipV: boolean) => {
    const bins = new Map<number, number[]>();
    const count = Math.min(Math.floor(mesh.points.length / 3), Math.floor(mesh.uvs.length / 2));
    for (let index = 0; index < count; index++) {
      const u = mesh.uvs[index * 2];
      const rawV = mesh.uvs[index * 2 + 1];
      const v = flipV ? 1 - rawV : rawV;
      const distance = Math.hypot(mesh.points[index * 3], mesh.points[index * 3 + 1], mesh.points[index * 3 + 2]);
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(distance) || distance <= 0) continue;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const key = Math.floor(v * cellsY) * cellsX + Math.floor(u * cellsX);
      const list = bins.get(key);
      if (list) list.push(distance);
      else bins.set(key, [distance]);
    }
    const medians = new Map<number, number>();
    for (const [key, list] of bins) {
      list.sort((left, right) => left - right);
      medians.set(key, list[Math.floor(list.length / 2)]);
    }
    return medians;
  };
  const ref = binned(reference, false);
  let best: {scale: number; spread: number; cells: number} | null = null;
  for (const flip of [false, true]) {
    const oth = binned(other, flip);
    const ratios: number[] = [];
    for (const [key, distance] of ref) {
      const matched = oth.get(key);
      if (matched) ratios.push(Math.log(distance / matched));
    }
    if (ratios.length < 20) continue;
    ratios.sort((left, right) => left - right);
    const median = ratios[Math.floor(ratios.length / 2)];
    const deviations = ratios.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
    const spread = deviations[Math.floor(deviations.length / 2)];
    if (!best || spread < best.spread) best = {scale: Math.exp(median), spread, cells: ratios.length};
  }
  return best;
}

export type SetShapeOptions = {
  /** Grid cell of the occupancy the parts are found on (0.25 m). */
  cellM?: number;
  /** Points above the floor that count; the floor itself is drawn by the stage. */
  minHeightM?: number;
  yMaxM?: number;
  zMinM?: number;
  zMaxM?: number;
  xMaxAbsM?: number;
  maxShapes?: number;
  personRoots?: Array<{xM: number; zM: number}>;
  personClearanceM?: number;
  subjectDistanceM?: number;
};

type ShapeCell = {ix: number; iy: number; iz: number; count: number; sumX: number; sumZ: number};

/** Kasa circle fit on floor-plane points: centre, radius and the RMS of the radial residual. */
function fitCircle(points: ReadonlyArray<[number, number]>): {cx: number; cz: number; radius: number; rms: number} | null {
  if (points.length < 6) return null;
  let mx = 0;
  let mz = 0;
  for (const [x, z] of points) {
    mx += x / points.length;
    mz += z / points.length;
  }
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const [x, z] of points) {
    const u = x - mx;
    const v = z - mz;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const bu = (suuu + suvv) / 2;
  const bv = (svvv + svuu) / 2;
  const uc = (bu * svv - bv * suv) / det;
  const vc = (bv * suu - bu * suv) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / points.length);
  const cx = mx + uc;
  const cz = mz + vc;
  let squared = 0;
  for (const [x, z] of points) squared += (Math.hypot(x - cx, z - cz) - radius) ** 2;
  return {cx, cz, radius, rms: Math.sqrt(squared / points.length)};
}

/** RMS distance of points to their total-least-squares line. */
function lineRms(points: ReadonlyArray<[number, number]>): number {
  if (points.length < 2) return 0;
  let mx = 0;
  let mz = 0;
  for (const [x, z] of points) {
    mx += x / points.length;
    mz += z / points.length;
  }
  let cxx = 0;
  let czz = 0;
  let cxz = 0;
  for (const [x, z] of points) {
    cxx += (x - mx) ** 2;
    czz += (z - mz) ** 2;
    cxz += (x - mx) * (z - mz);
  }
  const trace = cxx + czz;
  const smallest = trace / 2 - Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz);
  return Math.sqrt(Math.max(0, smallest) / points.length);
}

/** Best fit of a footprint as two straight runs (a corner), split along the given order. */
function twoLineRms(ordered: ReadonlyArray<[number, number]>): number {
  let best = Infinity;
  for (let split = 3; split <= ordered.length - 3; split++) {
    const left = ordered.slice(0, split);
    const right = ordered.slice(split);
    const rms = Math.sqrt((lineRms(left) ** 2 * left.length + lineRms(right) ** 2 * right.length) / ordered.length);
    best = Math.min(best, rms);
  }
  return best;
}

/**
 * The rebuilt set as smooth shapes: occupied cells of the stage points above the floor
 * are grouped into connected parts; each part becomes an upright cylinder when its footprint lies
 * on a circle arc (a tank seen from the front), otherwise an oriented box along its main floor axis.
 * A part whose box would be mostly empty (an L of two walls, a railing around a roof) is split at
 * the median of its longest side and fitted again. Pure; stage metres, floor at y = 0.
 */
export function fitSetShapes(points: ArrayLike<number>, options: SetShapeOptions = {}): SceneBlock[] {
  const cell = Math.max(0.1, options.cellM ?? 0.25);
  const minHeight = options.minHeightM ?? 0.1;
  const yMax = options.yMaxM ?? 12;
  const zMin = options.zMinM ?? 0.3;
  const zMax = options.zMaxM ?? 40;
  const xMax = options.xMaxAbsM ?? 40;
  const maxShapes = Math.max(1, Math.round(options.maxShapes ?? MAX_SET_BLOCKS));
  const clearance = options.personClearanceM ?? 0.4;
  const cells = new Map<string, ShapeCell>();
  const key = (ix: number, iy: number, iz: number) => `${ix}|${iy}|${iz}`;
  const count = Math.floor(points.length / 3);
  for (let index = 0; index < count; index++) {
    const x = points[index * 3];
    const y = points[index * 3 + 1];
    const z = points[index * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (y < minHeight || y > yMax || z < zMin || z > zMax || Math.abs(x) > xMax) continue;
    const ix = Math.floor(x / cell);
    const iy = Math.floor(y / cell);
    const iz = Math.floor(z / cell);
    const id = key(ix, iy, iz);
    const found = cells.get(id);
    if (found) {
      found.count += 1;
      found.sumX += x;
      found.sumZ += z;
    } else cells.set(id, {ix, iy, iz, count: 1, sumX: x, sumZ: z});
  }
  // Points thin out with distance (a cell covers fewer pixels): the evidence a cell needs falls with z.
  for (const [id, entry] of cells) {
    const z = (entry.iz + 0.5) * cell;
    const needed = Math.max(2, Math.round(12 * (3 / Math.max(3, z)) ** 2));
    if (entry.count < needed) cells.delete(id);
  }
  // Connected parts (26-neighbourhood).
  const parts: ShapeCell[][] = [];
  const seen = new Set<string>();
  for (const [id, start] of cells) {
    if (seen.has(id)) continue;
    seen.add(id);
    const part: ShapeCell[] = [];
    const queue = [start];
    while (queue.length) {
      const current = queue.pop()!;
      part.push(current);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const next = key(current.ix + dx, current.iy + dy, current.iz + dz);
            if (seen.has(next)) continue;
            const neighbour = cells.get(next);
            if (!neighbour) continue;
            seen.add(next);
            queue.push(neighbour);
          }
        }
      }
    }
    // A part of one to three cells is depth noise, not set.
    if (part.length >= 4) parts.push(part);
  }

  type Shape = SceneBlock & {weight: number};
  const shapes: Shape[] = [];
  const half = cell / 2;
  const classify = (centreY: number, sizeX: number, sizeY: number, sizeZ: number, centreZ: number): NonNullable<SceneBlock["kind"]> => {
    if (centreY - sizeY / 2 <= 0.3 && sizeY <= 0.6) return "ground";
    if (sizeY >= 1.2 && sizeY > Math.max(sizeX, sizeZ)) return "wall";
    if (options.subjectDistanceM !== undefined && centreZ > options.subjectDistanceM + 0.5) return "background";
    return "object";
  };
  // Person points are cut before (masks and a 0.5 m cylinder). A small shape still within 0.4 m of a
  // root is a leftover of the person; a larger one (a wall behind someone) only goes if the person
  // stands inside it.
  const nearPerson = (distanceTo: (root: {xM: number; zM: number}) => number, y0: number, y1: number, across: number) =>
    y1 > 0 && y0 < 2.2 && (options.personRoots ?? []).some((root) => distanceTo(root) < (across <= 1 ? clearance : 0.1));
  const fit = (part: ShapeCell[], depth: number) => {
    const centres = part.map((entry) => [(entry.ix + 0.5) * cell, (entry.iy + 0.5) * cell, (entry.iz + 0.5) * cell] as const);
    const weight = part.reduce((total, entry) => total + entry.count, 0);
    let yLow = Infinity;
    let yHigh = -Infinity;
    for (const centre of centres) {
      yLow = Math.min(yLow, centre[1] - half);
      yHigh = Math.max(yHigh, centre[1] + half);
    }
    // A part standing just above the floor reaches down to it (MoGe misses the contact line).
    if (yLow < 0.4) yLow = 0;
    const sizeY = yHigh - yLow;
    const centreY = (yLow + yHigh) / 2;
    // Cylinder: the footprint lies on a circle arc of a plausible radius.
    // Footprint columns at the centroid of their points (cell centres are too coarse for the arc test).
    const columns = new Map<string, {x: number; z: number; n: number}>();
    for (const entry of part) {
      const id = `${entry.ix}|${entry.iz}`;
      const column = columns.get(id) ?? {x: 0, z: 0, n: 0};
      column.x += entry.sumX;
      column.z += entry.sumZ;
      column.n += entry.count;
      columns.set(id, column);
    }
    const footprint = new Map<string, [number, number]>([...columns].map(([id, column]) => [id, [column.x / column.n, column.z / column.n]]));
    // A wall corner also fits an arc roughly: a cylinder must fit clearly better than two straight runs.
    const circle = footprint.size >= 12 ? fitCircle([...footprint.values()]) : null;
    const arcOrder = circle ? [...footprint.values()].sort((left, right) => Math.atan2(left[1] - circle.cz, left[0] - circle.cx) - Math.atan2(right[1] - circle.cz, right[0] - circle.cx)) : [];
    if (circle && circle.radius >= 0.5 && circle.radius <= 4 && circle.rms <= 0.12 * circle.radius && sizeY >= 0.8 && circle.rms < 0.7 * twoLineRms(arcOrder)) {
      const angles = [...footprint.values()].map(([x, z]) => Math.atan2(z - circle.cz, x - circle.cx)).sort((left, right) => left - right);
      let largestGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
      for (let index = 1; index < angles.length; index++) largestGap = Math.max(largestGap, angles[index] - angles[index - 1]);
      const coverage = 2 * Math.PI - largestGap;
      if (coverage >= Math.PI / 2) {
        const diameter = 2 * circle.radius;
        if (!nearPerson((root) => Math.max(0, Math.hypot(root.xM - circle.cx, root.zM - circle.cz) - circle.radius), yLow, yHigh, diameter)) {
          shapes.push({xM: round2(circle.cx), yM: round2(centreY), zM: round2(circle.cz), sizeX: round2(diameter), sizeY: round2(sizeY), sizeZ: round2(diameter), kind: classify(centreY, diameter, sizeY, diameter, circle.cz), shape: "cylinder", weight});
        }
        return;
      }
    }
    // Oriented box along the main floor axis of the part.
    let mx = 0;
    let mz = 0;
    for (const centre of centres) {
      mx += centre[0] / centres.length;
      mz += centre[2] / centres.length;
    }
    let cxx = 0;
    let czz = 0;
    let cxz = 0;
    for (const centre of centres) {
      cxx += (centre[0] - mx) ** 2;
      czz += (centre[2] - mz) ** 2;
      cxz += (centre[0] - mx) * (centre[2] - mz);
    }
    let angle = 0.5 * Math.atan2(2 * cxz, cxx - czz);
    // Near an axis, keep the box square to the stage (grid noise is not a rotation).
    const snap = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(angle - snap) < (4 * Math.PI) / 180) angle = snap;
    const ux = Math.cos(angle);
    const uz = Math.sin(angle);
    let sLow = Infinity;
    let sHigh = -Infinity;
    let tLow = Infinity;
    let tHigh = -Infinity;
    const projected = centres.map((centre) => {
      const s = centre[0] * ux + centre[2] * uz;
      const t = -centre[0] * uz + centre[2] * ux;
      sLow = Math.min(sLow, s - half);
      sHigh = Math.max(sHigh, s + half);
      tLow = Math.min(tLow, t - half);
      tHigh = Math.max(tHigh, t + half);
      return {s, t, y: centre[1]};
    });
    const lengthS = sHigh - sLow;
    const lengthT = tHigh - tLow;
    const volumeCells = (lengthS / cell) * (lengthT / cell) * (sizeY / cell);
    const fill = part.length / Math.max(1, volumeCells);
    // A mostly empty box is two or more things: split at the median of its longest side.
    if (fill < 0.3 && part.length >= 16 && depth < 8) {
      const longest = lengthS >= lengthT && lengthS >= sizeY ? "s" : lengthT >= sizeY ? "t" : "y";
      const values = projected.map((entry) => entry[longest]).sort((left, right) => left - right);
      const median = values[Math.floor(values.length / 2)];
      const low: ShapeCell[] = [];
      const high: ShapeCell[] = [];
      projected.forEach((entry, index) => (entry[longest] < median ? low : high).push(part[index]));
      if (low.length && high.length) {
        fit(low, depth + 1);
        fit(high, depth + 1);
        return;
      }
    }
    const s = (sLow + sHigh) / 2;
    const t = (tLow + tHigh) / 2;
    const x = s * ux - t * uz;
    const z = s * uz + t * ux;
    const footprintDistance = (root: {xM: number; zM: number}) => {
      const rs = root.xM * ux + root.zM * uz;
      const rt = -root.xM * uz + root.zM * ux;
      return Math.hypot(Math.max(0, Math.abs(rs - s) - lengthS / 2), Math.max(0, Math.abs(rt - t) - lengthT / 2));
    };
    if (nearPerson(footprintDistance, yLow, yHigh, Math.max(lengthS, lengthT))) return;
    // three.js rotation.y turns local +x to (cos, 0, -sin): local x follows the main axis.
    const yawDeg = angle === 0 ? undefined : round2((Math.atan2(-uz, ux) * 180) / Math.PI);
    shapes.push({xM: round2(x), yM: round2(centreY), zM: round2(z), sizeX: round2(lengthS), sizeY: round2(sizeY), sizeZ: round2(lengthT), kind: classify(centreY, lengthS, sizeY, lengthT, z), shape: "box", ...(yawDeg === undefined ? {} : {yawDeg}), weight});
  };
  for (const part of parts) fit(part, 0);
  shapes.sort((left, right) => right.weight / (1 + right.zM) - left.weight / (1 + left.zM));
  const kept = shapes.slice(0, maxShapes);
  kept.sort((left, right) => left.zM - right.zM || left.xM - right.xM || left.yM - right.yM);
  return kept.map(({weight: _weight, ...block}) => block);
}

/**
 *: set blocks never stand in the camera's view of its subject. Depth noise next to the lens
 * (a microphone, a shoulder, a door frame) can become a box at eye level a few decimetres ahead, and
 * the previs then shows one flat grey surface. A block goes when it sits on the lens axis within
 * `nearM`, or when it crosses the sight line from the camera to a person's body or head.
 * Stage coordinates: camera at (0, cameraHeightM, 0) looking along +z; y is height above the floor.
 */
export function clearCameraView(
  set: readonly SceneBlock[],
  options: {cameraHeightM: number; personRoots?: ReadonlyArray<{xM: number; zM: number}>; nearM?: number},
): SceneBlock[] {
  const eye: [number, number, number] = [0, options.cameraHeightM, 0];
  const nearM = options.nearM ?? 1.2;
  const inside = (block: SceneBlock, point: readonly [number, number, number]) => {
    const dx = point[0] - block.xM;
    const dy = point[1] - block.yM;
    const dz = point[2] - block.zM;
    if (Math.abs(dy) > Math.abs(block.sizeY) / 2) return false;
    if (block.shape === "cylinder") return Math.hypot(dx, dz) <= Math.abs(block.sizeX) / 2;
    const yaw = ((block.yawDeg ?? 0) * Math.PI) / 180;
    const localX = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const localZ = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    return Math.abs(localX) <= Math.abs(block.sizeX) / 2 && Math.abs(localZ) <= Math.abs(block.sizeZ) / 2;
  };
  const crosses = (block: SceneBlock, target: readonly [number, number, number], from: number, to: number) => {
    for (let t = from; t <= to; t += 0.02) {
      if (inside(block, [eye[0] + (target[0] - eye[0]) * t, eye[1] + (target[1] - eye[1]) * t, eye[2] + (target[2] - eye[2]) * t])) return true;
    }
    return false;
  };
  const axisEnd: [number, number, number] = [0, eye[1], nearM];
  const sightTargets = (options.personRoots ?? [])
    .filter((root) => Number.isFinite(root.xM) && Number.isFinite(root.zM) && root.zM > 0)
    .flatMap((root) => [1.0, 1.5].map((heightM) => [root.xM, heightM, root.zM] as [number, number, number]));
  return set.filter((block) => !crosses(block, axisEnd, 0.25, 1) && !sightTargets.some((target) => crosses(block, target, 0.02, 0.9)));
}
