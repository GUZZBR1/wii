export const OPPONENT_PROFILES = [
  {
    id: 'rookie',
    label: 'Iniciante',
    skill: 0.25,
    miiSeed: 'boxing-rookie',
    shirtColor: 0x38a864,
    trimColor: 0xf7f5f0,
    shortsColor: 0x1f6f46,
    gloveColor: 0x2d8d54,
  },
  {
    id: 'aggressive',
    label: 'Agressivo',
    skill: 0.55,
    miiSeed: 'boxing-aggressive',
    shirtColor: 0xd84a3a,
    trimColor: 0xffc93c,
    shortsColor: 0x6f1f1f,
    gloveColor: 0xc7352d,
  },
  {
    id: 'technical',
    label: 'Técnico',
    skill: 0.85,
    miiSeed: 'boxing-technical',
    shirtColor: 0x6e55c8,
    trimColor: 0x9fdcff,
    shortsColor: 0x2c275f,
    gloveColor: 0x5640ad,
  },
] as const;

export type OpponentProfileId = (typeof OPPONENT_PROFILES)[number]['id'];
export type OpponentProfile = (typeof OPPONENT_PROFILES)[number];

export const DEFAULT_OPPONENT_PROFILE_ID: OpponentProfileId = 'aggressive';

export function opponentProfile(id: OpponentProfileId = DEFAULT_OPPONENT_PROFILE_ID): OpponentProfile {
  return OPPONENT_PROFILES.find((profile) => profile.id === id) ?? OPPONENT_PROFILES[1];
}
