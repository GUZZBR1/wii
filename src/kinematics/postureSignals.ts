import type { CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';

const MIN_SHOULDER_WIDTH = 0.03;
/** Into a side lane past this displacement, in shoulder widths — a deliberate but comfortable lean. */
export const ENTER_LANE_SW = 0.12;
/** Back to center inside this displacement — the hysteresis gap keeps zone noise from flapping lanes. */
export const EXIT_LANE_SW = 0.05;
/** The width used as the unit never drops below this share of the recently observed width. */
const WIDTH_FLOOR_RATIO = 0.9;
/** How fast the observed width follows shoulders that stay narrower, e.g. after stepping back. */
const WIDTH_DECAY_MS = 3000;

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
  /** Widest recent shoulder width, decaying toward the current one. */
  private reference?: { width: number; atMs: number };

  /** The lane zone the body currently occupies, or undefined when the shoulders are unreadable. */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): -1 | 0 | 1 | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    if (!leftShoulder || !rightShoulder) return undefined;
    // x is normalized by frame width and y by frame height independently, so a raw hypot would
    // mix units: in landscape frames the y contribution is over-weighted and the measured width
    // would inflate as the shoulders tilt in-plane — exactly while the player leans to dodge.
    const aspect = snapshot.frameHeight / snapshot.frameWidth;
    const width = Math.hypot(leftShoulder.x - rightShoulder.x, (leftShoulder.y - rightShoulder.y) * aspect);
    if (!Number.isFinite(width) || width < MIN_SHOULDER_WIDTH) return undefined;
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;
    // Torso yaw (a punch) foreshortens the shoulder line for a moment. Dividing by that narrow
    // width would inflate a small sway into a lane change, so the unit is floored.
    const elapsedMs = this.reference ? Math.max(0, snapshot.timestampMs - this.reference.atMs) : 0;
    const decayed = this.reference ? width + (this.reference.width - width) * Math.exp(-elapsedMs / WIDTH_DECAY_MS) : width;
    const reference = Math.max(width, decayed);
    this.reference = { width: reference, atMs: snapshot.timestampMs };
    const displacement = (calibration.image.shoulderCenterX0 - centerX) / Math.max(width, reference * WIDTH_FLOOR_RATIO);
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

  reset(): void { this.filter.reset(); this.zone = 0; this.reference = undefined; }
}

/** Step in past these width ratios to the calibrated one; return to neutral inside the inner pair. */
const ENTER_NEAR_RATIO = 1.15;
const EXIT_NEAR_RATIO = 1.07;
const ENTER_FAR_RATIO = 0.85;
const EXIT_FAR_RATIO = 0.93;
/** A punch turns the torso and narrows the shoulders for a moment: a step has to outlast that. */
const DEPTH_HOLD_MS = 300;

/**
 * Depth control by apparent size: shoulders wider than the calibrated neutral mean the player
 * stepped toward the camera (1), narrower mean they stepped back (-1).
 */
export class RingDepthTracker {
  private readonly filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4, derivativeCutoff: 1 });
  private move: -1 | 0 | 1 = 0;
  private pending?: { move: -1 | 1; sinceMs: number };

  /** The current step, or undefined without a reference width or readable shoulders. */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): -1 | 0 | 1 | undefined {
    const reference = calibration.image.shoulderWidth0;
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    if (!reference || !leftShoulder || !rightShoulder) return undefined;
    const aspect = snapshot.frameHeight / snapshot.frameWidth;
    const width = Math.hypot(leftShoulder.x - rightShoulder.x, (leftShoulder.y - rightShoulder.y) * aspect);
    if (!Number.isFinite(width) || width < MIN_SHOULDER_WIDTH) return undefined;
    const ratio = this.filter.filter(width / reference, snapshot.timestampMs);
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

  reset(): void { this.filter.reset(); this.move = 0; this.pending = undefined; }
}
