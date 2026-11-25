import type { CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '../cv/oneEuroFilter';
import { midpoint } from './math';

export class JumpDetector {
  private readonly riseFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private previousRise = 0;
  private risingFrames = 0;
  private airborne = false;
  private neutralSince?: number;
  private lastJumpAt = Number.NEGATIVE_INFINITY;

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): boolean {
    const hips = midpoint(snapshot.landmarks[23]!, snapshot.landmarks[24]!);
    const rise = this.riseFilter.filter((calibration.image.hipY0 - hips.y) / calibration.image.torsoHeight, snapshot.timestampMs);
    const velocityUp = rise - this.previousRise;
    this.risingFrames = rise >= 0.08 && velocityUp > 0 ? this.risingFrames + 1 : 0;
    let fired = false;
    if (!this.airborne && this.risingFrames >= 2 && snapshot.timestampMs - this.lastJumpAt >= 400) {
      this.airborne = true;
      this.lastJumpAt = snapshot.timestampMs;
      this.neutralSince = undefined;
      fired = true;
    }
    if (this.airborne) {
      if (rise <= 0.03 && velocityUp <= 0) {
        this.neutralSince ??= snapshot.timestampMs;
        if (snapshot.timestampMs - this.neutralSince >= 160) {
          this.airborne = false;
          this.risingFrames = 0;
        }
      } else this.neutralSince = undefined;
    }
    this.previousRise = rise;
    return fired;
  }

  reset(): void { this.riseFilter.reset(); this.previousRise = 0; this.risingFrames = 0; this.airborne = false; this.neutralSince = undefined; this.lastJumpAt = Number.NEGATIVE_INFINITY; }
}
