import { median } from './math';
import type { TorsoVerticalSample } from './torsoVertical';

/**
 * Both shoulders this far above where they just were, in shoulder widths. Real recordings put
 * jumps at 0.5–0.9 and running well below; the hips are not needed, a close camera cuts them off.
 */
export const JUMP_MIN_RISE_SW = 0.45;
/** "Where they just were": the median height over this stretch before now, clear of the takeoff. */
const BASELINE_FROM_MS = 1600;
const BASELINE_TO_MS = 250;
const MIN_BASELINE_SAMPLES = 8;
/** Takeoff to settled landing; also how long the running verdict is held. */
const AIRBORNE_MS = 600;
const REFRACTORY_MS = 900;

export class JumpDetector {
  private samples: TorsoVerticalSample[] = [];
  private lastJumpAt = Number.NEGATIVE_INFINITY;
  private now = Number.NEGATIVE_INFINITY;

  get suppressesCadence(): boolean { return this.now - this.lastJumpAt < AIRBORNE_MS; }

  update(sample: TorsoVerticalSample): boolean {
    this.now = sample.timestampMs;
    const before = this.samples.filter((old) => this.now - old.timestampMs >= BASELINE_TO_MS && this.now - old.timestampMs <= BASELINE_FROM_MS);
    this.samples = [...this.samples.filter((old) => this.now - old.timestampMs <= BASELINE_FROM_MS), sample];
    if (before.length < MIN_BASELINE_SAMPLES || this.now - this.lastJumpAt < REFRACTORY_MS) return false;
    const { left, right, width } = sample.shoulders;
    // Image y grows downward, so rising is the baseline minus the current height.
    const rise = Math.min(
      median(before.map((old) => old.shoulders.left)) - left,
      median(before.map((old) => old.shoulders.right)) - right,
    ) / width;
    if (!(rise >= JUMP_MIN_RISE_SW)) return false;
    this.lastJumpAt = this.now;
    return true;
  }

  reset(): void {
    this.samples = [];
    this.lastJumpAt = this.now = Number.NEGATIVE_INFINITY;
  }
}
