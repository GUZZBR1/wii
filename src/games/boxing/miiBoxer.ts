import * as THREE from 'three';
import {
  createMiiFacePatch,
  createMiiHairGeometry,
  createMiiHeadGeometry,
  createMiiNoseGeometry,
  miiHairColor,
  type MiiFaceMount,
} from '../../mii/miiHead';
import { DEFAULT_MII_FACE_SPEC, SKIN_PALETTE, type MiiFaceSpec } from '../../mii/miiSpec';
import { merge, paint } from '../core/vertexPaint';

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

export type MiiBoxerState = 'idle' | 'ready' | 'guard' | 'windup' | 'punch' | 'recover' | 'hit' | 'dizzy' | 'knockdown' | 'getup';
type MiiBoxerHand = 'left' | 'right';

export interface MiiBoxerOptions {
  shirtColor?: THREE.ColorRepresentation;
  trimColor?: THREE.ColorRepresentation;
  skinColor?: THREE.ColorRepresentation;
  shortsColor?: THREE.ColorRepresentation;
  gloveColor?: THREE.ColorRepresentation;
  shoeColor?: THREE.ColorRepresentation;
  face?: MiiFaceSpec;
  /** How much faster than the default this boxer throws a punch; the crest comes that much sooner. */
  punchSpeed?: number;
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
   * Selects the next animation target at the boxer's internal clock: the latest time passed to
   * `animate`, or zero for a newly created boxer. Re-selecting the current state and hand is a
   * no-op, so per-frame state broadcasts do not restart one-shot motions. `punch` follows through
   * and returns over 0.34 s, `hit` settles over 0.5 s, `knockdown` falls over 0.55 s and `getup`
   * recovers over about 1.35 s, all measured from state entry; the other states loop until replaced.
   * `hand` picks the arm for `windup` and `punch`.
   */
  setState(state: MiiBoxerState, hand?: MiiBoxerHand): void;
  /**
   * Poses the boxer for an explicit, normally monotonic clock in seconds. No wall-clock timers
   * are read; repeating the same sequence of `setState`/`animate` calls gives the same pose. Joints
   * move with critically damped springs, so interrupted state changes keep their momentum. Footwork
   * adds a small leg/trunk stride whose speed and direction ramp over elapsed animation time and,
   * when the input slows or stops, fade out instead of snapping the legs.
   * @throws TypeError when `timeSeconds` is not finite.
   */
  animate(timeSeconds: number, footwork?: MiiBoxerFootwork): void;
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

/**
 * Angular frequency of the per-state critically damped joint springs, preserving the approximate
 * timing of the old fixed transition durations: punches snap, one-shot reactions bite quickly and
 * the loose states lean slower.
 */
const STATE_OMEGA: Record<MiiBoxerState, number> = {
  idle: 16,
  ready: 24,
  guard: 24,
  windup: 28,
  punch: 48,
  recover: 20,
  hit: 38,
  dizzy: 16,
  knockdown: 30,
  getup: 22,
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

/** Time constants of the footwork envelope; release stays slightly softer than acceleration. */
const FOOTWORK_ATTACK_S = 0.075;
const FOOTWORK_RELEASE_S = 0.09;
const FOOTWORK_DIRECTION_S = 0.085;
const FOOTWORK_EPSILON = 1e-3;
const STRIDE_RATE_RAD_S = 8.4;
const STRIDE_CYCLE_RAD = Math.PI * 2;

interface Stride {
  speed01: number;
  forward: number;
  strafe: number;
  phase: number;
}

function approachExponential(current: number, target: number, dtS: number, timeConstantS: number): number {
  if (dtS <= 0 || current === target) return current;
  const next = target + (current - target) * Math.exp(-dtS / timeConstantS);
  return Math.abs(next - target) < FOOTWORK_EPSILON ? target : next;
}

/** Speed and heading are control envelopes: they ramp continuously and keep the last heading once stopped. */
function stepStride(stride: Stride, dtS: number, footwork: MiiBoxerFootwork | undefined): Stride {
  const targetSpeed =
    footwork?.speed01 === undefined || !Number.isFinite(footwork.speed01) ? 0 : clamp01(footwork.speed01);
  const speed01 = approachExponential(
    stride.speed01,
    targetSpeed,
    dtS,
    targetSpeed > stride.speed01 ? FOOTWORK_ATTACK_S : FOOTWORK_RELEASE_S,
  );
  let { forward, strafe } = stride;
  if (targetSpeed > 0) {
    forward = approachExponential(forward, clampSignedUnit(footwork?.forward), dtS, FOOTWORK_DIRECTION_S);
    strafe = approachExponential(strafe, clampSignedUnit(footwork?.strafe), dtS, FOOTWORK_DIRECTION_S);
  }
  let phase = stride.phase;
  if (speed01 > 0) phase = (phase + dtS * STRIDE_RATE_RAD_S) % STRIDE_CYCLE_RAD;
  return { speed01, forward, strafe, phase };
}

function withFootwork(pose: BoxerPose, { speed01, forward, strafe, phase }: Stride): BoxerPose {
  if (speed01 === 0) return pose;
  const stride = Math.sin(phase) * speed01;
  const lift = Math.abs(Math.cos(phase)) * speed01;
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

/** The attack peaks here: fast enough to snap, late enough that contact lands near full extension. */
const PUNCH_ATTACK_S = 0.16;
const PUNCH_END_S = 0.34;

/**
 * Single-peak punch extension: a fast smoothstep attack, then immediately a smoothstep return
 * whose zero slope at the peak reads as a slight follow-through. There is no hold plateau and the
 * curve rests at exactly zero from `PUNCH_END_S` on.
 */
function punchExtensionAmount(ageS: number): number {
  if (ageS <= 0 || ageS >= PUNCH_END_S) return 0;
  if (ageS < PUNCH_ATTACK_S) return smooth01(ageS / PUNCH_ATTACK_S);
  return 1 - smooth01((ageS - PUNCH_ATTACK_S) / (PUNCH_END_S - PUNCH_ATTACK_S));
}

function poseForState(
  state: MiiBoxerState,
  stateTime: number,
  hand: MiiBoxerHand,
  entryPose: BoxerPose = GUARD_POSE,
): BoxerPose {
  if (state === 'idle') {
    return addPoseOffsets(copyPose(IDLE_POSE), {
      bodyY: Math.sin(stateTime * 2.1) * 0.012,
      leftElbowX: Math.sin(stateTime * 2.1 + 0.4) * 0.025,
      rightElbowX: Math.sin(stateTime * 2.1 - 0.4) * 0.025,
    });
  }
  // Between exchanges: fists up but below the chin, so raising the guard still reads.
  if (state === 'ready') {
    const pose = mixPose(IDLE_POSE, GUARD_POSE, 0.6);
    pose.bodyY += Math.sin(stateTime * 4.2) * 0.012;
    return pose;
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
    // The base is the captured entry pose blending back to guard over the return, so the punch
    // launches from wherever the boxer actually was instead of snapping the target to guard.
    const extended = hand === 'left' ? mirrorUpperBody(PUNCH_EXTENDED_POSE) : PUNCH_EXTENDED_POSE;
    const baseBlend = smooth01((stateTime - PUNCH_ATTACK_S) / (PUNCH_END_S - PUNCH_ATTACK_S));
    const base = mixPose(entryPose, GUARD_POSE, baseBlend);
    return mixPose(base, extended, punchExtensionAmount(stateTime));
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

function zeroPose(): BoxerPose {
  const pose = {} as BoxerPose;
  for (const key of POSE_KEYS) pose[key] = 0;
  return pose;
}

function positiveFiniteDt(fromS: number, toS: number): number {
  const dtS = toS - fromS;
  return dtS > 0 && Number.isFinite(dtS) ? dtS : 0;
}

/** Exact critically damped spring step for every joint, stable for any positive finite `dtS`. */
function stepPoseSpring(pose: BoxerPose, velocity: BoxerPose, target: BoxerPose, dtS: number, omega: number): void {
  if (dtS <= 0) return;
  const decay = Math.exp(-omega * dtS);
  if (decay === 0) {
    for (const key of POSE_KEYS) {
      pose[key] = target[key];
      velocity[key] = 0;
    }
    return;
  }
  for (const key of POSE_KEYS) {
    const offset = pose[key] - target[key];
    const drive = velocity[key] + omega * offset;
    pose[key] = target[key] + (offset + drive * dtS) * decay;
    velocity[key] = (velocity[key] - omega * drive * dtS) * decay;
  }
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
    punchSpeed = 1,
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
  let stride: Stride = { speed01: 0, forward: 0, strafe: 0, phase: 0 };
  let stateStartedAt = 0;
  const initialPose = poseForState('idle', 0, 'right');
  let stateEntryPose = copyPose(initialPose);
  // Mutated in place by the spring step, so the binding itself never changes.
  const currentPose = copyPose(initialPose);
  const poseVelocity = zeroPose();

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
      stateEntryPose = copyPose(currentPose);
      state = nextState;
      stateStartedAt = currentTime;
    },
    animate(timeSeconds, footwork) {
      requireFiniteTime(timeSeconds);
      // The clock starts at zero for a new boxer, so the first step covers everything since then.
      const dtS = positiveFiniteDt(currentTime, timeSeconds);
      currentTime = timeSeconds;
      // A faster punch is the same curve and spring on a compressed clock.
      const rate = state === 'punch' ? punchSpeed : 1;
      const target = poseForState(state, Math.max(0, timeSeconds - stateStartedAt) * rate, stateHand, stateEntryPose);
      stepPoseSpring(currentPose, poseVelocity, target, dtS * rate, STATE_OMEGA[state]);
      stride = stepStride(stride, dtS, footwork);
      applyPose(withFootwork(currentPose, stride));
    },
  };
}
