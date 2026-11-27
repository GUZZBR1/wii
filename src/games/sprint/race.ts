/**
 * The 100 m, with no rendering. Before the start the player is framed and then runs flat out for a few
 * seconds, which sets what "full effort" means for that body, camera and angle. In the race the speed
 * follows that share of effort, with momentum, against three runners. Pure, so every rule is testable.
 */
export const RACE_METRES = 100;
export const COUNTDOWN_S = 3;
export const WARMUP_S = 5;
/** The picture has to stay good this long before the warm-up starts. */
export const FRAMED_S = 1;
/** Nobody gets stuck: with a body in view, an imperfect picture is accepted after this long. */
export const FRAMING_PATIENCE_S = 15;
export const NO_BODY_ADVICE = 'Apareça na câmera';
/** A warm-up the camera barely registered is repeated, with advice, this many times. */
export const WARMUP_RETRIES = 2;
/** Camera readings under this are rest, not slow running. */
const REST_EFFORT = 0.05;
/** A warm-up this weak was not understood: repeat it, then fall back to the default reference. */
const MIN_TRIED_EFFORT = 0.15;
/** However gentle the warm-up, full speed never costs less than this reading. */
const MIN_REFERENCE = 0.3;
const DEFAULT_REFERENCE = 0.7;
/** Speed at the player's own full effort: 100 m in about 13 s. */
export const TOP_SPEED = 8;
/** How fast the speed catches up: quicker to build than to lose, so a missed stride costs little. */
const GAIN_TAU_S = 0.5;
const LOSS_TAU_S = 1.4;
export interface Rival { name: string; pace: number; distance: number; finishS?: number }
export type Phase = 'framing' | 'warmup' | 'countdown' | 'racing' | 'finished';

const RIVALS = [{ name: 'Bia', pace: 5.1 }, { name: 'Caio', pace: 5.8 }, { name: 'Davi', pace: 6.5 }];

export class Race {
  phase: Phase = 'framing';
  countdown = COUNTDOWN_S;
  warmupLeft = WARMUP_S;
  /** What the camera asks the player to change; null until it has said anything. */
  advice: string | undefined | null = null;
  private framedFor = 0;
  private seenFor = 0;
  /** The camera reading that counts as this player's full effort. */
  reference = DEFAULT_REFERENCE;
  private readonly warmup: number[] = [];
  /** Warm-ups repeated because the camera did not register any running. */
  retries = 0;
  private handsHidden = false;
  elapsedS = 0;
  distance = 0;
  speed = 0;
  finishS?: number;
  readonly rivals: Rival[] = RIVALS.map((rival) => ({ ...rival, distance: 0 }));
  private effort = 0;

  /** The camera's latest reading, 0–1. */
  setEffort(effort01: number): void {
    this.effort = Number.isFinite(effort01) ? Math.min(1, Math.max(0, effort01)) : 0;
  }

  /** Undefined advice means the picture is good. */
  setFraming(advice: string | undefined, handsHidden = false): void {
    this.advice = advice;
    this.handsHidden = handsHidden;
  }

  /** What the energy bar shows: the raw reading while warming up, the player's own share afterwards. */
  get energy01(): number {
    return this.phase === 'framing' || this.phase === 'warmup' ? Math.min(1, this.effort / DEFAULT_REFERENCE) : this.effort01;
  }

  /** What to do when the bar will not fill; undefined while it is filling. */
  get coaching(): string | undefined {
    if (this.phase !== 'warmup' || (this.retries === 0 && this.warmupLeft > WARMUP_S - 2) || this.effort >= MIN_TRIED_EFFORT) return undefined;
    return this.handsHidden ? 'Mostre as mãos na câmera' : 'Mexa mais os braços, como quem corre';
  }

  get effort01(): number {
    return this.effort < REST_EFFORT ? 0 : Math.min(1, this.effort / this.reference);
  }

  step(dt: number): void {
    if (this.phase === 'framing') {
      this.framedFor = this.advice === undefined ? this.framedFor + dt : 0;
      if (this.advice !== null && this.advice !== NO_BODY_ADVICE) this.seenFor += dt;
      if (this.framedFor >= FRAMED_S || this.seenFor >= FRAMING_PATIENCE_S) this.phase = 'warmup';
      return;
    }
    if (this.phase === 'warmup') {
      this.warmupLeft -= dt;
      // The first seconds are getting up to pace.
      if (this.warmupLeft < WARMUP_S - 2) this.warmup.push(this.effort);
      if (this.warmupLeft <= 1e-9) {
        // Near the top of what was read, ignoring one-off spikes.
        const peak = [...this.warmup].sort((a, b) => a - b)[Math.floor(this.warmup.length * 0.8)] ?? 0;
        if (peak < MIN_TRIED_EFFORT && this.retries < WARMUP_RETRIES) {
          this.retries += 1;
          this.warmupLeft = WARMUP_S;
          this.warmup.length = 0;
          return;
        }
        this.reference = peak < MIN_TRIED_EFFORT ? DEFAULT_REFERENCE : Math.max(MIN_REFERENCE, peak);
        this.phase = 'countdown';
      }
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 1e-9) this.phase = 'racing';
      return;
    }
    this.elapsedS += dt;
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

  /** Everyone, fastest first; a rival still running is given the time its pace will take. */
  get standings(): { name: string; timeS: number; you: boolean }[] {
    const rivals = this.rivals.map((rival) => ({
      name: rival.name,
      timeS: rival.finishS ?? this.elapsedS + (RACE_METRES - rival.distance) / rival.pace,
      you: false,
    }));
    const you = this.finishS === undefined ? [] : [{ name: 'Você', timeS: this.finishS, you: true }];
    return [...rivals, ...you].sort((a, b) => a.timeS - b.timeS);
  }

  /** 1 for first: rivals already across the line, or further along, are ahead. */
  get place(): number {
    return 1 + this.rivals.filter((rival) => (this.finishS === undefined
      ? rival.distance > this.distance
      : rival.finishS !== undefined && rival.finishS < this.finishS)).length;
  }
}
