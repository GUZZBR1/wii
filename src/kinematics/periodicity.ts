/**
 * Noise-robust periodicity test for a 1-D motion signal, the way pedometers separate walking from
 * fidgeting: a step signal repeats at its own period (high normalized autocorrelation at that lag),
 * while sensor jitter and slow sway do not.
 *
 * Why this exists: an adaptive-hysteresis threshold crossing counter cannot tell noise from a
 * bounce — its band scales with the measured amplitude, so noise of any size crosses it at random
 * but plausible intervals. Requiring repetition at a consistent lag removes that ambiguity without
 * making the detector less sensitive to a real, small, regular bounce.
 */

const RESAMPLE_HZ = 30;
/** A silent hole this long makes the pre-gap samples useless for autocorrelation. */
const DISCONTINUITY_MS = 300;
const MIN_SPAN_MS = 600;
/** Autocorrelation must first dip below this: rejects slow drift, which stays positive at short lags. */
const DIP_LEVEL = -0.05;

export interface Periodicity {
  /** Peak normalized autocorrelation after the first dip, 0–1. 0 when there is not enough data. */
  strength: number;
  /** Lag of that peak in ms — the signal's period. */
  lagMs: number;
}

export class PeriodicityWindow {
  private samples: { t: number; v: number }[] = [];

  constructor(private readonly windowMs = 3600) {}

  push(timeMs: number, value: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(timeMs)) return;
    const last = this.samples.at(-1);
    if (last !== undefined && timeMs <= last.t) return;
    if (last !== undefined && timeMs - last.t > DISCONTINUITY_MS) this.samples = [];
    this.samples.push({ t: timeMs, v: value });
    const cutoff = timeMs - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length - 2 && this.samples[drop]!.t < cutoff) drop += 1;
    if (drop > 0) this.samples = this.samples.slice(drop);
  }

  /**
   * Strongest repetition with a period between minLagMs and maxLagMs, over the most recent
   * `tailMs` of signal. A short tail reacts fast to a movement that just started (old stillness
   * would dilute it); a long tail is needed to see slow periods.
   */
  analyze(minLagMs: number, maxLagMs: number, tailMs = this.windowMs): Periodicity {
    const none = { strength: 0, lagMs: 0 };
    const lastSample = this.samples.at(-1);
    if (!lastSample) return none;
    const cutoff = lastSample.t - tailMs;
    const startIndex = Math.max(0, this.samples.findIndex((sample) => sample.t >= cutoff));
    const view = this.samples.slice(startIndex);
    const first = view[0];
    const last = view.at(-1);
    if (!first || !last) return none;
    const spanMs = last.t - first.t;
    if (spanMs < MIN_SPAN_MS) return none;

    const dt = 1000 / RESAMPLE_HZ;
    const n = Math.floor(spanMs / dt) + 1;
    const x = new Float64Array(n);
    let cursor = 0;
    for (let i = 0; i < n; i += 1) {
      const t = first.t + i * dt;
      while (cursor < view.length - 2 && view[cursor + 1]!.t < t) cursor += 1;
      const a = view[cursor]!;
      const b = view[cursor + 1]!;
      const fraction = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      x[i] = a.v + (b.v - a.v) * fraction;
    }
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += x[i]!;
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i += 1) { x[i] = x[i]! - mean; energy += x[i]! * x[i]!; }
    if (energy / n < 1e-9) return none;

    // Overlap of at least half the window keeps each lag estimate statistically meaningful.
    const maxLag = Math.min(Math.floor(maxLagMs / dt), Math.floor(n / 2));
    let sawDip = false;
    let best = 0;
    let bestLag = 0;
    for (let lag = 2; lag <= maxLag; lag += 1) {
      let numerator = 0;
      let headEnergy = 0;
      let tailEnergy = 0;
      for (let i = 0; i < n - lag; i += 1) {
        numerator += x[i]! * x[i + lag]!;
        headEnergy += x[i]! * x[i]!;
        tailEnergy += x[i + lag]! * x[i + lag]!;
      }
      const denominator = Math.sqrt(headEnergy * tailEnergy);
      if (denominator <= 1e-12) continue;
      const value = numerator / denominator;
      if (value < DIP_LEVEL) sawDip = true;
      if (sawDip && lag * dt >= minLagMs && value > best) { best = value; bestLag = lag; }
    }
    return { strength: Math.max(0, best), lagMs: bestLag * dt };
  }

  reset(): void { this.samples = []; }
}
