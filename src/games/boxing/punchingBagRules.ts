/**
 * Pure rhythm-training rules: no DOM, rendering, clocks, timers or randomness. Time only moves when
 * the caller passes an explicit timestamp or fixed-step delta. Kept next to `trainingRules.ts`, the
 * barrel the game imports, so the split does not change any caller.
 */
export type LaneZone = -1 | 0 | 1;

export const TIME_EPSILON_SECONDS = 1e-9;

export const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Shared guards: both challenges reject a non-finite clock and an impossible lane. */
export function assertExplicitTime(timeSeconds: number, name = 'timeSeconds'): void {
  if (!Number.isFinite(timeSeconds)) throw new RangeError(`${name} must be finite`);
}

export function assertLaneZone(laneZone: LaneZone): void {
  if (laneZone !== -1 && laneZone !== 0 && laneZone !== 1) throw new RangeError('laneZone must be -1, 0 or 1');
}

export interface PunchingBagConfig {
  /** Time of the first rhythm target. */
  readonly firstBeatSeconds: number;
  /** Spacing between rhythm targets. */
  readonly beatIntervalSeconds: number;
  /** Half-width of the inclusive timing window around each target. */
  readonly hitWindowSeconds: number;
  /** Punches weaker than this count as errors and claim the beat without scoring. */
  readonly minStrength01: number;
  /** Victory requires at least this score. */
  readonly targetScore: number;
  /** Victory also requires this best combo. */
  readonly targetCombo: number;
  /** Victory also requires this mean precision across scoring hits. */
  readonly targetAveragePrecision01: number;
}

export const DEFAULT_PUNCHING_BAG_CONFIG: PunchingBagConfig = {
  firstBeatSeconds: 1,
  beatIntervalSeconds: 0.8,
  hitWindowSeconds: 0.15,
  minStrength01: 0.25,
  targetScore: 1800,
  targetCombo: 6,
  targetAveragePrecision01: 0.65,
};

export interface PunchInput {
  /** Absolute timestamp of the punch on the trainer's caller-owned timeline. */
  readonly timeSeconds: number;
  /** Normalized punch strength. Values outside 0..1 are clamped; omitted means full strength. */
  readonly strength01?: number;
}

export type PunchingBagErrorReason = 'timing' | 'weak' | 'duplicate';

export type PunchingBagEvent =
  | {
      readonly kind: 'hit';
      readonly timeSeconds: number;
      readonly beatIndex: number;
      readonly beatTimeSeconds: number;
      /** Signed error: positive means late, negative means early. */
      readonly timingErrorSeconds: number;
      readonly strength01: number;
      readonly precision01: number;
      readonly points: number;
      readonly combo: number;
      readonly score: number;
    }
  | {
      readonly kind: 'punch-error';
      readonly reason: PunchingBagErrorReason;
      readonly timeSeconds: number;
      readonly beatIndex: number;
      readonly beatTimeSeconds: number;
      readonly timingErrorSeconds: number;
      readonly strength01: number;
      readonly combo: number;
      readonly score: number;
    }
  | {
      readonly kind: 'beat-missed';
      /** Exact time at which the beat's inclusive hit window expired. */
      readonly timeSeconds: number;
      readonly beatIndex: number;
      readonly beatTimeSeconds: number;
      readonly combo: number;
      readonly score: number;
    }
  | {
      readonly kind: 'won';
      readonly timeSeconds: number;
      readonly score: number;
      readonly bestCombo: number;
      readonly averagePrecision01: number;
    };

export interface PunchingBagSnapshot {
  readonly timeSeconds: number;
  readonly status: 'active' | 'won';
  readonly wonAtSeconds: number | undefined;
  readonly score: number;
  readonly combo: number;
  readonly bestCombo: number;
  readonly hits: number;
  readonly misses: number;
  readonly errors: number;
  /** Mean precision of scoring hits; zero before the first hit. */
  readonly averagePrecision01: number;
  readonly nextBeatIndex: number;
  readonly nextBeatTimeSeconds: number;
}

const PUNCH_BASE_POINTS = 100;
const PUNCH_PRECISION_BONUS_POINTS = 100;
const PUNCH_COMBO_BONUS_STEP = 0.1;
const PUNCH_MAX_COMBO_MULTIPLIER = 1.5;

function resolvePunchingBagConfig(overrides: Partial<PunchingBagConfig>): PunchingBagConfig {
  const config = { ...DEFAULT_PUNCHING_BAG_CONFIG, ...overrides };
  if (!Number.isFinite(config.firstBeatSeconds) || config.firstBeatSeconds < 0) {
    throw new RangeError('firstBeatSeconds must be a finite non-negative number');
  }
  if (!Number.isFinite(config.beatIntervalSeconds) || config.beatIntervalSeconds <= 0) {
    throw new RangeError('beatIntervalSeconds must be a finite positive number');
  }
  if (!Number.isFinite(config.hitWindowSeconds) || config.hitWindowSeconds <= 0) {
    throw new RangeError('hitWindowSeconds must be a finite positive number');
  }
  if (config.hitWindowSeconds >= config.beatIntervalSeconds / 2) {
    throw new RangeError('hitWindowSeconds must be smaller than half beatIntervalSeconds');
  }
  if (!Number.isFinite(config.minStrength01) || config.minStrength01 < 0 || config.minStrength01 > 1) {
    throw new RangeError('minStrength01 must be between 0 and 1');
  }
  if (!Number.isFinite(config.targetScore) || config.targetScore <= 0) {
    throw new RangeError('targetScore must be a finite positive number');
  }
  if (!Number.isInteger(config.targetCombo) || config.targetCombo <= 0) {
    throw new RangeError('targetCombo must be a positive integer');
  }
  if (
    !Number.isFinite(config.targetAveragePrecision01) ||
    config.targetAveragePrecision01 < 0 ||
    config.targetAveragePrecision01 > 1
  ) {
    throw new RangeError('targetAveragePrecision01 must be between 0 and 1');
  }
  return config;
}

/**
 * Rhythm trainer for a punching bag. Beats are indexed from zero and occur at
 * `firstBeatSeconds + beatIndex * beatIntervalSeconds`. A punch first advances the
 * trainer to its explicit timestamp, so expired beats are reported before that punch.
 *
 * Weak but on-beat punches claim their beat: they are errors, but the beat is not
 * also reported as missed. Timing and duplicate errors claim nothing. Hit precision
 * is 70% timing quality and 30% strength; base hit points are 100 plus up to 100
 * precision points, with a 10% combo bonus per hit capped at a 1.5x multiplier.
 * Victory is terminal and requires the configured score, best combo, and mean hit precision.
 */
export class PunchingBagTrainer {
  private readonly config: PunchingBagConfig;
  private timeSeconds = 0;
  private status: 'active' | 'won' = 'active';
  private wonAtSeconds: number | undefined;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private errors = 0;
  private precisionTotal01 = 0;
  private nextBeatIndex = 0;
  private lastClaimedBeatIndex = -1;

  constructor(config: Partial<PunchingBagConfig> = {}) {
    this.config = resolvePunchingBagConfig(config);
  }

  get snapshot(): PunchingBagSnapshot {
    return {
      timeSeconds: this.timeSeconds,
      status: this.status,
      wonAtSeconds: this.wonAtSeconds,
      score: this.score,
      combo: this.combo,
      bestCombo: this.bestCombo,
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      averagePrecision01: this.hits === 0 ? 0 : this.precisionTotal01 / this.hits,
      nextBeatIndex: this.nextBeatIndex,
      nextBeatTimeSeconds: this.beatTime(this.nextBeatIndex),
    };
  }

  /** Advances the trainer's explicit timeline, resolving every expired unclaimed beat. */
  advanceTo(timeSeconds: number): readonly PunchingBagEvent[] {
    assertExplicitTime(timeSeconds);
    if (timeSeconds < this.timeSeconds) throw new RangeError('timeSeconds cannot move backwards');
    if (this.status !== 'active') return [];

    const events: PunchingBagEvent[] = [];
    while (this.beatExpiryTime(this.nextBeatIndex) < timeSeconds - TIME_EPSILON_SECONDS) {
      const beatIndex = this.nextBeatIndex;
      const beatTimeSeconds = this.beatTime(beatIndex);
      const expiredAtSeconds = this.beatExpiryTime(beatIndex);
      if (this.lastClaimedBeatIndex < beatIndex) {
        this.misses += 1;
        this.combo = 0;
        events.push({
          kind: 'beat-missed',
          timeSeconds: expiredAtSeconds,
          beatIndex,
          beatTimeSeconds,
          combo: this.combo,
          score: this.score,
        });
      }
      this.nextBeatIndex += 1;
    }
    this.timeSeconds = timeSeconds;
    return events;
  }

  /** Applies one punch at its explicit timestamp and returns beat misses plus the punch result. */
  punch(input: PunchInput): readonly PunchingBagEvent[] {
    assertExplicitTime(input.timeSeconds, 'punch.timeSeconds');
    if (input.timeSeconds < this.timeSeconds) throw new RangeError('punch.timeSeconds cannot move backwards');
    if (this.status !== 'active') return [];

    const events: PunchingBagEvent[] = [...this.advanceTo(input.timeSeconds)];
    const strength01 = clamp01(input.strength01 ?? 1);
    const beatIndex = this.nearestBeatIndex(input.timeSeconds);
    const beatTimeSeconds = this.beatTime(beatIndex);
    const timingErrorSeconds = input.timeSeconds - beatTimeSeconds;
    const insideWindow = Math.abs(timingErrorSeconds) <= this.config.hitWindowSeconds + TIME_EPSILON_SECONDS;

    if (!insideWindow) {
      this.errors += 1;
      this.combo = 0;
      events.push({
        kind: 'punch-error',
        reason: 'timing',
        timeSeconds: input.timeSeconds,
        beatIndex,
        beatTimeSeconds,
        timingErrorSeconds,
        strength01,
        combo: this.combo,
        score: this.score,
      });
      return events;
    }

    if (beatIndex <= this.lastClaimedBeatIndex) {
      this.errors += 1;
      this.combo = 0;
      events.push({
        kind: 'punch-error',
        reason: 'duplicate',
        timeSeconds: input.timeSeconds,
        beatIndex,
        beatTimeSeconds,
        timingErrorSeconds,
        strength01,
        combo: this.combo,
        score: this.score,
      });
      return events;
    }

    this.lastClaimedBeatIndex = beatIndex;
    if (strength01 < this.config.minStrength01) {
      this.errors += 1;
      this.combo = 0;
      events.push({
        kind: 'punch-error',
        reason: 'weak',
        timeSeconds: input.timeSeconds,
        beatIndex,
        beatTimeSeconds,
        timingErrorSeconds,
        strength01,
        combo: this.combo,
        score: this.score,
      });
      return events;
    }

    const timingQuality01 = 1 - Math.min(1, Math.abs(timingErrorSeconds) / this.config.hitWindowSeconds);
    const precision01 = clamp01(0.7 * timingQuality01 + 0.3 * strength01);
    const comboAfterHit = this.combo + 1;
    const comboMultiplier = Math.min(1 + (comboAfterHit - 1) * PUNCH_COMBO_BONUS_STEP, PUNCH_MAX_COMBO_MULTIPLIER);
    const points = Math.round((PUNCH_BASE_POINTS + PUNCH_PRECISION_BONUS_POINTS * precision01) * comboMultiplier);

    this.hits += 1;
    this.combo = comboAfterHit;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.score += points;
    this.precisionTotal01 += precision01;
    events.push({
      kind: 'hit',
      timeSeconds: input.timeSeconds,
      beatIndex,
      beatTimeSeconds,
      timingErrorSeconds,
      strength01,
      precision01,
      points,
      combo: this.combo,
      score: this.score,
    });

    const averagePrecision01 = this.precisionTotal01 / this.hits;
    if (
      this.score >= this.config.targetScore &&
      this.bestCombo >= this.config.targetCombo &&
      averagePrecision01 >= this.config.targetAveragePrecision01
    ) {
      this.status = 'won';
      this.wonAtSeconds = input.timeSeconds;
      events.push({
        kind: 'won',
        timeSeconds: input.timeSeconds,
        score: this.score,
        bestCombo: this.bestCombo,
        averagePrecision01,
      });
    }
    return events;
  }

  private nearestBeatIndex(timeSeconds: number): number {
    return Math.max(0, Math.round((timeSeconds - this.config.firstBeatSeconds) / this.config.beatIntervalSeconds));
  }

  private beatTime(beatIndex: number): number {
    return this.config.firstBeatSeconds + beatIndex * this.config.beatIntervalSeconds;
  }

  private beatExpiryTime(beatIndex: number): number {
    return this.beatTime(beatIndex) + this.config.hitWindowSeconds;
  }
}
