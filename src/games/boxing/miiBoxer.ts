import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  createMiiFacePatch,
  createMiiHairGeometry,
  createMiiHeadGeometry,
  createMiiNoseGeometry,
  miiHairColor,
  type MiiFaceMount,
} from '../../mii/miiHead';
import { DEFAULT_MII_FACE_SPEC, SKIN_PALETTE, type MiiFaceSpec } from '../../mii/miiSpec';

/** Bakes a color into the vertices, so differently colored parts can share one draw call. Consumes `source`. */
function paint(source: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const { r, g, b } = new THREE.Color(color);
  const colors = new Float32Array(geometry.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([r, g, b], i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Merges and frees the parts. They must agree on attributes and on being indexed or not. */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

const POSE_KEYS = [
  'bodyY',
  'bodyRotX',
  'bodyRotY',
  'bodyRotZ',
  'leftHipX',
  'leftHipZ',
  'leftKneeX',
  'rightHipX',
  'rightHipZ',
  'rightKneeX',
  'leftShoulderX',
  'leftShoulderY',
  'leftShoulderZ',
  'leftElbowX',
  'leftElbowY',
  'leftElbowZ',
  'rightShoulderX',
  'rightShoulderY',
  'rightShoulderZ',
  'rightElbowX',
  'rightElbowY',
  'rightElbowZ',
] as const;

type PoseKey = (typeof POSE_KEYS)[number];
type BoxerPose = Record<PoseKey, number>;

export type MiiBoxerState = 'idle' | 'guard' | 'windup' | 'punch' | 'recover' | 'hit' | 'dizzy' | 'knockdown' | 'getup';
type MiiBoxerHand = 'left' | 'right';

export interface MiiBoxerOptions {
  shirtColor?: THREE.ColorRepresentation;
  trimColor?: THREE.ColorRepresentation;
  skinColor?: THREE.ColorRepresentation;
  shortsColor?: THREE.ColorRepresentation;
  gloveColor?: THREE.ColorRepresentation;
  shoeColor?: THREE.ColorRepresentation;
  face?: MiiFaceSpec;
}

export interface MiiBoxerFootwork {
  /** Horizontal displacement speed, clamped to 0..1. Zero plants the feet. */
  speed01?: number;
  /** Signed forward/backward component, clamped to -1..1. Positive closes in. */
  forward?: number;
  /** Signed circling component, clamped to -1..1. Positive moves to the boxer's right. */
  strafe?: number;
}

export interface MiiBoxer {
  /**
   * Faces local -Z. The owner controls position and heading; the boxer controls the internal
   * body group, limbs, state blending and time-based motion.
   */
  root: THREE.Group;
  facePatch: MiiFaceMount;
  /**
   * Selects the next animation state. The transition starts at the boxer's internal clock: the
   * latest time passed to `animate`, or zero for a newly created boxer. Re-selecting the current
   * state and hand is a no-op, so per-frame state broadcasts do not restart one-shot motions. `punch`
   * extends and retracts over 0.34 s, `hit` settles over 0.5 s, `knockdown` falls over 0.55 s and
   * `getup` recovers over about 1.35 s, all measured from state entry; the other states loop until
   * replaced. `hand` picks the arm for `windup` and `punch`.
   */
  setState(state: MiiBoxerState, hand?: MiiBoxerHand): void;
  /**
   * Poses the boxer for an explicit, normally monotonic clock in seconds. No wall-clock timers
   * are read; repeating the same sequence of `setState`/`animate` calls gives the same pose.
   * Footwork adds a small leg/trunk stride. It starts at once and, when the input slows or stops,
   * fades out over the time between `animate` calls instead of snapping the legs.
   * @throws TypeError when `timeSeconds` is not finite.
   */
  animate(timeSeconds: number, footwork?: MiiBoxerFootwork): void;
}

export interface FirstPersonGlovesInput {
  /** Guard height, clamped to 0..1. Defaults to a light boxing guard. */
  guard?: number;
  /** Left punch extension, clamped to 0..1. Zero is cocked, one is fully extended. */
  leftPunch?: number;
  /** Right punch extension, clamped to 0..1. Zero is cocked, one is fully extended. */
  rightPunch?: number;
}

export interface FirstPersonGloves {
  /** Viewer-space gloves: x is right, y is up and punches travel toward -Z. Add `root` wherever useful. */
  root: THREE.Group;
  /**
   * Applies deterministic idle motion plus the caller-supplied guard/punch amounts. The input is
   * sampled as a pose, not accumulated, so the same time and input always produce the same result.
   * @throws TypeError when `timeSeconds` is not finite.
   */
  animate(timeSeconds: number, input?: FirstPersonGlovesInput): void;
}

const IDLE_POSE: BoxerPose = {
  bodyY: 0,
  bodyRotX: -0.03,
  bodyRotY: -0.1,
  bodyRotZ: 0,
  leftHipX: 0.18,
  leftHipZ: -0.04,
  leftKneeX: -0.22,
  rightHipX: -0.14,
  rightHipZ: 0.04,
  rightKneeX: -0.2,
  leftShoulderX: 0.18,
  leftShoulderY: 0.05,
  leftShoulderZ: -0.12,
  leftElbowX: 0.45,
  leftElbowY: 0,
  leftElbowZ: 0.05,
  rightShoulderX: 0.12,
  rightShoulderY: -0.05,
  rightShoulderZ: 0.12,
  rightElbowX: 0.42,
  rightElbowY: 0,
  rightElbowZ: -0.05,
};

const GUARD_POSE: BoxerPose = {
  bodyY: -0.03,
  bodyRotX: -0.08,
  bodyRotY: -0.16,
  bodyRotZ: 0,
  leftHipX: 0.24,
  leftHipZ: -0.06,
  leftKneeX: -0.34,
  rightHipX: -0.2,
  rightHipZ: 0.06,
  rightKneeX: -0.3,
  leftShoulderX: 0.62,
  leftShoulderY: 0.12,
  leftShoulderZ: 0.08,
  leftElbowX: 1.72,
  leftElbowY: -0.1,
  leftElbowZ: 0.1,
  rightShoulderX: 0.52,
  rightShoulderY: -0.18,
  rightShoulderZ: -0.02,
  rightElbowX: 1.86,
  rightElbowY: 0.12,
  rightElbowZ: -0.08,
};

const WINDUP_POSE: BoxerPose = {
  ...GUARD_POSE,
  bodyRotX: -0.04,
  bodyRotY: -0.38,
  bodyRotZ: -0.04,
  rightShoulderX: 0.16,
  rightShoulderY: -0.42,
  rightShoulderZ: 0.2,
  rightElbowX: 2.06,
  rightElbowY: 0.2,
  rightElbowZ: -0.16,
};

const PUNCH_EXTENDED_POSE: BoxerPose = {
  ...GUARD_POSE,
  bodyY: -0.04,
  bodyRotX: -0.12,
  bodyRotY: 0.2,
  bodyRotZ: 0.03,
  rightShoulderX: 1.32,
  rightShoulderY: 0.06,
  rightShoulderZ: -0.03,
  rightElbowX: 0.16,
  rightElbowY: 0,
  rightElbowZ: 0,
};

/** Off balance after a punch: gloves low and wide, knees soft. */
const RECOVER_POSE: BoxerPose = {
  ...GUARD_POSE,
  bodyY: -0.07,
  bodyRotX: -0.18,
  bodyRotY: -0.04,
  leftHipZ: -0.12,
  leftKneeX: -0.46,
  rightHipZ: 0.12,
  rightKneeX: -0.42,
  leftShoulderX: 0.34,
  leftShoulderZ: -0.42,
  leftElbowX: 0.9,
  rightShoulderX: 0.3,
  rightShoulderZ: 0.42,
  rightElbowX: 0.86,
};

const HIT_IMPACT_POSE: BoxerPose = {
  bodyY: 0.01,
  bodyRotX: 0.24,
  bodyRotY: 0.12,
  bodyRotZ: -0.1,
  leftHipX: 0.05,
  leftHipZ: -0.09,
  leftKneeX: -0.13,
  rightHipX: -0.04,
  rightHipZ: 0.1,
  rightKneeX: -0.1,
  leftShoulderX: 0.02,
  leftShoulderY: 0.12,
  leftShoulderZ: -0.24,
  leftElbowX: 0.32,
  leftElbowY: 0,
  leftElbowZ: 0.1,
  rightShoulderX: -0.02,
  rightShoulderY: -0.1,
  rightShoulderZ: 0.25,
  rightElbowX: 0.28,
  rightElbowY: 0,
  rightElbowZ: -0.1,
};

const HIT_RECOVERED_POSE: BoxerPose = {
  ...IDLE_POSE,
  bodyRotX: 0.08,
  bodyRotZ: -0.04,
  leftElbowX: 0.62,
  rightElbowX: 0.58,
};

const DIZZY_POSE: BoxerPose = {
  bodyY: -0.08,
  bodyRotX: 0.06,
  bodyRotY: 0,
  bodyRotZ: 0,
  leftHipX: 0.2,
  leftHipZ: -0.14,
  leftKneeX: -0.38,
  rightHipX: -0.16,
  rightHipZ: 0.14,
  rightKneeX: -0.36,
  leftShoulderX: 0.16,
  leftShoulderY: 0.08,
  leftShoulderZ: -0.32,
  leftElbowX: 0.5,
  leftElbowY: 0,
  leftElbowZ: 0.18,
  rightShoulderX: 0.12,
  rightShoulderY: -0.08,
  rightShoulderZ: 0.32,
  rightElbowX: 0.48,
  rightElbowY: 0,
  rightElbowZ: -0.18,
};

const KNOCKED_DOWN_POSE: BoxerPose = {
  bodyY: 0.02,
  bodyRotX: 1.42,
  bodyRotY: 0.1,
  bodyRotZ: 0.18,
  leftHipX: 0.34,
  leftHipZ: -0.18,
  leftKneeX: -0.54,
  rightHipX: -0.2,
  rightHipZ: 0.2,
  rightKneeX: -0.42,
  leftShoulderX: 0.24,
  leftShoulderY: 0.08,
  leftShoulderZ: -0.68,
  leftElbowX: 0.26,
  leftElbowY: 0,
  leftElbowZ: 0.18,
  rightShoulderX: 0.18,
  rightShoulderY: -0.08,
  rightShoulderZ: 0.68,
  rightElbowX: 0.22,
  rightElbowY: 0,
  rightElbowZ: -0.18,
};

const GETUP_START_POSE: BoxerPose = {
  ...KNOCKED_DOWN_POSE,
  bodyRotX: 1.05,
  bodyRotZ: 0.1,
  leftShoulderX: 0.42,
  leftElbowX: 0.54,
  rightShoulderX: 0.38,
  rightElbowX: 0.5,
};

const GETUP_LOW_POSE: BoxerPose = {
  bodyY: -0.24,
  bodyRotX: -0.16,
  bodyRotY: -0.1,
  bodyRotZ: 0.08,
  leftHipX: 0.72,
  leftHipZ: -0.08,
  leftKneeX: -1.34,
  rightHipX: -0.54,
  rightHipZ: 0.1,
  rightKneeX: -1.18,
  leftShoulderX: 0.54,
  leftShoulderY: 0.1,
  leftShoulderZ: -0.12,
  leftElbowX: 0.72,
  leftElbowY: 0,
  leftElbowZ: 0.08,
  rightShoulderX: 0.48,
  rightShoulderY: -0.1,
  rightShoulderZ: 0.12,
  rightElbowX: 0.68,
  rightElbowY: 0,
  rightElbowZ: -0.08,
};

const TRANSITION_SECONDS: Record<MiiBoxerState, number> = {
  idle: 0.22,
  guard: 0.16,
  windup: 0.14,
  punch: 0.05,
  recover: 0.18,
  hit: 0.08,
  dizzy: 0.22,
  knockdown: 0.1,
  getup: 0.16,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smooth01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function copyPose(pose: BoxerPose): BoxerPose {
  return { ...pose };
}

function mixPose(from: BoxerPose, to: BoxerPose, amount01: number): BoxerPose {
  const mixed = copyPose(to);
  const amount = clamp01(amount01);
  for (const key of POSE_KEYS) mixed[key] = from[key] + (to[key] - from[key]) * amount;
  return mixed;
}

/** Swaps the arms and the trunk twist; the stance, and so the legs, stays as it is. */
function mirrorUpperBody(pose: BoxerPose): BoxerPose {
  return {
    ...pose,
    bodyRotY: -pose.bodyRotY,
    bodyRotZ: -pose.bodyRotZ,
    leftShoulderX: pose.rightShoulderX,
    leftShoulderY: -pose.rightShoulderY,
    leftShoulderZ: -pose.rightShoulderZ,
    leftElbowX: pose.rightElbowX,
    leftElbowY: -pose.rightElbowY,
    leftElbowZ: -pose.rightElbowZ,
    rightShoulderX: pose.leftShoulderX,
    rightShoulderY: -pose.leftShoulderY,
    rightShoulderZ: -pose.leftShoulderZ,
    rightElbowX: pose.leftElbowX,
    rightElbowY: -pose.leftElbowY,
    rightElbowZ: -pose.leftElbowZ,
  };
}

function addPoseOffsets(pose: BoxerPose, offsets: Partial<BoxerPose>): BoxerPose {
  for (const key of POSE_KEYS) pose[key] += offsets[key] ?? 0;
  return pose;
}

function clampSignedUnit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/** Time constant of the footwork fade-out. */
const FOOTWORK_RELEASE_S = 0.09;

interface Stride {
  speed01: number;
  forward: number;
  strafe: number;
}

/** Rises with the input at once; fades toward a slower input, keeping the last heading once stopped. */
function stepStride(stride: Stride, dtS: number, footwork: MiiBoxerFootwork | undefined): Stride {
  const speed01 = footwork?.speed01 === undefined || !Number.isFinite(footwork.speed01) ? 0 : clamp01(footwork.speed01);
  let amount = speed01;
  if (speed01 < stride.speed01) {
    amount = speed01 + (stride.speed01 - speed01) * Math.exp(-dtS / FOOTWORK_RELEASE_S);
    if (amount < 1e-3) amount = 0;
  }
  if (speed01 === 0) return { ...stride, speed01: amount };
  return { speed01: amount, forward: clampSignedUnit(footwork?.forward), strafe: clampSignedUnit(footwork?.strafe) };
}

function withFootwork(pose: BoxerPose, timeSeconds: number, { speed01, forward, strafe }: Stride): BoxerPose {
  if (speed01 === 0) return pose;
  const stride = Math.sin(timeSeconds * 8.4) * speed01;
  const lift = Math.abs(Math.cos(timeSeconds * 8.4)) * speed01;
  return addPoseOffsets(copyPose(pose), {
    bodyY: lift * 0.015,
    bodyRotX: forward * speed01 * 0.045,
    bodyRotZ: strafe * speed01 * 0.06,
    leftHipX: stride * 0.24,
    rightHipX: -stride * 0.24,
    leftKneeX: -Math.max(0, -stride) * 0.18,
    rightKneeX: -Math.max(0, stride) * 0.18,
  });
}

function pulse01(time: number, attackEnd: number, holdEnd: number, releaseEnd: number): number {
  if (time < attackEnd) return smooth01(time / attackEnd);
  if (time < holdEnd) return 1;
  if (time < releaseEnd) return 1 - smooth01((time - holdEnd) / (releaseEnd - holdEnd));
  return 0;
}

function poseForState(state: MiiBoxerState, stateTime: number, hand: MiiBoxerHand): BoxerPose {
  if (state === 'idle') {
    return addPoseOffsets(copyPose(IDLE_POSE), {
      bodyY: Math.sin(stateTime * 2.1) * 0.012,
      leftElbowX: Math.sin(stateTime * 2.1 + 0.4) * 0.025,
      rightElbowX: Math.sin(stateTime * 2.1 - 0.4) * 0.025,
    });
  }
  if (state === 'guard') {
    const bounce = Math.sin(stateTime * 4.2);
    return addPoseOffsets(copyPose(GUARD_POSE), {
      bodyY: bounce * 0.018,
      bodyRotZ: Math.sin(stateTime * 2.1) * 0.018,
      leftHipX: bounce * 0.018,
      rightHipX: -bounce * 0.018,
    });
  }
  if (state === 'windup') {
    const pose = addPoseOffsets(copyPose(WINDUP_POSE), {
      bodyRotY: Math.sin(stateTime * 3.1) * 0.025,
      rightElbowX: Math.sin(stateTime * 3.1 + 0.8) * 0.05,
    });
    return hand === 'left' ? mirrorUpperBody(pose) : pose;
  }
  if (state === 'punch') {
    const extension = pulse01(stateTime, 0.09, 0.16, 0.34);
    return mixPose(GUARD_POSE, hand === 'left' ? mirrorUpperBody(PUNCH_EXTENDED_POSE) : PUNCH_EXTENDED_POSE, extension);
  }
  if (state === 'recover') {
    const balance = Math.sin(stateTime * 5.2);
    return addPoseOffsets(copyPose(RECOVER_POSE), {
      bodyRotZ: balance * 0.035,
      leftShoulderZ: balance * -0.04,
      rightShoulderZ: balance * -0.04,
    });
  }
  if (state === 'hit') {
    const recovery = smooth01(stateTime / 0.5);
    const pose = mixPose(HIT_IMPACT_POSE, HIT_RECOVERED_POSE, recovery);
    pose.bodyRotZ += Math.sin(stateTime * 22) * 0.04 * (1 - recovery);
    return pose;
  }
  if (state === 'dizzy') {
    const sway = Math.sin(stateTime * 3.2);
    const wobble = Math.sin(stateTime * 4.7 + 1.1);
    return addPoseOffsets(copyPose(DIZZY_POSE), {
      bodyRotZ: sway * 0.18,
      bodyRotX: wobble * 0.045,
      bodyY: Math.abs(sway) * -0.025,
      leftShoulderZ: wobble * -0.08,
      rightShoulderZ: wobble * 0.08,
      leftElbowX: sway * 0.12,
      rightElbowX: -sway * 0.12,
    });
  }
  if (state === 'knockdown') {
    const fall = smooth01(stateTime / 0.55);
    const pose = mixPose(HIT_IMPACT_POSE, KNOCKED_DOWN_POSE, fall);
    const settleAge = stateTime - 0.5;
    if (settleAge > 0) pose.bodyRotX += Math.sin(settleAge * 14) * 0.035 * Math.max(0, 1 - settleAge / 0.35);
    return pose;
  }
  const toKneeling = smooth01(stateTime / 0.45);
  const kneeling = mixPose(GETUP_START_POSE, GETUP_LOW_POSE, toKneeling);
  const rise = smooth01((stateTime - 0.55) / 0.8);
  return mixPose(kneeling, GUARD_POSE, rise);
}

function requireFiniteTime(timeSeconds: number): void {
  if (!Number.isFinite(timeSeconds)) throw new TypeError('timeSeconds must be finite');
}

/**
 * Creates a procedural Mii-style boxer. All same-joint parts are baked with vertex colors and
 * merged; the only extra mesh is the shared curved face patch. There are no external assets,
 * SkinnedMesh instances or InstancedMesh instances to dispose specially.
 */
export function createMiiBoxer(options: MiiBoxerOptions = {}): MiiBoxer {
  const {
    shirtColor = 0xffffff,
    trimColor = 0x2f9be8,
    skinColor: skinColorOption,
    shortsColor = 0x35516e,
    gloveColor = 0xd73731,
    shoeColor = 0xffffff,
    face = DEFAULT_MII_FACE_SPEC,
  } = options;
  const skinColor = skinColorOption ?? SKIN_PALETTE[face.skin];
  const root = new THREE.Group();
  root.name = 'mii-boxer';
  root.rotation.order = 'YXZ';
  const body = new THREE.Group();
  body.name = 'mii-boxer-body';
  body.rotation.order = 'YXZ';
  body.scale.setScalar(0.78);
  root.add(body);

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0 });
  const pending = new Map<THREE.Object3D, THREE.BufferGeometry[]>();
  const part = (
    geometry: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    y: number,
    parent: THREE.Object3D,
    z = 0,
  ) => {
    const parts = pending.get(parent) ?? [];
    parts.push(paint(geometry.translate(0, y, z), color));
    pending.set(parent, parts);
  };
  const joint = (name: string, x: number, y: number, parent: THREE.Object3D) => {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(x, y, 0);
    parent.add(group);
    return group;
  };

  // Broad-shouldered revolved torso, then head shape, hair and nose in the same static body mesh.
  const profile = [
    [0, -0.52],
    [0.22, -0.49],
    [0.29, -0.35],
    [0.26, -0.15],
    [0.33, 0.1],
    [0.39, 0.31],
    [0.34, 0.45],
    [0.17, 0.53],
    [0, 0.55],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  part(new THREE.LatheGeometry(profile, 20), shirtColor, 1.22, body);
  part(new THREE.CylinderGeometry(0.34, 0.31, 0.14, 20, 1, true), trimColor, 1.31, body);
  part(createMiiHeadGeometry(face), skinColor, 2.04, body);
  const hair = createMiiHairGeometry(face);
  if (hair) part(hair, miiHairColor(face), 2.04, body);
  part(createMiiNoseGeometry(face), skinColor, 2.04, body);

  const shoe = (width: number, height: number, length: number) =>
    new THREE.CapsuleGeometry(0.1, 0.2, 4, 12).rotateX(Math.PI / 2).scale(width, height, length);

  const limbs = [-1, 1].map((side) => {
    const sideName = side < 0 ? 'left' : 'right';
    const hip = joint(`mii-boxer-${sideName}-hip`, side * 0.18, 0.9, body);
    part(new THREE.CapsuleGeometry(0.14, 0.22, 4, 10), shortsColor, -0.2, hip);
    const knee = joint(`mii-boxer-${sideName}-knee`, 0, -0.42, hip);
    part(new THREE.CapsuleGeometry(0.105, 0.24, 4, 10), skinColor, -0.2, knee);
    part(shoe(1.16, 0.78, 1), shoeColor, -0.42, knee, -0.07);
    part(shoe(1.2, 0.3, 1.04), trimColor, -0.48, knee, -0.07);

    const shoulder = joint(`mii-boxer-${sideName}-shoulder`, side * 0.43, 1.51, body);
    part(new THREE.CapsuleGeometry(0.105, 0.18, 4, 10), shirtColor, -0.16, shoulder);
    const elbow = joint(`mii-boxer-${sideName}-elbow`, 0, -0.34, shoulder);
    part(new THREE.CapsuleGeometry(0.082, 0.18, 4, 10), skinColor, -0.13, elbow);
    part(new THREE.CylinderGeometry(0.125, 0.14, 0.13, 14), trimColor, -0.2, elbow);
    // Two overlapping rounded masses read as a boxing glove even though they merge into the elbow draw call.
    part(new THREE.SphereGeometry(0.18, 16, 12).scale(1.05, 1.15, 1.25), gloveColor, -0.34, elbow, -0.02);
    part(
      new THREE.SphereGeometry(0.095, 12, 8).scale(0.82, 0.9, 1.1).translate(-side * 0.1, -0.02, -0.04),
      gloveColor,
      -0.32,
      elbow,
      -0.02,
    );
    return { hip, knee, shoulder, elbow };
  });

  for (const [parent, parts] of pending) {
    const mesh = new THREE.Mesh(merge(parts), material);
    mesh.name = `${parent.name || 'mii-boxer'}-parts`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  const facePatch = createMiiFacePatch(face);
  body.add(facePatch.object);

  const left = limbs[0]!;
  const right = limbs[1]!;
  let currentTime = 0;
  let state: MiiBoxerState = 'idle';
  let stateHand: MiiBoxerHand = 'right';
  let stride: Stride = { speed01: 0, forward: 0, strafe: 0 };
  let animatedAt: number | undefined;
  let stateStartedAt = 0;
  let transitionStartedAt = 0;
  const initialPose = poseForState('idle', 0, 'right');
  let transitionFrom = copyPose(initialPose);
  let currentPose = copyPose(initialPose);

  const applyPose = (pose: BoxerPose): void => {
    body.position.y = pose.bodyY;
    body.rotation.set(pose.bodyRotX, pose.bodyRotY, pose.bodyRotZ);
    left.hip.rotation.set(pose.leftHipX, 0, pose.leftHipZ);
    left.knee.rotation.x = pose.leftKneeX;
    right.hip.rotation.set(pose.rightHipX, 0, pose.rightHipZ);
    right.knee.rotation.x = pose.rightKneeX;
    left.shoulder.rotation.set(pose.leftShoulderX, pose.leftShoulderY, pose.leftShoulderZ);
    left.elbow.rotation.set(pose.leftElbowX, pose.leftElbowY, pose.leftElbowZ);
    right.shoulder.rotation.set(pose.rightShoulderX, pose.rightShoulderY, pose.rightShoulderZ);
    right.elbow.rotation.set(pose.rightElbowX, pose.rightElbowY, pose.rightElbowZ);
  };

  return {
    root,
    facePatch,
    setState(nextState, hand = 'right') {
      if (nextState === state && hand === stateHand) return;
      stateHand = hand;
      transitionFrom = copyPose(currentPose);
      transitionStartedAt = currentTime;
      state = nextState;
      stateStartedAt = currentTime;
    },
    animate(timeSeconds, footwork) {
      requireFiniteTime(timeSeconds);
      currentTime = timeSeconds;
      const target = poseForState(state, Math.max(0, timeSeconds - stateStartedAt), stateHand);
      const transition = smooth01((timeSeconds - transitionStartedAt) / TRANSITION_SECONDS[state]);
      currentPose = mixPose(transitionFrom, target, transition);
      stride = stepStride(stride, Math.max(0, timeSeconds - (animatedAt ?? timeSeconds)), footwork);
      animatedAt = timeSeconds;
      applyPose(withFootwork(currentPose, timeSeconds, stride));
    },
  };
}

/**
 * Creates translucent viewer-space boxing gloves. Each glove is one merged mesh, so the pair costs
 * two draw calls and can be disposed with `disposeObjectTree` like any other normal hierarchy.
 */
export function createFirstPersonGloves(): FirstPersonGloves {
  const root = new THREE.Group();
  root.name = 'first-person-gloves';
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.56,
    roughness: 0.32,
    metalness: 0,
    depthWrite: false,
  });

  const makeGlove = (side: -1 | 1) => {
    const group = new THREE.Group();
    group.name = side < 0 ? 'first-person-left-glove' : 'first-person-right-glove';
    const parts = [
      paint(new THREE.SphereGeometry(0.18, 18, 14).scale(1.08, 0.96, 1.28), 0xd73731),
      paint(
        new THREE.SphereGeometry(0.095, 12, 9).scale(0.82, 0.78, 1.08).translate(-side * 0.115, -0.015, 0.015),
        0xb92724,
      ),
      paint(
        new THREE.CylinderGeometry(0.125, 0.145, 0.17, 16).rotateX(Math.PI / 2).translate(0, -0.01, 0.19),
        0xf4f0df,
      ),
    ];
    const mesh = new THREE.Mesh(merge(parts), material);
    mesh.name = `${group.name}-parts`;
    group.add(mesh);
    // Small enough that both fists frame the opponent instead of hiding them.
    group.scale.setScalar(0.6);
    root.add(group);
    return group;
  };

  const left = makeGlove(-1);
  const right = makeGlove(1);
  const input01 = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    return Number.isFinite(value) ? clamp01(value) : fallback;
  };

  return {
    root,
    animate(timeSeconds, input = {}) {
      requireFiniteTime(timeSeconds);
      const guard = input01(input.guard, 0.65);
      const sway = Math.sin(timeSeconds * 1.35) * 0.012;
      for (const [side, glove] of [
        [-1, left],
        [1, right],
      ] as const) {
        const punch = input01(side < 0 ? input.leftPunch : input.rightPunch, 0);
        const phase = side < 0 ? 0 : 1.35;
        const bob = Math.sin(timeSeconds * 2.2 + phase) * 0.014;
        glove.position.set(
          side * (0.5 - 0.1 * guard - 0.2 * punch) + sway,
          -0.43 + 0.17 * guard + 0.17 * punch + bob,
          -0.86 + 0.08 * guard - 0.43 * punch,
        );
        glove.rotation.set(
          -0.1 - 0.16 * guard - 0.22 * punch + bob * 1.6,
          side * (0.18 - 0.08 * guard - 0.08 * punch),
          side * (0.08 + 0.1 * guard) + sway * 1.5,
        );
      }
    },
  };
}
