import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { BODY_JOINTS } from './bodyFeatures';
import { bodyLocalPoint } from './bodyFrame';
import { clamp, isFinitePoint, landmarkConfidence } from './math';

export interface PunchSignal {
  power01: number;
  confidence: number;
  peakTimestampMs: number;
  /** Frame where the onset conditions were met. */
  onsetTimestampMs: number;
}

/**
 * Same contract as SwingOutput: `onset` is the unconfirmed real-time notice, for animation only;
 * `confirmed` is the measured punch, emitted once extension and forward travel are both proven.
 */
export type PunchOutput =
  | { kind: 'onset'; timestampMs: number }
  | ({ kind: 'confirmed' } & PunchSignal);

/**
 * Punch thresholds. Tunable guesses checked only against synthetic poses, not yet calibrated
 * against recorded players. Speeds and travel are in shoulder widths (per second); elbow values
 * are the articulation cosine, +1 meaning a straight arm.
 */
export const PUNCH_THRESHOLDS = {
  /** Forward wrist speed and elbow opening rate that must coincide to start a punch. */
  onsetForwardSpeed: 1.5,
  onsetElbowCosineRatePerSec: 0.5,
  /** Peak forward speed that reads as power 1. */
  fullPowerForwardSpeed: 6,
  /** Extension and travel a punch must reach. Travel sits below a 0.35-width short jab: at 15 fps
   * the first moving sample is slower than the onset speed and falls outside the measure. */
  confirmElbowCosine: 0.65,
  confirmForwardTravel: 0.25,
  maxDurationMs: 350,
  /** The punch ends once speed falls to this share of its peak, or the wrist comes back this fast. */
  deceleratedPeakRatio: 0.65,
  retractingForwardSpeed: -0.5,
  /** Re-arm by retraction: elbow bent past this for the dwell. */
  retractedElbowCosine: 0.4,
  retractedDwellMs: 80,
  /** Re-arm by rest, for players who barely retract: forward speed below this for the dwell. */
  restForwardSpeed: 0.8,
  restDwellMs: 250,
  refractoryMs: 250,
  /** A longer gap between samples restarts the detector. */
  maxSampleGapMs: 200,
} as const;
// Much lighter than SwingDetector's smoothing: a jab spans only 2-5 samples, and a 1 Hz cutoff
// would lag it below both confirmation thresholds.
const FILTER_OPTIONS = { minCutoff: 4, beta: 1, derivativeCutoff: 1 };

interface PendingPunch {
  startedAt: number;
  /** Forward position on the sample before onset: where the motion started. */
  originForward: number;
  peak: { speed: number; confidence: number; timestampMs: number };
  /** Extension and travel were both met on one sample inside the window. */
  reached: boolean;
}

function elbowCosine(shoulder: Point3, elbow: Point3, wrist: Point3): number | undefined {
  const upper = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y, z: elbow.z - shoulder.z };
  const fore = { x: wrist.x - elbow.x, y: wrist.y - elbow.y, z: wrist.z - elbow.z };
  const lengths = Math.hypot(upper.x, upper.y, upper.z) * Math.hypot(fore.x, fore.y, fore.z);
  if (lengths <= 1e-8) return undefined;
  return clamp((upper.x * fore.x + upper.y * fore.y + upper.z * fore.z) / lengths, -1, 1);
}

/**
 * Guard stance limits, relative to each wrist's own shoulder in shoulder widths. Tunable guesses,
 * checked only against synthetic poses.
 */
export const GUARD_THRESHOLDS = {
  /** Wrist height window: from just below the shoulder up to around the forehead. */
  minWristHeight: -0.35,
  maxWristHeight: 0.9,
  /** Sideways distance from the shoulder; wider than this the fist is not covering anything. */
  maxWristSide: 0.8,
  /** The arm must be folded: an extended arm at shoulder height is a punch, not a guard. */
  maxElbowCosine: 0.3,
  minConfidence: 0.5,
} as const;

/** True when both fists are up near shoulder or chin height with the arms folded. */
export function isGuardingPose(snapshot: PoseSnapshot, calibration: CalibrationProfile): boolean {
  const world = snapshot.worldLandmarks;
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [world[11], world[12], world[23], world[24]];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return false;
  return BODY_JOINTS.slice(0, 2).every(([, shoulderIndex, elbowIndex, wristIndex]) => {
    const shoulder = world[shoulderIndex];
    const elbow = world[elbowIndex];
    const wrist = world[wristIndex];
    if (!shoulder || !elbow || !wrist) return false;
    if (landmarkConfidence(shoulder, elbow, wrist) < GUARD_THRESHOLDS.minConfidence) return false;
    const local = bodyLocalPoint(wrist, shoulder, leftShoulder, rightShoulder, leftHip, rightHip, calibration.world.shoulderWidth);
    const cosine = elbowCosine(shoulder, elbow, wrist);
    return local !== undefined && cosine !== undefined
      && local.y >= GUARD_THRESHOLDS.minWristHeight && local.y <= GUARD_THRESHOLDS.maxWristHeight
      && Math.abs(local.x) <= GUARD_THRESHOLDS.maxWristSide
      && cosine <= GUARD_THRESHOLDS.maxElbowCosine;
  });
}

export class PunchDetector {
  constructor(private readonly hand: Hand) {}

  private readonly forwardFilter = new OneEuroFilter(FILTER_OPTIONS);
  private readonly elbowFilter = new OneEuroFilter(FILTER_OPTIONS);
  private previous?: { forward: number; cosine: number; time: number };
  private mode: 'ready' | 'punch' | 'return' = 'ready';
  private pending?: PendingPunch;
  private lastPunchAt = Number.NEGATIVE_INFINITY;
  private retractedSince?: number;
  private restSince?: number;

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): PunchOutput | undefined {
    const world = snapshot.worldLandmarks;
    const [, shoulderIndex, elbowIndex, wristIndex] = BODY_JOINTS[this.hand === 'right' ? 1 : 0];
    const shoulder = world[shoulderIndex];
    const elbow = world[elbowIndex];
    const wrist = world[wristIndex];
    const leftShoulder = world[11];
    const rightShoulder = world[12];
    const leftHip = world[23];
    const rightHip = world[24];
    if (!isFinitePoint(shoulder) || !isFinitePoint(elbow) || !isFinitePoint(wrist) || !isFinitePoint(leftShoulder)
      || !isFinitePoint(rightShoulder) || !isFinitePoint(leftHip) || !isFinitePoint(rightHip)) { this.reset(); return undefined; }
    const localWrist = bodyLocalPoint(wrist, shoulder, leftShoulder, rightShoulder, leftHip, rightHip, calibration.world.shoulderWidth);
    const rawCosine = elbowCosine(shoulder, elbow, wrist);
    if (!localWrist || rawCosine === undefined) { this.reset(); return undefined; }

    const time = snapshot.timestampMs;
    // Velocity across a long gap is meaningless: restart the chain and demand a fresh re-arm.
    if (this.previous && time - this.previous.time > PUNCH_THRESHOLDS.maxSampleGapMs) this.reset();
    const current = {
      // Body depth points away from the camera when facing it, so forward is decreasing local z.
      forward: this.forwardFilter.filter(-localWrist.z, time),
      cosine: this.elbowFilter.filter(rawCosine, time),
      time,
    };
    const previous = this.previous;
    this.previous = current;
    if (!previous) return undefined;

    const dt = Math.max((time - previous.time) / 1000, 1 / 120);
    const speed = (current.forward - previous.forward) / dt;
    const confidence = landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip, elbow, wrist);

    if (this.mode === 'ready') {
      const extending = (current.cosine - previous.cosine) / dt >= PUNCH_THRESHOLDS.onsetElbowCosineRatePerSec;
      if (!extending || speed < PUNCH_THRESHOLDS.onsetForwardSpeed || time - this.lastPunchAt < PUNCH_THRESHOLDS.refractoryMs) return undefined;
      this.pending = {
        startedAt: time,
        originForward: previous.forward,
        peak: { speed, confidence, timestampMs: time },
        reached: false,
      };
      this.mode = 'punch';
      this.lastPunchAt = time;
      return { kind: 'onset', timestampMs: time };
    }

    if (this.mode === 'punch' && this.pending) {
      const pending = this.pending;
      const ageMs = time - pending.startedAt;
      if (speed > pending.peak.speed) pending.peak = { speed, confidence, timestampMs: time };
      if (ageMs <= PUNCH_THRESHOLDS.maxDurationMs && current.cosine >= PUNCH_THRESHOLDS.confirmElbowCosine
        && current.forward - pending.originForward >= PUNCH_THRESHOLDS.confirmForwardTravel) pending.reached = true;
      const retracting = speed <= PUNCH_THRESHOLDS.retractingForwardSpeed;
      const decelerated = pending.reached && speed <= pending.peak.speed * PUNCH_THRESHOLDS.deceleratedPeakRatio;
      if (!retracting && !decelerated && ageMs < PUNCH_THRESHOLDS.maxDurationMs) return undefined;

      this.pending = undefined;
      this.retractedSince = undefined;
      this.restSince = undefined;
      this.mode = 'return';
      if (!pending.reached) return undefined;
      return {
        kind: 'confirmed',
        power01: clamp((pending.peak.speed - PUNCH_THRESHOLDS.onsetForwardSpeed) / (PUNCH_THRESHOLDS.fullPowerForwardSpeed - PUNCH_THRESHOLDS.onsetForwardSpeed)),
        confidence: pending.peak.confidence,
        peakTimestampMs: pending.peak.timestampMs,
        onsetTimestampMs: pending.startedAt,
      };
    }

    if (current.cosine < PUNCH_THRESHOLDS.retractedElbowCosine) this.retractedSince ??= time;
    else this.retractedSince = undefined;
    if (Math.abs(speed) < PUNCH_THRESHOLDS.restForwardSpeed) this.restSince ??= time;
    else this.restSince = undefined;
    const retracted = this.retractedSince !== undefined && time - this.retractedSince >= PUNCH_THRESHOLDS.retractedDwellMs;
    const rested = this.restSince !== undefined && time - this.restSince >= PUNCH_THRESHOLDS.restDwellMs;
    if (retracted || rested) {
      this.mode = 'ready';
      this.interruptRearm();
    }
    return undefined;
  }

  /** Explicitly rejected/degraded samples break re-arm continuity even when no valid sample reaches this detector. */
  interruptRearm(): void { this.retractedSince = undefined; this.restSince = undefined; }

  reset(): void { this.forwardFilter.reset(); this.elbowFilter.reset(); this.previous = undefined; this.mode = 'return'; this.pending = undefined; this.lastPunchAt = Number.NEGATIVE_INFINITY; this.interruptRearm(); }
}
