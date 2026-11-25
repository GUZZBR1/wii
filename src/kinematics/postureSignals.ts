import type { CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '../cv/oneEuroFilter';
import { midpoint } from './math';

export function torsoLeanDeltaRad(snapshot: PoseSnapshot, calibration: CalibrationProfile): number {
  const shoulders = midpoint(snapshot.landmarks[11]!, snapshot.landmarks[12]!);
  const hips = midpoint(snapshot.landmarks[23]!, snapshot.landmarks[24]!);
  return Math.atan2(shoulders.x - hips.x, hips.y - shoulders.y) - calibration.image.torsoLeanRad0;
}

export class LaneLeanDetector {
  private readonly angleFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private active?: 'left' | 'right';
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): 'left' | 'right' | undefined {
    const delta = this.angleFilter.filter(torsoLeanDeltaRad(snapshot, calibration), snapshot.timestampMs);
    if (Math.abs(delta) < 0.12) { this.active = undefined; return undefined; }
    if (snapshot.timestampMs - this.lastChangeAt < 350) return undefined;
    const direction = delta < 0 ? 'left' : 'right';
    if (direction === this.active) return undefined;
    this.active = direction;
    this.lastChangeAt = snapshot.timestampMs;
    return direction;
  }

  reset(): void { this.angleFilter.reset(); this.active = undefined; this.lastChangeAt = Number.NEGATIVE_INFINITY; }
}
