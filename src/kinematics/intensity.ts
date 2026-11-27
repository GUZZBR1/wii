/**
 * How hard the player is running, 0–1, with no states and no thresholds to cross: the 100 m only
 * needs "how much", and a wrong reading costs a little speed instead of stopping the runner.
 *
 * Two readings, the stronger wins:
 * - **Arm pump**: how often the wrists swap which one is higher. A frequency, so camera angle and
 *   distance barely matter. Real recordings: standing 0 per second, slow arm swinging 1.3, running
 *   2.0–2.8, fast jogging 3.4–4.1. As in the Wii, the arms drive the race.
 * - **Head bounce** in shoulder widths, for someone who runs without pumping.
 * A player who jogs "gliding" barely bounces; reading only the bounce scored them 0.1–0.35.
 * Chosen on one player's recordings.
 */
const WINDOW_MS = 1000;
const MIN_SAMPLES = 12;
const FLOOR_SW = 0.012;
const FULL_SW = 0.09;
const FULL_RISES = 2;
const ATTACK_MS = 350;
const PUMP_WINDOW_MS = 1500;
const MIN_PUMP_SPAN_MS = 800;
/** Wrists must differ in height by this much (shoulder widths, spread): walking stays near 0.11. */
const MIN_PUMP_SW = 0.15;
const PUMP_BAND_SW = 0.08;
const REST_SWAPS_PER_S = 0.8;
const FULL_SWAPS_PER_S = 4.6;
const RELEASE_MS = 900;

type Sample = { t: number; head: number; shoulders: number };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function detrend(times: readonly number[], values: readonly number[]): number[] {
  const mean = (list: readonly number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const t0 = mean(times), v0 = mean(values);
  let top = 0, bottom = 0;
  for (const [i, t] of times.entries()) { top += (t - t0) * (values[i]! - v0); bottom += (t - t0) ** 2; }
  const slope = bottom > 0 ? top / bottom : 0;
  return values.map((value, i) => value - v0 - slope * (times[i]! - t0));
}

export class IntensityMeter {
  private samples: Sample[] = [];
  /** Left minus right wrist height, in the shoulder width's units. */
  private arms: { t: number; diff: number }[] = [];
  private level = 0;
  private at?: number;

  /** One frame; `body` is undefined when the player cannot be read, and the level then fades. */
  update(t: number, body?: { head: number; left: number; right: number; width: number; arms?: number }): number {
    let raw = 0;
    if (body) {
      const shoulders = (body.left + body.right) / 2;
      const head = Number.isFinite(body.head) ? body.head : shoulders;
      this.samples = [...this.samples.filter((sample) => t - sample.t <= WINDOW_MS), { t, head, shoulders }];
      this.arms = this.arms.filter((sample) => t - sample.t <= PUMP_WINDOW_MS);
      if (body.arms !== undefined && Number.isFinite(body.arms)) this.arms.push({ t, diff: body.arms });
      raw = Math.max(this.measure(body.width), this.pump(body.width));
    }
    const dt = this.at === undefined ? 0 : Math.max(0, t - this.at);
    this.at = t;
    this.level += (raw - this.level) * (1 - Math.exp(-dt / (raw > this.level ? ATTACK_MS : RELEASE_MS)));
    return this.level;
  }

  private measure(width: number): number {
    if (this.samples.length < MIN_SAMPLES) return 0;
    const times = this.samples.map((sample) => sample.t);
    const head = detrend(times, this.samples.map((sample) => sample.head));
    const shoulders = detrend(times, this.samples.map((sample) => sample.shoulders));
    let hs = 0, hh = 0, ss = 0, rises = 0;
    for (const [i, h] of head.entries()) {
      hs += h * shoulders[i]!; hh += h * h; ss += shoulders[i]! ** 2;
      if (i > 0 && head[i - 1]! < 0 && h >= 0) rises += 1;
    }
    const together = hh > 0 && ss > 0 ? hs / Math.sqrt(hh * ss) : 0;
    const bounce = Math.sqrt(hh / head.length) / width;
    // A run bounces repeatedly: a single hop or crouch has too few rises to count fully.
    return clamp01((bounce - FLOOR_SW) / (FULL_SW - FLOOR_SW)) * clamp01(rises / FULL_RISES) * clamp01((together - 0.3) / 0.4);
  }

  private pump(width: number): number {
    const first = this.arms[0], last = this.arms.at(-1);
    if (!first || !last || this.arms.length < MIN_SAMPLES || last.t - first.t < MIN_PUMP_SPAN_MS) return 0;
    const mean = this.arms.reduce((sum, sample) => sum + sample.diff, 0) / this.arms.length;
    const values = this.arms.map((sample) => (sample.diff - mean) / width);
    const spread = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    if (spread < MIN_PUMP_SW) return 0;
    const band = Math.max(PUMP_BAND_SW, 0.4 * spread);
    let side = 0, swaps = 0;
    for (const value of values) {
      const now = value > band ? 1 : value < -band ? -1 : 0;
      if (now === 0 || now === side) continue;
      if (side !== 0) swaps += 1;
      side = now;
    }
    return clamp01((swaps / ((last.t - first.t) / 1000) - REST_SWAPS_PER_S) / (FULL_SWAPS_PER_S - REST_SWAPS_PER_S));
  }

  reset(): void { this.samples = []; this.arms = []; this.level = 0; this.at = undefined; }
}
