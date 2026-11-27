import type { PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { median } from './math';

const MIN_SHOULDER_WIDTH = 0.03;
/**
 * Into a side lane past this displacement, in shoulder widths. A real recording put players coming
 * "back to center" up to 0.26 away from where they started, and deliberate side steps at 0.75–1.0.
 */
export const ENTER_LANE_SW = 0.35;
/** Back to center inside this displacement — the hysteresis gap keeps zone noise from flapping lanes. */
export const EXIT_LANE_SW = 0.2;
/** The center is wherever the player stands still this long, within this spread (shoulder widths). */
const CENTER_STILL_MS = 1000;
const CENTER_STILL_SPREAD_SW = 0.1;
/** Standing still at a clearly different size means the player moved nearer or farther: measure again. */
const RECENTER_SCALE_CHANGE = 0.2;

/**
 * Lane control by body position, not gesture: the lane follows where the player's torso actually
 * is, continuously — lean the trunk or step sideways, both move the shoulder center the same way.
 * Measured from where the player stood still, in the frame's own shoulder widths, positive
 * toward the player's right: in raw camera coordinates the player's right is toward image left,
 * so rightward displacement is center − centerX. Position cannot invert the way an
 * edge-triggered lean gesture did — returning to center at worst leaves the side lane, and
 * snap-back overshoot past center is just noise below the opposite threshold.
 */
export class LanePositionTracker {
  private readonly filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4, derivativeCutoff: 1 });
  private zone: -1 | 0 | 1 = 0;
  private center?: { x: number; width: number };
  private recent: { t: number; x: number; width: number }[] = [];

  /** The lane zone the body occupies; undefined until a center exists or when shoulders are unreadable. */
  update(snapshot: PoseSnapshot): -1 | 0 | 1 | undefined {
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
    if (!Number.isFinite(centerX)) return undefined;
    this.measureCenter(snapshot.timestampMs, centerX, width);
    if (!this.center) return undefined;
    const displacement = (this.center.x - centerX) / width;
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

  reset(): void { this.filter.reset(); this.zone = 0; this.center = undefined; this.recent = []; }

  /** Sets the center once; it then stays put, so holding a side lane can never drag it along. */
  private measureCenter(t: number, x: number, width: number): void {
    const previous = this.recent.at(-1);
    if (previous && t - previous.t > 200) this.recent = [];
    this.recent.push({ t, x, width });
    while (this.recent.length > 1 && t - this.recent[1]!.t >= CENTER_STILL_MS) this.recent.shift();
    if (t - this.recent[0]!.t < CENTER_STILL_MS) return;
    const xs = this.recent.map((sample) => sample.x);
    const stillWidth = median(this.recent.map((sample) => sample.width));
    if ((Math.max(...xs) - Math.min(...xs)) / stillWidth > CENTER_STILL_SPREAD_SW) return;
    if (this.center && Math.abs(stillWidth / this.center.width - 1) <= RECENTER_SCALE_CHANGE) return;
    this.center = { x: median(xs), width: stillWidth };
    this.filter.reset();
    this.zone = 0;
  }
}
