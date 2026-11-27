import { describe, expect, it } from 'vitest';
import { OPPONENT_PROFILES, opponentProfile } from '../src/games/boxing/opponentProfiles';

describe('boxing opponent profiles', () => {
  it('offers beginner, aggressive and technical skill levels', () => {
    expect(OPPONENT_PROFILES.map((profile) => [profile.label, profile.skill])).toEqual([
      ['Iniciante', 0.25],
      ['Agressivo', 0.55],
      ['Técnico', 0.85],
    ]);
  });

  it('gives every opponent a distinct shirt, shorts and glove palette', () => {
    const palettes = OPPONENT_PROFILES.map((profile) => [profile.shirtColor, profile.shortsColor, profile.gloveColor].join('/'));
    expect(new Set(palettes).size).toBe(OPPONENT_PROFILES.length);
    for (const profile of OPPONENT_PROFILES) {
      expect(opponentProfile(profile.id)).toBe(profile);
    }
  });
});
