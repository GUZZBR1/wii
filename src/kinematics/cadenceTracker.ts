import { BounceDetector } from './bounce';
import { median } from './math';
import type { TorsoVerticalSample } from './torsoVertical';

export interface CadenceResult { cadenceSpm: number; speed01: number; step?: 'left' | 'right' }

/** Assumed pace until two steps have been timed: a relaxed run in place. */
const DEFAULT_SPM = 150;
const MAX_STEP_INTERVAL_MS = 900;
/**
 * Steps/min to game speed, interpolated. Anchors follow the CADENCE-Adults studies (100 steps/min is a
 * moderate walk; walking turns into running around 135-140). Those were measured moving forward, not in place.
 */
const SPEED_BY_CADENCE = [[40, 0.1], [100, 0.3], [137.5, 0.55], [200, 1]] as const;

export function speedFromCadence(spm: number): number {
  if (spm <= 0) return 0;
  let [fromSpm, fromSpeed]: readonly [number, number] = SPEED_BY_CADENCE[0];
  for (const [toSpm, toSpeed] of SPEED_BY_CADENCE) {
    if (spm <= toSpm) return toSpm === fromSpm ? toSpeed : fromSpeed + (toSpeed - fromSpeed) * Math.min(1, Math.max(0, (spm - fromSpm) / (toSpm - fromSpm)));
    [fromSpm, fromSpeed] = [toSpm, toSpeed];
  }
  return fromSpeed;
}

/**
 * Whether the player runs comes from the size of the bounce; how fast comes from the time between
 * rises. Step side cannot be told apart from torso motion, so left/right just alternate.
 */
export class CadenceTracker {
  private readonly bounce = new BounceDetector();
  private intervals: number[] = [];
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private lastStepSide: 'left' | 'right' = 'right';
  private moving = false;

  /** `suspend` (a jump in flight) holds the current verdict and ignores the airborne samples. */
  update(sample: TorsoVerticalSample | undefined, nowMs: number, suspend = false): CadenceResult {
    let step: 'left' | 'right' | undefined;
    if (sample && !suspend) {
      const bounce = this.bounce.update(sample.timestampMs, sample.shoulders.left, sample.shoulders.right, sample.shoulders.width);
      this.moving = bounce.moving;
      if (bounce.rise) {
        const interval = sample.timestampMs - this.lastStepAt;
        // After a pause the old pace says nothing about the new one.
        this.intervals = interval <= MAX_STEP_INTERVAL_MS ? [...this.intervals, interval].slice(-3) : [];
        this.lastStepAt = sample.timestampMs;
        if (this.moving) {
          this.lastStepSide = this.lastStepSide === 'left' ? 'right' : 'left';
          step = this.lastStepSide;
        }
      }
    } else if (!suspend) this.moving = this.bounce.isMoving(nowMs);
    if (!this.moving) return { cadenceSpm: 0, speed01: 0, step };
    const cadenceSpm = this.intervals.length ? 60_000 / median(this.intervals) : DEFAULT_SPM;
    return { cadenceSpm, speed01: speedFromCadence(cadenceSpm), step };
  }

  reset(): void {
    this.bounce.reset();
    this.intervals = [];
    this.lastStepAt = Number.NEGATIVE_INFINITY;
    this.lastStepSide = 'right';
    this.moving = false;
  }
}
