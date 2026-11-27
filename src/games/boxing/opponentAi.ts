/**
 * Pure boxing opponent AI — no DOM, no Three.js, no Math.random, no clocks.
 *
 * The opponent cycles guard -> windup -> recover -> guard, with at most one transition
 * per `stepOpponent` call. Time and `rng` (a `() => number` in [0, 1)) are injected,
 * and rolls are consumed in a fixed order:
 * - `createOpponentAi`: (1) guard duration.
 * - guard -> windup: (1) hand, (2) windup duration.
 * - windup -> recover: none.
 * - recover -> guard: (1) guard duration.
 * - a step without a transition: none.
 *
 * Punches are adjudicated at their past peak time, so `openingAt` looks back through
 * `previous`. One step of history is enough because every phase is measured from the
 * step that started it and lasts longer than MAX_PUNCH_LOOKBACK_MS: that window never
 * spans two transitions. There is deliberately no reaction to being hit, so punches
 * cannot stunlock the opponent.
 */

import type { Hand } from '../../cv/protocol';

/** Lateral position of the player: left, center, right. */
export type Zone = -1 | 0 | 1;
export type { Hand };

export type OpponentPhase =
  | { readonly kind: 'guard'; readonly untilMs: number }
  | { readonly kind: 'windup'; readonly hand: Hand; readonly targetZone: Zone; readonly impactAtMs: number }
  | { readonly kind: 'recover'; readonly untilMs: number };

export interface OpponentAiState {
  /** 0..1; higher guards shorter, winds up faster and recovers sooner. */
  readonly skill: number;
  readonly phase: OpponentPhase;
  readonly previous?: OpponentPhase;
  readonly phaseStartedMs: number;
}

export interface OpponentAttack {
  readonly hand: Hand;
  readonly targetZone: Zone;
  readonly impactAtMs: number;
}

export interface OpponentStep {
  readonly state: OpponentAiState;
  readonly attack?: OpponentAttack;
}

export const DEFAULT_SKILL = 0.5;
/** Delay after impact before an attack is resolved, to absorb pose latency. */
export const IMPACT_GRACE_MS = 150;
/** Oldest punch time, relative to now, that `openingAt` is guaranteed to answer correctly. */
export const MAX_PUNCH_LOOKBACK_MS = 450;
export const WINDUP_MIN_MS = 600;
export const WINDUP_MAX_MS = 900;
const WINDUP_JITTER_MS = 100;
/** Shortest guard at skill 0 / skill 1, before jitter. */
const GUARD_SLOW_MS = 900;
const GUARD_FAST_MS = 500;
const GUARD_JITTER_MS = 800;
const RECOVER_SLOW_MS = 800;
const RECOVER_FAST_MS = 500;

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

const guardPhase = (nowMs: number, skill: number, rng: () => number): OpponentPhase => ({
  kind: 'guard',
  untilMs: nowMs + lerp(GUARD_SLOW_MS, GUARD_FAST_MS, skill) + rng() * GUARD_JITTER_MS,
});

const enter = (state: OpponentAiState, phase: OpponentPhase, nowMs: number): OpponentAiState =>
  Object.freeze({
    skill: state.skill,
    phase: Object.freeze(phase),
    previous: state.phase,
    phaseStartedMs: nowMs,
  });

/** `skill` is clamped to 0..1; a non-finite value falls back to DEFAULT_SKILL. */
export function createOpponentAi(nowMs: number, rng: () => number, skill = DEFAULT_SKILL): OpponentAiState {
  const clamped = Number.isFinite(skill) ? Math.min(1, Math.max(0, skill)) : DEFAULT_SKILL;
  return Object.freeze({
    skill: clamped,
    phase: Object.freeze(guardPhase(nowMs, clamped, rng)),
    phaseStartedMs: nowMs,
  });
}

/**
 * Advances the cycle. A windup aims at the zone the player occupies when it starts.
 * `attack` is returned exactly once per windup, on the first step at or after
 * `impactAtMs + IMPACT_GRACE_MS`; the caller collects the player's zones over
 * [impactAtMs, impactAtMs + IMPACT_GRACE_MS] and judges them with `isDodged`.
 */
export function stepOpponent(state: OpponentAiState, nowMs: number, playerZone: Zone, rng: () => number): OpponentStep {
  const { phase, skill } = state;
  switch (phase.kind) {
    case 'guard': {
      if (nowMs < phase.untilMs) return { state };
      const hand: Hand = rng() < 0.5 ? 'left' : 'right';
      // Skill takes up to 200 ms off and jitter up to 100 ms, so the result stays in range.
      const durationMs =
        WINDUP_MAX_MS - skill * (WINDUP_MAX_MS - WINDUP_MIN_MS - WINDUP_JITTER_MS) - rng() * WINDUP_JITTER_MS;
      return {
        state: enter(state, { kind: 'windup', hand, targetZone: playerZone, impactAtMs: nowMs + durationMs }, nowMs),
      };
    }
    case 'windup': {
      if (nowMs < phase.impactAtMs + IMPACT_GRACE_MS) return { state };
      const { hand, targetZone, impactAtMs } = phase;
      const untilMs = nowMs + lerp(RECOVER_SLOW_MS, RECOVER_FAST_MS, skill);
      return {
        state: enter(state, { kind: 'recover', untilMs }, nowMs),
        attack: { hand, targetZone, impactAtMs },
      };
    }
    case 'recover': {
      if (nowMs < phase.untilMs) return { state };
      return { state: enter(state, guardPhase(nowMs, skill, rng), nowMs) };
    }
  }
}

/** Whether a punch peaking at `atMs` finds the opponent exposed (winding up or recovering). */
export function openingAt(state: OpponentAiState, atMs: number): 'open' | 'guard' {
  const phase = atMs < state.phaseStartedMs ? (state.previous ?? state.phase) : state.phase;
  return phase.kind === 'guard' ? 'guard' : 'open';
}

/** True if any sample shows the player outside `targetZone`; no samples means not dodged. */
export function isDodged(targetZone: Zone, zonesDuringImpact: readonly Zone[]): boolean {
  return zonesDuringImpact.some((zone) => zone !== targetZone);
}
