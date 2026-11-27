/**
 * The 100 m, with no rendering: the player's speed follows how hard they run, with momentum, against
 * three runners of fixed pace. Pure, so every rule is testable.
 */
export const RACE_METRES = 100;
export const COUNTDOWN_S = 3;
/** Full effort. A real recording runs at 0.6–0.85 effort, about 5.5–7.7 m/s. */
export const TOP_SPEED = 9;
/** How fast the speed catches up: quicker to build than to lose, so a missed stride costs little. */
const GAIN_TAU_S = 0.5;
const LOSS_TAU_S = 1.4;
/** A keyboard tap adds this much effort, which fades; tapping fast keeps it high. */
const TAP_EFFORT = 0.22;
const TAP_FADE_PER_S = 0.9;

export interface Rival { name: string; pace: number; distance: number; finishS?: number }
export type Phase = 'countdown' | 'racing' | 'finished';

const RIVALS = [{ name: 'Bia', pace: 5.1 }, { name: 'Caio', pace: 5.8 }, { name: 'Davi', pace: 6.5 }];

export class Race {
  phase: Phase = 'countdown';
  countdown = COUNTDOWN_S;
  elapsedS = 0;
  distance = 0;
  speed = 0;
  finishS?: number;
  readonly rivals: Rival[] = RIVALS.map((rival) => ({ ...rival, distance: 0 }));
  private effort = 0;
  private taps = 0;

  /** The camera's latest reading, 0–1. */
  setEffort(effort01: number): void {
    this.effort = Number.isFinite(effort01) ? Math.min(1, Math.max(0, effort01)) : 0;
  }

  tap(): void {
    if (this.phase === 'racing') this.taps = Math.min(1, this.taps + TAP_EFFORT);
  }

  get effort01(): number { return Math.max(this.effort, this.taps); }

  step(dt: number): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 1e-9) this.phase = 'racing';
      return;
    }
    this.elapsedS += dt;
    this.taps = Math.max(0, this.taps - TAP_FADE_PER_S * dt);
    for (const rival of this.rivals) {
      // A short acceleration off the blocks, then a steady pace.
      rival.distance += rival.pace * Math.min(1, this.elapsedS / 1.2) * dt;
      if (rival.distance >= RACE_METRES) rival.finishS ??= this.elapsedS;
    }
    if (this.phase === 'finished') {
      this.speed *= Math.exp(-dt / GAIN_TAU_S);
      this.distance += this.speed * dt;
      return;
    }
    const target = this.effort01 * TOP_SPEED;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / (target > this.speed ? GAIN_TAU_S : LOSS_TAU_S)));
    this.distance += this.speed * dt;
    if (this.distance >= RACE_METRES) {
      this.finishS = this.elapsedS;
      this.phase = 'finished';
    }
  }

  /** 1 for first: rivals already across the line, or further along, are ahead. */
  get place(): number {
    return 1 + this.rivals.filter((rival) => (this.finishS === undefined
      ? rival.distance > this.distance
      : rival.finishS !== undefined && rival.finishS < this.finishS)).length;
  }
}
