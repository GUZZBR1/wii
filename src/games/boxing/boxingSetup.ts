import type { BoxingMode } from './boxingModes';
import { DEFAULT_OPPONENT_PROFILE_ID, type OpponentProfileId } from './opponentProfiles';

export interface BoxingSetup {
  mode: BoxingMode;
  opponent: OpponentProfileId;
}

export const DEFAULT_BOXING_SETUP: BoxingSetup = { mode: 'fight', opponent: DEFAULT_OPPONENT_PROFILE_ID };
