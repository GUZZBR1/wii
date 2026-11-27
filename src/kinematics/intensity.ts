/**
 * How hard the player is running, 0–1, with no states and no thresholds to cross: the 100 m only
 * needs "how much", and a wrong reading costs a little speed instead of stopping the runner.
 *
 * Measured from how much the head bounces, in shoulder widths: arm swinging moves the shoulders far
 * more than the head, and jitter does not move head and shoulders together. Chosen on one player's
 * recordings (standing ≈ 0, easy jog ≈ 0.4, running 0.6–0.8).
 */
const WINDOW_MS = 1000;
const MIN_SAMPLES = 12;
const FLOOR_SW = 0.012;
const FULL_SW = 0.09;
const FULL_RISES = 2;
const ATTACK_MS = 350;
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
  private level = 0;
  private at?: number;

  /** One frame; `body` is undefined when the player cannot be read, and the level then fades. */
  update(t: number, body?: { head: number; left: number; right: number; width: number }): number {
    let raw = 0;
    if (body) {
      const shoulders = (body.left + body.right) / 2;
      const head = Number.isFinite(body.head) ? body.head : shoulders;
      this.samples = [...this.samples.filter((sample) => t - sample.t <= WINDOW_MS), { t, head, shoulders }];
      raw = this.measure(body.width);
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

  reset(): void { this.samples = []; this.level = 0; this.at = undefined; }
}
