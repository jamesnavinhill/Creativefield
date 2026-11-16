/*
 * The studio previs look (LATER-2335): a lit grey set inside a dark cyclorama, soft overhead light with soft
 * shadows, rounded primitives, clay mannequins with human proportions (male, female, child), and the film camera's travel drawn as
 * a glowing dashed line on the floor. The live diorama, the shot stills and the handoff clips all use it, so the
 * stage, a still and a clip never disagree. No new dependencies: RoundedBoxGeometry ships with three.
 */
import {
  ACESFilmicToneMapping, BoxGeometry, CapsuleGeometry, LatheGeometry, Vector2, Color, CylinderGeometry, DoubleSide, Fog, Group, HemisphereLight, Light,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, PCFSoftShadowMap, PlaneGeometry, SpotLight, SphereGeometry,
  type Object3D, type WebGLRenderer,
} from "three";
import {RoundedBoxGeometry} from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {evaluateFrame} from "../score/evaluate";
import type {StageScore} from "../score/schema";
import type {Mannequin} from "./mannequin";

/** Studio colours: a near-black room, mid-grey floor, light-grey set, Squarehead yellow and black. */
export const STUDIO = {room: 0x101113, floor: 0x4a4d52, set: 0xb4b8bd, prop: 0x9ea2a7, yellow: 0xf2b705, emboss: 0xc78f00, cloth: 0x161618, glove: 0xf4f4f2, path: 0xffc83d, clay: 0xc9c3bb};

export function enableStudioRenderer(renderer: WebGLRenderer) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
}

/** A box with softened edges, the set's one shape for walls, cubes and ramps. */
export function roundedBox(width: number, height: number, depth: number) {
  const radius = Math.max(0.01, Math.min(width, height, depth) * 0.08);
  return new RoundedBoxGeometry(width, height, depth, 3, radius);
}

function shadows(object: Object3D, cast = true) {
  object.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
  });
}

/** The room: floor, a cyclorama that curves up into darkness, the softbox panel overhead, and the lights. */
function buildRoom(score: StageScore): Group {
  const room = new Group();
  room.name = "studio-room";
  const size = Math.max(score.stage.width, score.stage.depth) * 3 + 20;
  const floor = new Mesh(new PlaneGeometry(size, size), new MeshStandardMaterial({color: STUDIO.floor, roughness: 0.92, metalness: 0}));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.002;
  floor.receiveShadow = true;
  room.add(floor);
  const wall = new Mesh(new CylinderGeometry(size / 2, size / 2, size / 2, 64, 1, true), new MeshStandardMaterial({color: STUDIO.room, roughness: 1, side: DoubleSide}));
  wall.position.y = size / 4 - 0.01;
  room.add(wall);
  const softbox = new Mesh(new PlaneGeometry(Math.max(4, score.stage.width * 0.7), Math.max(1.5, score.stage.depth * 0.25)), new MeshBasicMaterial({color: 0xffffff}));
  softbox.rotation.x = Math.PI / 2;
  softbox.position.set(0, Math.max(6, score.stage.width * 0.55), -score.stage.depth * 0.15);
  softbox.name = "studio-softbox";
  room.add(softbox);
  const spot = new SpotLight(0xffffff, 110, 0, Math.PI / 3.2, 0.95, 1.6);
  spot.position.set(0, softbox.position.y - 0.2, softbox.position.z);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.radius = 6;
  spot.shadow.bias = -0.0004;
  room.add(spot, spot.target);
  room.add(new HemisphereLight(0xdfe4ea, 0x1a1b1d, 0.55));
  return room;
}

export type FigureBuild = "male" | "female" | "kid";

/** A smooth torso turned on a lathe: radius at each height (both in rig heights), then flattened front to back. */
function torsoProfile(build: FigureBuild): [number, number][] {
  // [radius, height above the hip joint]
  if (build === "female") return [[0.001, -0.06], [0.07, -0.05], [0.1, -0.005], [0.095, 0.05], [0.07, 0.13], [0.078, 0.2], [0.088, 0.24], [0.082, 0.285], [0.05, 0.31], [0.022, 0.32]];
  if (build === "kid") return [[0.001, -0.06], [0.072, -0.05], [0.088, 0], [0.085, 0.06], [0.08, 0.14], [0.085, 0.22], [0.09, 0.27], [0.055, 0.31], [0.024, 0.32]];
  return [[0.001, -0.06], [0.072, -0.05], [0.09, -0.005], [0.086, 0.05], [0.082, 0.13], [0.095, 0.2], [0.108, 0.255], [0.1, 0.29], [0.055, 0.315], [0.024, 0.32]];
}

/**
 * Dress the jointed mannequin as a clean studio figure with human proportions (a male, female or child build, after
 * the usual mannequin charts): a smooth lathe-turned torso with chest, waist and hips, tapered limbs that meet at
 * rounded joints, hands, feet and an oval head. One matte clay material, as a sculptor's mannequin. Every piece
 * hangs on its bone, so walk and posture cues move it as before.
 */
export function dressFigure(mannequin: Mannequin, build: FigureBuild) {
  const bones = mannequin.rig.bones;
  const h = mannequin.rig.height;
  const clay = new MeshStandardMaterial({color: STUDIO.clay, roughness: 0.78, metalness: 0});
  const hair = new MeshStandardMaterial({color: 0x5b5048, roughness: 0.9, metalness: 0});
  mannequin.rig.root.traverse((node) => {
    if ((node as Mesh).isMesh && node.userData.figure) node.visible = false;
  });
  type Bone = Parameters<typeof bones.get>[0];
  const put = (bone: Bone, mesh: Mesh, x = 0, y = 0, z = 0) => {
    mesh.position.set(x, y, z);
    bones.get(bone)?.add(mesh);
    return mesh;
  };
  const slim = build === "female" ? 0.9 : build === "kid" ? 0.95 : 1;
  /** A tapered limb from its bone to the next joint (+x / -x for arms, -y for legs), with a rounded joint at the top. */
  const limb = (bone: Bone, top: number, bottom: number, length: number, axis: "x" | "-x" | "-y") => {
    const geometry = new CylinderGeometry(top * h * slim, bottom * h * slim, length * h, 20);
    if (axis !== "-y") geometry.rotateZ(axis === "x" ? -Math.PI / 2 : Math.PI / 2);
    const half = (length * h) / 2;
    put(bone, new Mesh(geometry, clay), axis === "x" ? half : axis === "-x" ? -half : 0, axis === "-y" ? -half : 0, 0);
    put(bone, new Mesh(new SphereGeometry(top * h * slim * 1.02, 18, 14), clay));
  };
  const torso = new LatheGeometry(torsoProfile(build).map(([r, y]) => new Vector2(r * h, y * h)), 32);
  put("Hips", new Mesh(torso, clay)).scale.set(1, 1, build === "female" ? 0.72 : 0.68);
  put("Neck", new Mesh(new CylinderGeometry(0.022 * h, 0.026 * h, 0.07 * h, 16), clay), 0, 0.02 * h, 0);
  // Shoulders carry the arms out from the chest; arms and legs taper to wrist and ankle.
  limb("LeftShoulder", 0.034, 0.033, 0.08, "x");
  limb("RightShoulder", 0.034, 0.033, 0.08, "-x");
  limb("LeftArm", 0.032, 0.026, 0.15, "x");
  limb("RightArm", 0.032, 0.026, 0.15, "-x");
  limb("LeftForeArm", 0.025, 0.019, 0.14, "x");
  limb("RightForeArm", 0.025, 0.019, 0.14, "-x");
  limb("LeftUpLeg", 0.056, 0.038, 0.225, "-y");
  limb("RightUpLeg", 0.056, 0.038, 0.225, "-y");
  limb("LeftLeg", 0.037, 0.024, 0.225, "-y");
  limb("RightLeg", 0.037, 0.024, 0.225, "-y");
  for (const [bone, side] of [["LeftHand", 1], ["RightHand", -1]] as const) {
    const hand = put(bone, new Mesh(new CapsuleGeometry(0.018 * h, 0.04 * h, 6, 12), clay), side * 0.035 * h, 0, 0);
    hand.rotation.z = Math.PI / 2;
    hand.scale.set(1, 1, 0.55);
  }
  for (const bone of ["LeftFoot", "RightFoot"] as const) {
    const foot = put(bone, new Mesh(new CapsuleGeometry(0.025 * h, 0.09 * h, 6, 12), clay), 0, -0.012 * h, 0.045 * h);
    foot.rotation.x = Math.PI / 2;
    foot.scale.set(1, 1, 0.6);
  }
  // Head: an oval, a child's a quarter larger against the body; short hair on the female figure, as in the charts.
  const headScale = build === "kid" ? 1.25 : 1;
  const head = put("Head", new Mesh(new SphereGeometry(0.06 * h * headScale, 28, 22), clay), 0, 0.035 * h, 0);
  head.scale.set(0.84, 1.08, 0.94);
  if (build === "female") {
    const cap = put("Head", new Mesh(new SphereGeometry(0.066 * h, 28, 22, 0, Math.PI * 2, 0, Math.PI * 0.62), hair), 0, 0.04 * h, -0.004 * h);
    cap.scale.set(0.9, 1.12, 1.0);
  } else {
    const cap = put("Head", new Mesh(new SphereGeometry(0.062 * h * headScale, 28, 22, 0, Math.PI * 2, 0, Math.PI * 0.42), hair), 0, 0.04 * h, -0.003 * h);
    cap.scale.set(0.86, 1.1, 0.96);
  }
  shadows(mannequin.rig.root);
}

/** Which build a character gets: a child under 1.45 m; adults alternate male and female in score order. */
export function figureBuild(heightM: number, index: number): FigureBuild {
  return heightM < 1.45 ? "kid" : index % 2 === 0 ? "male" : "female";
}

/**
 * The film camera's travel over the whole score, projected onto the floor as short glowing dashes. A cut (a jump
 * of more than 2 m between samples) breaks the line instead of drawing a dash across the stage.
 */
export function buildCameraPath(score: StageScore): Group {
  const group = new Group();
  group.name = "camera-path";
  const material = new MeshBasicMaterial({color: STUDIO.path});
  const halo = new MeshBasicMaterial({color: STUDIO.path, transparent: true, opacity: 0.22, depthWrite: false});
  const step = 0.08;
  let previous: [number, number] | undefined;
  let carry = 0;
  for (let t = 0; t <= score.durationSec + 1e-6; t += step) {
    const eye = evaluateFrame(score, t - score.offsetSec).stageCamera.eye;
    const point: [number, number] = [eye[0], eye[2]];
    if (previous) {
      const dx = point[0] - previous[0];
      const dz = point[1] - previous[1];
      const length = Math.hypot(dx, dz);
      if (length > 2) carry = 0;
      else if (length > 1e-4) {
        carry += length;
        if (carry >= 0.32) {
          carry = 0;
          const angle = Math.atan2(dx, dz);
          const dash = new Mesh(new BoxGeometry(0.035, 0.008, 0.16), material);
          dash.position.set(point[0], 0.006, point[1]);
          dash.rotation.y = angle;
          group.add(dash);
          const glow = new Mesh(new BoxGeometry(0.12, 0.004, 0.24), halo);
          glow.position.copy(dash.position);
          glow.rotation.y = angle;
          group.add(glow);
        }
      }
    }
    previous = point;
  }
  return group;
}

/** The parts of the studio look a scene graph carries, so a caller can show or hide them per pass. */
export type StudioParts = {room: Group; cameraPath: Group};

/**
 * Turn a built diorama into the studio look: the room and lights replace the grid and the flat lights, props and
 * set become opaque rounded grey with shadows, characters wear Squarehead, the camera path lies on the floor.
 */
export function applyStudioLook(scene: import("three").Scene, score: StageScore, characters: {mannequin: Mannequin; heightM: number}[]): StudioParts {
  for (const node of [...scene.children]) if ((node as Light).isLight) scene.remove(node);
  const grid = scene.getObjectByName("stage-grid");
  if (grid) grid.visible = false;
  scene.background = new Color(STUDIO.room);
  scene.fog = new Fog(STUDIO.room, Math.max(score.stage.width, score.stage.depth) * 1.6, Math.max(score.stage.width, score.stage.depth) * 4 + 30);
  const room = buildRoom(score);
  scene.add(room);
  characters.forEach((character, index) => dressFigure(character.mannequin, figureBuild(character.heightM, index)));
  const cameraPath = buildCameraPath(score);
  scene.add(cameraPath);
  return {room, cameraPath};
}

/** Props in the studio look: opaque matte grey, casting and receiving shadows. */
export function studioPropMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({color: STUDIO.prop, roughness: 0.9, metalness: 0});
}

export {shadows as studioShadows};
