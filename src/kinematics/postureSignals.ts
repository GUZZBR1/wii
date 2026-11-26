import type { CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';

const MIN_SHOULDER_WIDTH = 0.03;
/** Into a side lane past this displacement, in shoulder widths — a deliberate but comfortable lean. */
const ENTER_LANE_SW = 0.12;
/** Back to center inside this displacement — the hysteresis gap keeps zone noise from flapping lanes. */
const EXIT_LANE_SW = 0.05;

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

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): 'left' | 'right' | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    if (!leftShoulder || !rightShoulder) return undefined;
    const width = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y);
    if (width < MIN_SHOULDER_WIDTH) return undefined;
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;
    const displacement = (calibration.image.shoulderCenterX0 - centerX) / width;
    const u = this.filter.filter(displacement, snapshot.timestampMs);
    if (this.zone === 0) {
      if (u >= ENTER_LANE_SW) return this.enter(1, 'right');
      if (u <= -ENTER_LANE_SW) return this.enter(-1, 'left');
      return undefined;
    }
    if (this.zone === 1 && u <= EXIT_LANE_SW) return this.enter(0, 'left');
    if (this.zone === -1 && u >= -EXIT_LANE_SW) return this.enter(0, 'right');
    return undefined;
  }

  private enter(zone: -1 | 0 | 1, direction: 'left' | 'right'): 'left' | 'right' {
    this.zone = zone;
    return direction;
  }

  reset(): void { this.filter.reset(); this.zone = 0; }
}
