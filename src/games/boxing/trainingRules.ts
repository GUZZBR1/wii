/**
 * The boxing trainers' public surface. The rules are pure and split by challenge; this barrel keeps
 * one import path for the game and its tests.
 */
export type { LaneZone } from './punchingBagRules';
export { DEFAULT_PUNCHING_BAG_CONFIG, PunchingBagTrainer } from './punchingBagRules';
export type {
  PunchInput,
  PunchingBagConfig,
  PunchingBagErrorReason,
  PunchingBagEvent,
  PunchingBagSnapshot,
} from './punchingBagRules';
export { DEFAULT_DODGE_CHALLENGE_CONFIG, DEFAULT_DODGE_SEQUENCE, DodgeChallenge } from './dodgeChallengeRules';
export type {
  DodgeAttackSpec,
  DodgeChallengeConfig,
  DodgeChallengeEvent,
  DodgeChallengeSnapshot,
  DodgeChallengeStatus,
  DodgeOutcome,
  DodgePhase,
} from './dodgeChallengeRules';
