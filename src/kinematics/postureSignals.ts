import type { CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { clamp, median, midpoint } from './math';

const MIN_SHOULDER_WIDTH = 0.03;
const MIN_TORSO_HEIGHT = 0.03;
/** Into a side lane past this displacement, in shoulder widths — a deliberate but comfortable lean. */
export const ENTER_LANE_SW = 0.12;
/** Back to center inside this displacement — the hysteresis gap keeps zone noise from flapping lanes. */
export const EXIT_LANE_SW = 0.05;
/** The width used as the unit never drops below this share of the recently observed width. */
const WIDTH_FLOOR_RATIO = 0.9;
/** How fast the observed width follows shoulders that stay narrower, e.g. after stepping back. */
const WIDTH_DECAY_MS = 3000;

/**
 * Aspect-corrected distance in frame widths. x is normalized by frame width and y by frame height
 * independently, so a raw hypot would mix units: in landscape frames the y contribution is
 * over-weighted and the shoulder width would inflate as the shoulders tilt in-plane — exactly
 * while the player leans to dodge.
 */
function imageSpan(a: { x: number; y: number }, b: { x: number; y: number }, snapshot: PoseSnapshot): number {
  return Math.hypot(a.x - b.x, (a.y - b.y) * (snapshot.frameHeight / snapshot.frameWidth));
}

/** The frame's shoulder width, or undefined when the shoulders are unreadable. */
function shoulderSpan(snapshot: PoseSnapshot): number | undefined {
  const left = snapshot.landmarks[11];
  const right = snapshot.landmarks[12];
  if (!left || !right) return undefined;
  const width = imageSpan(left, right, snapshot);
  return Number.isFinite(width) && width >= MIN_SHOULDER_WIDTH ? width : undefined;
}

/**
 * The shoulder width used as the unit for lateral displacement. Torso yaw (a punch) foreshortens
 * the shoulder line for a moment; dividing by that narrow width would inflate a small sway into a
 * big move, so the unit is floored by the widest recent width.
 */
export class ShoulderUnit {
  /** Widest recent shoulder width, decaying toward the current one. */
  private reference?: { width: number; atMs: number };

  update(snapshot: PoseSnapshot): number | undefined {
    const width = shoulderSpan(snapshot);
    if (width === undefined) return undefined;
    const elapsedMs = this.reference ? Math.max(0, snapshot.timestampMs - this.reference.atMs) : 0;
    const decayed = this.reference ? width + (this.reference.width - width) * Math.exp(-elapsedMs / WIDTH_DECAY_MS) : width;
    const reference = Math.max(width, decayed);
    this.reference = { width: reference, atMs: snapshot.timestampMs };
    return Math.max(width, reference * WIDTH_FLOOR_RATIO);
  }

  reset(): void { this.reference = undefined; }
}

/**
 * Lane control by body position, not gesture: the lane follows where the player's torso actually
 * is, continuously — lean the trunk or step sideways, both move the shoulder center the same way.
 * Measured against the calibrated neutral center in the frame's own shoulder widths, positive
 * toward the player's right: in raw camera coordinates the player's right is toward image left,
 * so rightward displacement is centerX0 − centerX. Position cannot invert the way an
 * edge-triggered lean gesture did — returning to center at worst leaves the side lane, and
 * snap-back overshoot past center is just noise below the opposite threshold.
 */
export class LanePositionTracker {
  private readonly filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4, derivativeCutoff: 1 });
  private zone: -1 | 0 | 1 = 0;
  private readonly unit = new ShoulderUnit();

  /** The lane zone the body currently occupies, or undefined when the shoulders are unreadable. */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): -1 | 0 | 1 | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    const unit = this.unit.update(snapshot);
    if (!leftShoulder || !rightShoulder || unit === undefined) return undefined;
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;
    const displacement = (calibration.image.shoulderCenterX0 - centerX) / unit;
    const u = this.filter.filter(displacement, snapshot.timestampMs);
    if (this.zone === 0) {
      if (u >= ENTER_LANE_SW) this.zone = 1;
      else if (u <= -ENTER_LANE_SW) this.zone = -1;
    } else if (this.zone === 1 && u <= EXIT_LANE_SW) this.zone = 0;
    else if (this.zone === -1 && u >= -EXIT_LANE_SW) this.zone = 0;
    return this.zone;
  }

  /** The zone the state machine currently believes the body occupies — even while updates pause. */
  get currentZone(): -1 | 0 | 1 { return this.zone; }

  reset(): void { this.filter.reset(); this.zone = 0; this.unit.reset(); }
}

/** Step in past these width ratios to the calibrated one; return to neutral inside the inner pair. */
const ENTER_NEAR_RATIO = 1.15;
const EXIT_NEAR_RATIO = 1.07;
const ENTER_FAR_RATIO = 0.85;
const EXIT_FAR_RATIO = 0.93;
/** A step has to outlast a momentary change of apparent size. */
const DEPTH_HOLD_MS = 300;
/** Size change that reads as no approach speed, and the one that reads as full speed. */
export const DEPTH_DEAD_BAND = 0.07;
export const DEPTH_FULL_SPEED = 0.25;
/** Readings after calibration that settle the torso reference. */
const TORSO_REFERENCE_SAMPLES = 10;

/**
 * How much closer than calibrated the body looks. A step scales width and height together; torso
 * yaw narrows only the shoulders and a waist bend shortens only the torso. So only the change both
 * measures agree on counts: the smaller one when they agree on direction, none when they do not.
 */
function agreedSizeRatio(widthRatio: number, torsoRatio: number): number {
  if (widthRatio > 1 && torsoRatio > 1) return Math.min(widthRatio, torsoRatio);
  if (widthRatio < 1 && torsoRatio < 1) return Math.max(widthRatio, torsoRatio);
  return 1;
}

/**
 * Depth control by apparent size: a body bigger than at the calibrated neutral means the player
 * stepped toward the camera (1), smaller means they stepped back (-1).
 */
export class RingDepthTracker {
  // MediaPipe VIDEO mode already smooths the landmarks: this filter stays light to avoid lag.
  private readonly filter = new OneEuroFilter({ minCutoff: 3, beta: 1, derivativeCutoff: 1 });
  private move: -1 | 0 | 1 = 0;
  private speed?: number;
  private pending?: { move: -1 | 1; sinceMs: number };
  /** The profile has no torso reference: derived from the first readings against its width. */
  private torso?: { widthReference: number; samples: number[] };

  /**
   * The current step, or undefined without a reference width or a readable torso. While `punching`
   * the step and the approach speed hold their last values.
   */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile, punching = false): -1 | 0 | 1 | undefined {
    const reference = calibration.image.shoulderWidth0;
    const width = shoulderSpan(snapshot);
    const [leftShoulder, rightShoulder, leftHip, rightHip] = [11, 12, 23, 24].map((index) => snapshot.landmarks[index]);
    if (!reference || width === undefined || !leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
    const torsoHeight = imageSpan(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip), snapshot);
    if (!Number.isFinite(torsoHeight) || torsoHeight < MIN_TORSO_HEIGHT) return undefined;
    if (punching) {
      // A step still waiting out its hold must not count the punch as time held.
      this.pending = undefined;
      return this.move;
    }
    if (this.torso?.widthReference !== reference) this.torso = { widthReference: reference, samples: [] };
    // Scaled to the calibrated distance, so a player mid-step on these frames does not skew it.
    if (this.torso.samples.length < TORSO_REFERENCE_SAMPLES) this.torso.samples.push(torsoHeight * reference / width);
    const ratio = this.filter.filter(agreedSizeRatio(width / reference, torsoHeight / median(this.torso.samples)), snapshot.timestampMs);
    const offset = ratio - 1;
    this.speed = Math.abs(offset) <= DEPTH_DEAD_BAND
      ? 0
      : Math.sign(offset) * clamp((Math.abs(offset) - DEPTH_DEAD_BAND) / (DEPTH_FULL_SPEED - DEPTH_DEAD_BAND));
    if ((this.move === 1 && ratio <= EXIT_NEAR_RATIO) || (this.move === -1 && ratio >= EXIT_FAR_RATIO)) this.move = 0;
    const wanted = ratio >= ENTER_NEAR_RATIO ? 1 : ratio <= ENTER_FAR_RATIO ? -1 : undefined;
    if (wanted === undefined || wanted === this.move) this.pending = undefined;
    else {
      if (this.pending?.move !== wanted) this.pending = { move: wanted, sinceMs: snapshot.timestampMs };
      if (snapshot.timestampMs - this.pending.sinceMs >= DEPTH_HOLD_MS) {
        this.move = wanted;
        this.pending = undefined;
      }
    }
    return this.move;
  }

  /** Signed approach speed -1..1 as of the last unfrozen reading, positive toward the camera. */
  get approach01(): number | undefined { return this.speed; }

  reset(): void { this.filter.reset(); this.move = 0; this.speed = undefined; this.pending = undefined; this.torso = undefined; }
}
