/**
 * Pure dodge-challenge rules. See `punchingBagRules.ts` for the same time contract.
 */
import { assertLaneZone, type LaneZone, TIME_EPSILON_SECONDS } from './punchingBagRules';

export type { LaneZone } from './punchingBagRules';

export interface DodgeAttackSpec {
  /** Lane threatened by the incoming blow. This is telegraph information for the player. */
  readonly attackLane: LaneZone;
  /** Lane the player must continuously occupy at the end of the active phase to avoid the blow. */
  readonly safeLane: LaneZone;
}

export interface DodgeChallengeConfig {
  readonly telegraphSeconds: number;
  readonly activeSeconds: number;
  /** Recovery/result time after an attack before the next telegraph or the final result. */
  readonly resolvedSeconds: number;
  readonly correctDodgePoints: number;
  readonly earlyDodgePoints: number;
  /** Victory requires at least this score when the sequence completes. */
  readonly targetScore: number;
  /** Victory requires this many avoided attacks (correct or early) when the sequence completes. */
  readonly requiredDodges: number;
  /** Taking more than this many hits loses immediately. Late reactions count as hits. */
  readonly maxHits: number;
}

export const DEFAULT_DODGE_CHALLENGE_CONFIG: DodgeChallengeConfig = {
  telegraphSeconds: 0.75,
  activeSeconds: 0.35,
  resolvedSeconds: 0.5,
  correctDodgePoints: 100,
  earlyDodgePoints: 40,
  targetScore: 350,
  requiredDodges: 4,
  maxHits: 2,
};

export const DEFAULT_DODGE_SEQUENCE: readonly DodgeAttackSpec[] = [
  { attackLane: 0, safeLane: -1 },
  { attackLane: 0, safeLane: 1 },
  { attackLane: -1, safeLane: 1 },
  { attackLane: 1, safeLane: -1 },
  { attackLane: 0, safeLane: 1 },
  { attackLane: 0, safeLane: -1 },
];

export type DodgePhase = 'telegraph' | 'active' | 'resolved' | 'complete';
export type DodgeOutcome = 'correct' | 'early' | 'late' | 'hit';
export type DodgeChallengeStatus = 'active' | 'won' | 'lost';

export type DodgeChallengeEvent =
  | {
      readonly kind: 'attack-telegraph';
      readonly timeSeconds: number;
      readonly attackIndex: number;
      readonly attackLane: LaneZone;
      readonly safeLane: LaneZone;
    }
  | {
      readonly kind: 'attack-active';
      readonly timeSeconds: number;
      readonly attackIndex: number;
    }
  | {
      readonly kind: 'attack-resolved';
      readonly timeSeconds: number;
      readonly attackIndex: number;
      readonly outcome: DodgeOutcome;
      /** Seconds after telegraph when current safe occupancy began; negative if early, undefined on hit. */
      readonly reactionSeconds: number | undefined;
      readonly points: number;
      readonly score: number;
      readonly dodges: number;
      readonly hits: number;
    }
  | {
      readonly kind: 'won';
      readonly timeSeconds: number;
      readonly score: number;
      readonly dodges: number;
      readonly correctDodges: number;
      readonly hits: number;
    }
  | {
      readonly kind: 'lost';
      readonly reason: 'hit-limit' | 'requirements';
      readonly timeSeconds: number;
      readonly score: number;
      readonly dodges: number;
      readonly correctDodges: number;
      readonly hits: number;
    };

export interface DodgeChallengeSnapshot {
  readonly timeSeconds: number;
  readonly status: DodgeChallengeStatus;
  readonly phase: DodgePhase;
  /** Index of the active attack; equals the sequence length after a completed sequence. */
  readonly attackIndex: number;
  readonly currentAttack: DodgeAttackSpec | undefined;
  readonly phaseEndsAtSeconds: number | undefined;
  readonly laneZone: LaneZone;
  readonly score: number;
  /** Attacks avoided, counting both correct and early outcomes. */
  readonly dodges: number;
  readonly correctDodges: number;
  readonly earlyDodges: number;
  /** Blows taken, counting both late reactions and clean hits. */
  readonly hits: number;
  readonly lateHits: number;
  readonly resolvedAttacks: number;
}

function resolveDodgeConfig(overrides: Partial<DodgeChallengeConfig>): DodgeChallengeConfig {
  const config = { ...DEFAULT_DODGE_CHALLENGE_CONFIG, ...overrides };
  for (const [name, value] of [
    ['telegraphSeconds', config.telegraphSeconds],
    ['activeSeconds', config.activeSeconds],
    ['resolvedSeconds', config.resolvedSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite positive number`);
  }
  for (const [name, value] of [
    ['correctDodgePoints', config.correctDodgePoints],
    ['earlyDodgePoints', config.earlyDodgePoints],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  }
  if (!Number.isFinite(config.targetScore) || config.targetScore <= 0) {
    throw new RangeError('targetScore must be a finite positive number');
  }
  if (!Number.isInteger(config.requiredDodges) || config.requiredDodges <= 0) {
    throw new RangeError('requiredDodges must be a positive integer');
  }
  if (!Number.isInteger(config.maxHits) || config.maxHits < 0) {
    throw new RangeError('maxHits must be a non-negative integer');
  }
  return config;
}

function resolveDodgeSequence(sequence: readonly DodgeAttackSpec[]): readonly DodgeAttackSpec[] {
  if (sequence.length === 0) throw new RangeError('dodge sequence cannot be empty');
  return sequence.map((attack, index) => {
    assertLaneZone(attack.attackLane);
    assertLaneZone(attack.safeLane);
    if (attack.attackLane === attack.safeLane) {
      throw new RangeError(`dodge attack ${index} must threaten a different lane from its safe lane`);
    }
    return { attackLane: attack.attackLane, safeLane: attack.safeLane };
  });
}

/**
 * Fixed-sequence dodge trainer. `advance(dtSeconds, laneZone)` treats `laneZone`
 * as constant for that step; a lane change is therefore credited at the step start.
 * At an attack's resolution the current continuous safe-lane occupancy is classified:
 *
 * - `early`: occupied the safe lane no later than the telegraph start;
 * - `correct`: entered it after the telegraph start and no later than the active start;
 * - `late`: entered it during the active phase and stayed there (a hit);
 * - `hit`: was outside the safe lane when the active phase ended.
 *
 * Occupying the safe lane exactly when the telegraph appears counts as early, while
 * entering it exactly when the active phase starts counts as correct. Correct and
 * early outcomes avoid the blow; `late` and `hit` outcomes both increment the hit counter.
 * Victory is decided when the sequence completes from score, dodge and hit targets,
 * while exceeding the hit limit loses immediately.
 */
export class DodgeChallenge {
  private readonly sequence: readonly DodgeAttackSpec[];
  private readonly config: DodgeChallengeConfig;
  private timeSeconds = 0;
  private status: DodgeChallengeStatus = 'active';
  private phase: DodgePhase = 'telegraph';
  private attackIndex = 0;
  private attackStartedAtSeconds = 0;
  private laneZone: LaneZone = 0;
  private laneSinceSeconds = 0;
  private score = 0;
  private dodges = 0;
  private correctDodges = 0;
  private earlyDodges = 0;
  private hits = 0;
  private lateHits = 0;
  private resolvedAttacks = 0;

  constructor(
    sequence: readonly DodgeAttackSpec[] = DEFAULT_DODGE_SEQUENCE,
    config: Partial<DodgeChallengeConfig> = {},
  ) {
    this.sequence = resolveDodgeSequence(sequence);
    this.config = resolveDodgeConfig(config);
    if (this.config.requiredDodges > this.sequence.length) {
      throw new RangeError('requiredDodges cannot exceed the dodge sequence length');
    }
  }

  get snapshot(): DodgeChallengeSnapshot {
    const attack = this.sequence[this.attackIndex];
    return {
      timeSeconds: this.timeSeconds,
      status: this.status,
      phase: this.phase,
      attackIndex: this.attackIndex,
      currentAttack: attack === undefined || this.phase === 'complete' ? undefined : { ...attack },
      phaseEndsAtSeconds: this.phase === 'complete' ? undefined : this.phaseEndTime(),
      laneZone: this.laneZone,
      score: this.score,
      dodges: this.dodges,
      correctDodges: this.correctDodges,
      earlyDodges: this.earlyDodges,
      hits: this.hits,
      lateHits: this.lateHits,
      resolvedAttacks: this.resolvedAttacks,
    };
  }

  advance(dtSeconds: number, laneZone: LaneZone): readonly DodgeChallengeEvent[] {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) throw new RangeError('dtSeconds must be finite and non-negative');
    assertLaneZone(laneZone);
    if (this.status !== 'active') return [];

    const stepStartedAtSeconds = this.timeSeconds;
    if (laneZone !== this.laneZone) {
      this.laneZone = laneZone;
      this.laneSinceSeconds = stepStartedAtSeconds;
    }

    const events: DodgeChallengeEvent[] = [];
    let remainingSeconds = dtSeconds;
    while (remainingSeconds > 0 && this.status === 'active') {
      const phaseEndTime = this.phaseEndTime();
      const secondsToPhaseEnd = phaseEndTime - this.timeSeconds;
      if (remainingSeconds + TIME_EPSILON_SECONDS < secondsToPhaseEnd) {
        this.timeSeconds += remainingSeconds;
        remainingSeconds = 0;
        break;
      }

      this.timeSeconds = phaseEndTime;
      this.finishCurrentPhase(events);
      remainingSeconds = Math.max(0, remainingSeconds - Math.max(0, secondsToPhaseEnd));
    }
    return events;
  }

  private phaseEndTime(): number {
    if (this.phase === 'telegraph') return this.attackStartedAtSeconds + this.config.telegraphSeconds;
    if (this.phase === 'active') {
      return this.attackStartedAtSeconds + this.config.telegraphSeconds + this.config.activeSeconds;
    }
    if (this.phase === 'resolved') {
      return (
        this.attackStartedAtSeconds +
        this.config.telegraphSeconds +
        this.config.activeSeconds +
        this.config.resolvedSeconds
      );
    }
    return this.timeSeconds;
  }

  private finishCurrentPhase(events: DodgeChallengeEvent[]): void {
    if (this.phase === 'telegraph') {
      this.phase = 'active';
      events.push({ kind: 'attack-active', timeSeconds: this.timeSeconds, attackIndex: this.attackIndex });
      return;
    }

    if (this.phase === 'active') {
      const outcome = this.classifyOutcome();
      const points =
        outcome === 'correct' ? this.config.correctDodgePoints : outcome === 'early' ? this.config.earlyDodgePoints : 0;
      this.applyOutcome(outcome, points);
      const attack = this.sequence[this.attackIndex]!;
      const reactionSeconds =
        this.laneZone === attack.safeLane ? this.laneSinceSeconds - this.attackStartedAtSeconds : undefined;
      events.push({
        kind: 'attack-resolved',
        timeSeconds: this.timeSeconds,
        attackIndex: this.attackIndex,
        outcome,
        reactionSeconds,
        points,
        score: this.score,
        dodges: this.dodges,
        hits: this.hits,
      });
      if (this.hits > this.config.maxHits) {
        this.finishAsLost(events, 'hit-limit');
      } else {
        this.phase = 'resolved';
      }
      return;
    }

    if (this.phase !== 'resolved') return;
    const nextAttackIndex = this.attackIndex + 1;
    if (nextAttackIndex < this.sequence.length) {
      this.attackIndex = nextAttackIndex;
      this.attackStartedAtSeconds = this.timeSeconds;
      this.phase = 'telegraph';
      const attack = this.sequence[this.attackIndex]!;
      events.push({
        kind: 'attack-telegraph',
        timeSeconds: this.timeSeconds,
        attackIndex: this.attackIndex,
        attackLane: attack.attackLane,
        safeLane: attack.safeLane,
      });
      return;
    }

    this.attackIndex = this.sequence.length;
    this.phase = 'complete';
    const won =
      this.score >= this.config.targetScore &&
      this.dodges >= this.config.requiredDodges &&
      this.hits <= this.config.maxHits;
    if (won) {
      this.status = 'won';
      events.push({
        kind: 'won',
        timeSeconds: this.timeSeconds,
        score: this.score,
        dodges: this.dodges,
        correctDodges: this.correctDodges,
        hits: this.hits,
      });
    } else {
      this.finishAsLost(events, 'requirements');
    }
  }

  private classifyOutcome(): DodgeOutcome {
    const attack = this.sequence[this.attackIndex]!;
    if (this.laneZone !== attack.safeLane) return 'hit';
    if (this.laneSinceSeconds <= this.attackStartedAtSeconds + TIME_EPSILON_SECONDS) return 'early';
    const activeStartsAtSeconds = this.attackStartedAtSeconds + this.config.telegraphSeconds;
    if (this.laneSinceSeconds <= activeStartsAtSeconds + TIME_EPSILON_SECONDS) return 'correct';
    return 'late';
  }

  private applyOutcome(outcome: DodgeOutcome, points: number): void {
    this.resolvedAttacks += 1;
    this.score += points;
    if (outcome === 'correct') {
      this.dodges += 1;
      this.correctDodges += 1;
    } else if (outcome === 'early') {
      this.dodges += 1;
      this.earlyDodges += 1;
    } else {
      this.hits += 1;
      if (outcome === 'late') this.lateHits += 1;
    }
  }

  private finishAsLost(events: DodgeChallengeEvent[], reason: 'hit-limit' | 'requirements'): void {
    this.status = 'lost';
    this.phase = 'complete';
    events.push({
      kind: 'lost',
      reason,
      timeSeconds: this.timeSeconds,
      score: this.score,
      dodges: this.dodges,
      correctDodges: this.correctDodges,
      hits: this.hits,
    });
  }
}
