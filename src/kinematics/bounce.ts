/**
 * Is the player running? Judged only by how much both shoulders bounce over one second, in shoulder
 * widths. Real recordings: standing 0.001–0.011, swinging only the arms 0.003–0.020, running in
 * place 0.045–0.078, jumping 0.10–0.29. Real running is irregular, so no rhythm is required.
 */
const WINDOW_MS = 1000;
const MIN_SPAN_MS = 600;
const MIN_SPREAD_SW = 0.03;
/** A bounce this big is a jump, not a stride, and the landing is ignored for a while. */
const JUMP_SPREAD_SW = 0.12;
const JUMP_LOCKOUT_MS = 1200;
/** Both shoulders must move together, which independent landmark jitter and one-arm waving do not. */
const MIN_TOGETHER = 0.65;
const HOLD_MS = 300;
/** The long window remembers the last strides; a flat recent stretch means the player already stopped. */
const QUIET_WINDOW_MS = 450;
const QUIET_SPREAD_SW = 0.012;
const MIN_STEP_INTERVAL_MS = 220;

type Sample = { t: number; left: number; right: number };

/** Removes the straight-line trend, so walking nearer or settling does not count as bouncing. */
function detrend(times: readonly number[], values: readonly number[]): number[] {
  const mean = (list: readonly number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const t0 = mean(times), v0 = mean(values);
  let top = 0, bottom = 0;
  for (const [i, t] of times.entries()) { top += (t - t0) * (values[i]! - v0); bottom += (t - t0) ** 2; }
  const slope = bottom > 0 ? top / bottom : 0;
  return values.map((value, i) => value - v0 - slope * (times[i]! - t0));
}

/** Peak-to-peak travel of the shoulder midpoint. */
function moved(samples: readonly Sample[]): number {
  const mids = samples.map((sample) => (sample.left + sample.right) / 2);
  return mids.length > 1 ? Math.max(...mids) - Math.min(...mids) : 0;
}

/** `rise` marks one stride's upward crossing, timed even before the run is confirmed. */
export interface Bounce { moving: boolean; rise: boolean }

export class BounceDetector {
  private samples: Sample[] = [];
  private until = Number.NEGATIVE_INFINITY;
  private blockedUntil = Number.NEGATIVE_INFINITY;
  private above = false;
  private lastRiseAt = Number.NEGATIVE_INFINITY;

  /** Heights are image y (growing downward) in the same units as the shoulder width. */
  update(t: number, left: number, right: number, width: number): Bounce {
    this.samples.push({ t, left, right });
    this.samples = this.samples.filter((sample) => t - sample.t <= WINDOW_MS);
    if (t - this.samples[0]!.t < MIN_SPAN_MS) return { moving: this.isMoving(t), rise: false };
    const times = this.samples.map((sample) => sample.t);
    const l = detrend(times, this.samples.map((sample) => sample.left));
    const r = detrend(times, this.samples.map((sample) => sample.right));
    let lr = 0, ll = 0, rr = 0, mid = 0;
    for (const [i, a] of l.entries()) { const b = r[i]!; lr += a * b; ll += a * a; rr += b * b; mid += ((a + b) / 2) ** 2; }
    const spread = Math.sqrt(mid / l.length) / width;
    const together = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 0;
    const recent = this.samples.filter((sample) => t - sample.t <= QUIET_WINDOW_MS);
    if (spread > JUMP_SPREAD_SW) this.blockedUntil = t + JUMP_LOCKOUT_MS;
    // Old strides alone prove nothing: the body must also be moving in the latest frames.
    else if (spread >= MIN_SPREAD_SW && together >= MIN_TOGETHER && moved(recent) / width >= QUIET_SPREAD_SW) this.until = t + HOLD_MS;

    const recentTimes = recent.map((sample) => sample.t);
    const recentMid = detrend(recentTimes, recent.map((sample) => (sample.left + sample.right) / 2));
    const quiet = t - recentTimes[0]! >= QUIET_WINDOW_MS * 0.7
      && Math.sqrt(recentMid.reduce((sum, value) => sum + value * value, 0) / recentMid.length) / width < QUIET_SPREAD_SW;
    if (quiet) this.until = Number.NEGATIVE_INFINITY;

    // One step per rise through the window's middle (image y falls as the body rises).
    const height = -(l.at(-1)! + r.at(-1)!) / 2 / width;
    let rise = false;
    if (!this.above && height > spread / 2) {
      this.above = true;
      if (spread >= MIN_SPREAD_SW && t - this.lastRiseAt >= MIN_STEP_INTERVAL_MS) { rise = true; this.lastRiseAt = t; }
    } else if (this.above && height < -spread / 2) this.above = false;
    return { moving: this.isMoving(t), rise };
  }

  isMoving(t: number): boolean { return t <= this.until && t > this.blockedUntil; }

  reset(): void {
    this.samples = [];
    this.until = this.blockedUntil = this.lastRiseAt = Number.NEGATIVE_INFINITY;
    this.above = false;
  }
}
