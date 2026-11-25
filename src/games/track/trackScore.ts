import { JUMP_DURATION_S } from './jump';

/** A jump is "perfect" when the hurdle crosses the runner this close (seconds) to its apex. */
export const PERFECT_WINDOW_S = 0.08;
export const MAX_MULTIPLIER = 4;
const CLEAR_POINTS = 100;
const PERFECT_POINTS = 50;
const HIT_PENALTY = 35;
const COIN_POINTS = 25;

/** `jumpRemaining` is the air time left when the hurdle crossed; 0 means the runner was grounded. */
export function isPerfectJump(jumpRemaining: number): boolean {
  return jumpRemaining > 0 && Math.abs(jumpRemaining - JUMP_DURATION_S / 2) <= PERFECT_WINDOW_S;
}

export interface Award { points: number; multiplier: number; perfect: boolean }

export class TrackScore {
  private value = 0;
  private streak = 0;

  get combo(): number {
    return this.streak;
  }

  advance(dt: number, speed01: number): void {
    if (!Number.isFinite(speed01)) return;
    this.value += dt * speed01 * 50;
  }

  /** Each clear in a row raises the multiplier by one, up to MAX_MULTIPLIER. */
  hurdleCleared(perfect = false): Award {
    this.streak += 1;
    const multiplier = Math.min(MAX_MULTIPLIER, this.streak);
    const points = (CLEAR_POINTS + (perfect ? PERFECT_POINTS : 0)) * multiplier;
    this.value += points;
    return { points, multiplier, perfect };
  }

  /** Coins are a flat bonus: they neither build nor break the combo. */
  coinCollected(): number {
    this.value += COIN_POINTS;
    return COIN_POINTS;
  }

  hurdleHit(): void {
    this.streak = 0;
    this.value = Math.max(0, this.value - HIT_PENALTY);
  }

  get display(): number {
    return Math.floor(this.value);
  }
}
