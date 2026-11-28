/**
 * The player's own dodges: examples of leaning and ducking, judged against how that same player
 * stands relaxed. A frame is whichever it sits nearer to, smoothed, with separate thresholds to
 * enter and leave. Positions are read in the image, since a body-relative frame would cancel the
 * very lean and drop being detected, and measured in the player's relaxed shoulder widths. Pure.
 */
import type { PoseSnapshot } from '@wii/spatial-core';

export type DodgeMove = 'left' | 'right' | 'duck';
export type DodgeLabel = 'neutral' | DodgeMove;

/** Head and shoulder-line position and size of one frame. */
interface Posture { noseX: number; noseY: number; midX: number; midY: number; width: number }

/** Closer to the relaxed pose than this, in shoulder widths, is not a dodge whatever the examples say. */
export const MIN_MOVE_SW = 0.25;
const ENTER_SCORE = 0.62;
const EXIT_SCORE = 0.45;
const SMOOTHING_MS = 90;
const NEIGHBOURS = 3;
const MAX_EXAMPLES = 40;
const MIN_NEUTRAL = 8;
const MIN_EXAMPLES = 4;
/** The relaxed pose follows the player this slowly, and never further than this from what was taught. */
const DRIFT_TAU_MS = 4000;
const DRIFT_LIMIT_SW = 0.3;
const MOVES: readonly DodgeMove[] = ['left', 'right', 'duck'];

function posture(snapshot: PoseSnapshot): Posture | undefined {
  const [nose, left, right] = [snapshot.landmarks[0], snapshot.landmarks[11], snapshot.landmarks[12]];
  if (!nose || !left || !right) return undefined;
  if ([nose, left, right].some((point) => (point.visibility ?? 1) < 0.5)) return undefined;
  const width = Math.hypot(left.x - right.x, left.y - right.y);
  if (!(width > 0.03)) return undefined;
  return { noseX: nose.x, noseY: nose.y, midX: (left.x + right.x) / 2, midY: (left.y + right.y) / 2, width };
}

function relative(now: Posture, neutral: Posture): number[] {
  const w = neutral.width;
  return [(now.noseX - neutral.noseX) / w, (now.midX - neutral.midX) / w, (now.noseY - neutral.noseY) / w, (now.midY - neutral.midY) / w, now.width / w - 1];
}

const length = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!, v[3]!);

function nearest(vector: readonly number[], examples: readonly number[][]): number {
  const distances = examples.map((example) => Math.hypot(...vector.map((v, i) => v - example[i]!))).sort((a, b) => a - b);
  const count = Math.min(NEIGHBOURS, distances.length);
  return distances.slice(0, count).reduce((sum, d) => sum + d, 0) / count;
}

export class DodgeModel {
  private neutralFrames: Posture[] = [];
  private taught?: Posture;
  private neutral?: Posture;
  private readonly examples: Record<DodgeMove, number[][]> = { left: [], right: [], duck: [] };
  private readonly score: Record<DodgeMove, number> = { left: 0, right: 0, duck: 0 };
  private zoneState: -1 | 0 | 1 = 0;
  private duckState = false;
  private atMs?: number;

  reset(): void {
    this.neutralFrames = [];
    this.taught = this.neutral = undefined;
    for (const move of MOVES) this.examples[move] = [];
    this.clearState();
  }

  /** Forgets what is happening now, keeping what was learned. */
  clearState(): void {
    for (const move of MOVES) this.score[move] = 0;
    this.zoneState = 0;
    this.duckState = false;
    this.atMs = undefined;
  }

  /**
   * Records one frame as an example of `label`. Returns how far toward counting the frame is,
   * 0..1: a move is only recorded once it clearly leaves the relaxed pose (1).
   */
  teach(label: DodgeLabel, snapshot: PoseSnapshot): number {
    const now = posture(snapshot);
    if (!now) return 0;
    if (label === 'neutral') {
      this.neutralFrames.push(now);
      if (this.neutralFrames.length > MAX_EXAMPLES) this.neutralFrames.shift();
      const mean = (key: keyof Posture) => this.neutralFrames.reduce((sum, frame) => sum + frame[key], 0) / this.neutralFrames.length;
      this.taught = { noseX: mean('noseX'), noseY: mean('noseY'), midX: mean('midX'), midY: mean('midY'), width: mean('width') };
      this.neutral = { ...this.taught };
      return 1;
    }
    if (!this.neutral || this.neutralFrames.length < MIN_NEUTRAL) return 0;
    const vector = relative(now, this.neutral);
    const reach = Math.min(1, length(vector) / MIN_MOVE_SW);
    if (reach < 1) return reach;
    this.examples[label].push(vector);
    if (this.examples[label].length > MAX_EXAMPLES) this.examples[label].shift();
    return 1;
  }

  private learned(move: DodgeMove): boolean {
    return this.neutralFrames.length >= MIN_NEUTRAL && this.examples[move].length >= MIN_EXAMPLES;
  }

  /** What the model can answer; a channel never taught stays with the generic detector. */
  get knows(): { zone: boolean; duck: boolean } {
    return { zone: this.learned('left') && this.learned('right'), duck: this.learned('duck') };
  }

  /** Undefined channels were not learned or cannot be read in this frame. */
  update(snapshot: PoseSnapshot): { zone?: -1 | 0 | 1; duck?: boolean } {
    const now = posture(snapshot);
    const knows = this.knows;
    if (!now || !this.neutral || !this.taught || !(knows.zone || knows.duck)) return {};
    const dt = this.atMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, snapshot.timestampMs - this.atMs);
    this.atMs = snapshot.timestampMs;
    const blend = 1 - Math.exp(-dt / SMOOTHING_MS);
    const vector = relative(now, this.neutral);
    // The relaxed examples are the taught frames themselves, so their own jitter is the yardstick.
    const relaxed = this.neutralFrames.map((frame) => relative(frame, this.taught!));
    const away = length(vector) >= MIN_MOVE_SW * 0.8;
    const toNeutral = nearest(vector, relaxed);
    for (const move of MOVES) {
      if (!this.learned(move)) continue;
      const toMove = nearest(vector, this.examples[move]);
      const raw = away ? toNeutral / (toNeutral + toMove || 1) : 0;
      this.score[move] += (raw - this.score[move]) * blend;
    }
    this.duckState = this.score.duck >= (this.duckState ? EXIT_SCORE : ENTER_SCORE);
    const side = this.score.left >= this.score.right ? 'left' : 'right';
    const sideZone = side === 'left' ? -1 : 1;
    const threshold = this.zoneState === sideZone ? EXIT_SCORE : ENTER_SCORE;
    this.zoneState = this.score[side] >= threshold && this.score[side] >= this.score.duck ? sideZone : 0;
    if (!away && this.zoneState === 0 && !this.duckState && Number.isFinite(dt)) this.follow(now, 1 - Math.exp(-dt / DRIFT_TAU_MS));
    return { ...(knows.zone ? { zone: this.zoneState } : {}), ...(knows.duck ? { duck: this.duckState } : {}) };
  }

  private follow(now: Posture, amount: number): void {
    const { neutral, taught } = this;
    if (!neutral || !taught) return;
    const limit = DRIFT_LIMIT_SW * taught.width;
    for (const key of ['noseX', 'noseY', 'midX', 'midY', 'width'] as const) {
      const next = neutral[key] + (now[key] - neutral[key]) * amount;
      neutral[key] = Math.max(taught[key] - limit, Math.min(taught[key] + limit, next));
    }
  }
}
