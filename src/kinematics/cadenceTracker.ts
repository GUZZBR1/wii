import type { CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '../cv/oneEuroFilter';
import { SchmittTrigger } from './schmittTrigger';
import { clamp, median, midpoint } from './math';

export interface CadenceResult { cadenceSpm: number; speed01: number; step?: 'left' | 'right' }

export class CadenceTracker {
  private readonly left = new SchmittTrigger(0.1, 0.05, 220);
  private readonly right = new SchmittTrigger(0.1, 0.05, 220);
  private readonly leftFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private readonly rightFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private lastSteps: number[] = [];
  private lastStepAt = Number.NEGATIVE_INFINITY;

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): CadenceResult {
    const l = snapshot.landmarks;
    const hip = midpoint(l[23]!, l[24]!);
    const scale = calibration.image.torsoHeight;
    const leftLift = this.leftFilter.filter((hip.y - l[25]!.y) / scale - calibration.image.kneeToHipY0.left, snapshot.timestampMs);
    const rightLift = this.rightFilter.filter((hip.y - l[26]!.y) / scale - calibration.image.kneeToHipY0.right, snapshot.timestampMs);
    const leftStep = this.left.update(leftLift, snapshot.timestampMs);
    const rightStep = this.right.update(rightLift, snapshot.timestampMs);
    const step = leftStep ? 'left' : rightStep ? 'right' : undefined;
    if (step) {
      const interval = snapshot.timestampMs - this.lastStepAt;
      if (Number.isFinite(interval) && interval >= 220 && interval <= 1200) {
        this.lastSteps.push(interval);
        this.lastSteps = this.lastSteps.slice(-4);
      }
      this.lastStepAt = snapshot.timestampMs;
    }
    const cadenceSpm = this.lastSteps.length >= 2 ? 60_000 / median(this.lastSteps) : 0;
    const fresh = snapshot.timestampMs - this.lastStepAt < 450;
    const activeCadence = fresh ? cadenceSpm : 0;
    const speed01 = fresh ? clamp((activeCadence - 60) / 120) : 0;
    return { cadenceSpm: activeCadence, speed01, step };
  }

  reset(): void {
    this.left.reset(); this.right.reset(); this.leftFilter.reset(); this.rightFilter.reset(); this.lastSteps = []; this.lastStepAt = Number.NEGATIVE_INFINITY;
  }
}
