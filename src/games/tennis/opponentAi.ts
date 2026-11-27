/**
 * Pure opponent AI (docs/design-tenis.md §3.7) — no DOM, no Three.js, no Math.random.
 *
 * Everything stochastic flows through the injected `rng` (a `() => number` in [0, 1),
 * so integration may pass Math.random directly while tests pass constants or
 * sequences). `decideReturn` consumes rolls in a fixed documented order — one for the
 * return-or-not decision, then one for lateral placement and one for depth — which
 * makes every rally reproducible for a given rng sequence.
 *
 * MVP simplifications, consciously chosen:
 * - All error modes (net, out, not reaching) collapse into a single binary
 *   return/no-return decision; a no-return is simply a point for the hitter.
 * - The return target is always inside the court — pressure comes from placement
 *   width and ball speed, never from the opponent hitting unforced errors.
 */

export type OpponentSide = 'player' | 'opponent';

export interface OpponentAiConfig {
  /** Skill clamp range for adaptation; the AI never leaves it. */
  readonly minSkill: number;
  readonly maxSkill: number;
  /** Skill gained/lost per point outcome (rubber banding). */
  readonly adaptStep: number;
  /** Flat bonus on the return chance — weak balls almost always come back. */
  readonly generosity: number;
  /** How much of the incoming-ball quality (0..1) eats into the return chance. */
  readonly qualityPressure: number;
  /** Singles sideline of the court the opponent aims at. */
  readonly courtHalfWidth: number;
  /** Distance kept inside the sideline so returns always land in. */
  readonly targetMargin: number;
  /** Placement spread at skill 0 (fraction of the half width); skill 1 uses the full width. */
  readonly minWidthScale: number;
  /** Depth jitter range of the bounce target on the player's side, in court units. */
  readonly shallowTargetZ: number;
  readonly deepTargetZ: number;
  /** Flight time of the return at skill 0 / skill 1 — shorter means a faster ball. */
  readonly slowFlightSeconds: number;
  readonly fastFlightSeconds: number;
}

export const DEFAULT_OPPONENT_AI_CONFIG: OpponentAiConfig = {
  minSkill: 0.3,
  maxSkill: 0.9,
  adaptStep: 0.05,
  generosity: 0.35,
  qualityPressure: 0.5,
  courtHalfWidth: 3.5,
  targetMargin: 0.4,
  minWidthScale: 0.25,
  shallowTargetZ: 3.5,
  deepTargetZ: 8.5,
  slowFlightSeconds: 1.4,
  fastFlightSeconds: 1.05,
};

export interface OpponentAiState {
  readonly skill: number;
}

export type OpponentDecision =
  | {
      readonly kind: 'no-return';
      /** Chance that was rolled against — exposed for tuning and tests. */
      readonly returnChance: number;
    }
  | {
      readonly kind: 'return';
      readonly returnChance: number;
      /** Lateral bounce target on the player's side, always inside the sidelines. */
      readonly targetX: number;
      /** Depth of the bounce target on the player's side. */
      readonly targetZ: number;
      /** Imposed flight time — feed to ballistics solveOutgoing with the contact point. */
      readonly flightTimeSeconds: number;
    };

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

export function createOpponentAi(
  initialSkill = 0.4,
  config: OpponentAiConfig = DEFAULT_OPPONENT_AI_CONFIG,
): OpponentAiState {
  return { skill: clamp(initialSkill, config.minSkill, config.maxSkill) };
}

/**
 * Chance that the opponent returns a ball: skill plus a flat generosity, reduced by
 * how hard the incoming ball is. Weak balls almost always come back (the rally is the
 * fun); fast wide balls pressure even a good opponent.
 */
export function returnChance(
  state: OpponentAiState,
  incomingQuality01: number,
  config: OpponentAiConfig = DEFAULT_OPPONENT_AI_CONFIG,
): number {
  return clamp01(state.skill + config.generosity - clamp01(incomingQuality01) * config.qualityPressure);
}

/**
 * Decides whether the opponent returns the incoming ball and, if so, where the return
 * lands. rng rolls are consumed in a fixed order: (1) return-or-not, (2) lateral
 * placement, (3) depth — a no-return consumes only the first roll.
 */
export function decideReturn(
  state: OpponentAiState,
  incomingQuality01: number,
  rng: () => number,
  config: OpponentAiConfig = DEFAULT_OPPONENT_AI_CONFIG,
): OpponentDecision {
  const chance = returnChance(state, incomingQuality01, config);
  if (!(rng() < chance)) return { kind: 'no-return', returnChance: chance };

  // Low skill plays gentle central balls; high skill uses nearly the full width.
  const widthScale = lerp(config.minWidthScale, 1, state.skill);
  const lateralRoll = rng() * 2 - 1;
  const halfWidth = config.courtHalfWidth - config.targetMargin;
  const targetX = clamp(lateralRoll * widthScale * config.courtHalfWidth, -halfWidth, halfWidth);
  const targetZ = lerp(config.shallowTargetZ, config.deepTargetZ, clamp01(rng()));
  const flightTimeSeconds = lerp(config.slowFlightSeconds, config.fastFlightSeconds, state.skill);
  return { kind: 'return', returnChance: chance, targetX, targetZ, flightTimeSeconds };
}

/**
 * Rubber-band adaptation: the AI tightens when the player wins a point and eases off
 * when the opponent does, never leaving the configured skill range. Input untouched.
 */
export function adaptOpponentSkill(
  state: OpponentAiState,
  pointWinner: OpponentSide,
  config: OpponentAiConfig = DEFAULT_OPPONENT_AI_CONFIG,
): OpponentAiState {
  const delta = pointWinner === 'player' ? config.adaptStep : -config.adaptStep;
  return { skill: clamp(state.skill + delta, config.minSkill, config.maxSkill) };
}
