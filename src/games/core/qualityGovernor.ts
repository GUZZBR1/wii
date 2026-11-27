/** 0 = full quality; higher tiers are cheaper to render. */
export type QualityTier = 0 | 1 | 2;
export const TIER_PIXEL_RATIO: Record<QualityTier, number> = { 0: 1.5, 1: 1, 2: 0.75 };

const SPIKE_MS = 250;
const SLOW_MS = 22;
const FAST_MS = 17.5;
const COOLDOWN_MS = 6000;

/** Picks a tier from smoothed frame times. The slow/fast gap plus the cooldown keep it from flapping. */
export class QualityGovernor {
  private current: QualityTier = 0;
  private average = 1000 / 60;
  private cooldown = COOLDOWN_MS;

  get tier(): QualityTier {
    return this.current;
  }

  /** Returns true when the tier changed on this frame. */
  sample(frameMs: number): boolean {
    // Tab switches and GC pauses say nothing about sustained render cost.
    if (frameMs <= 0 || frameMs > SPIKE_MS) return false;
    this.average += (frameMs - this.average) * 0.05;
    this.cooldown = Math.max(0, this.cooldown - frameMs);
    if (this.cooldown > 0) return false;
    const step = this.average > SLOW_MS ? 1 : this.average < FAST_MS ? -1 : 0;
    const next = Math.max(0, Math.min(2, this.current + step)) as QualityTier;
    if (next === this.current) return false;
    this.current = next;
    this.cooldown = COOLDOWN_MS;
    return true;
  }
}
