/**
 * How hard the player is running, 0–1: simply how much they move per second. Vertical speed of the
 * wrists (relative to the shoulders) plus that of the head, in shoulder widths, so distance to the
 * camera cancels out. It grows with both the pace and the size of the movement, with no thresholds,
 * counts or switching between signals, which made earlier meters saturate, jump or ignore compact arms.
 *
 * Real recordings, shoulder widths per second: standing 0.02–0.3, walking up to 0.7, running 1.2–2.8.
 * Chosen on one player; each race also learns the player's own maximum in the warm-up.
 */
const REST_SPEED = 0.35;
const FULL_SPEED = 3.5;
/** With no hand in view the body is the only evidence, and it moves far less than the arms. */
const BODY_ONLY_GAIN = 3;
/** Landmark jitter is fast and tiny: smoothing the positions removes most of its apparent speed. */
const POSITION_SMOOTHING_MS = 80;
const AVERAGE_MS = 1000;
const ATTACK_MS = 300;
const RELEASE_MS = 700;
/** A longer hole than this means the two positions are not one movement. */
const MAX_FRAME_GAP_MS = 250;

/** Heights in the shoulder width's units; a wrist out of view is NaN. */
export interface Body { head: number; shoulders: number; width: number; leftWrist: number; rightWrist: number }

export class IntensityMeter {
  private previous?: { t: number; positions: number[] };
  private speeds: { t: number; value: number }[] = [];
  private level = 0;
  private at?: number;

  /** One frame; `body` is undefined when the player cannot be read, and the level then fades. */
  update(t: number, body?: Body): number {
    if (body) this.measure(t, body);
    else this.previous = undefined;
    this.speeds = this.speeds.filter((speed) => t - speed.t <= AVERAGE_MS);
    const mean = body && this.speeds.length ? this.speeds.reduce((sum, speed) => sum + speed.value, 0) / this.speeds.length : 0;
    const raw = Math.min(1, Math.max(0, (mean - REST_SPEED) / (FULL_SPEED - REST_SPEED)));
    const dt = this.at === undefined ? 0 : Math.max(0, t - this.at);
    this.at = t;
    this.level += (raw - this.level) * (1 - Math.exp(-dt / (raw > this.level ? ATTACK_MS : RELEASE_MS)));
    return this.level;
  }

  private measure(t: number, { head, shoulders, width, leftWrist, rightWrist }: Body): void {
    const positions = [head, leftWrist - shoulders, rightWrist - shoulders];
    const previous = this.previous;
    const dt = previous ? t - previous.t : 0;
    if (!previous || dt <= 0 || dt > MAX_FRAME_GAP_MS) {
      this.previous = { t, positions };
      return;
    }
    const alpha = 1 - Math.exp(-dt / POSITION_SMOOTHING_MS);
    const smoothed = positions.map((now, i) => {
      const before = previous.positions[i]!;
      return Number.isFinite(before) ? before + (now - before) * alpha : now;
    });
    const speeds = smoothed.map((now, i) => Math.abs(now - previous.positions[i]!) / width / (dt / 1000));
    const [body, ...hands] = speeds;
    const seen = hands.filter(Number.isFinite);
    const bodySpeed = Number.isFinite(body!) ? body! : 0;
    const value = seen.length ? seen.reduce((sum, speed) => sum + speed, 0) / seen.length + bodySpeed : bodySpeed * BODY_ONLY_GAIN;
    this.speeds.push({ t, value });
    this.previous = { t, positions: smoothed };
  }

  reset(): void { this.previous = this.at = undefined; this.speeds = []; this.level = 0; }
}
