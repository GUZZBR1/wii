import { describe, expect, it } from 'vitest';
import {
  CPU_MIIS,
  DEFAULT_PLAYER_MII,
  sanitizeMiiProfile,
  validateMiiProfile,
} from '../src/miis/miiCatalog';
import {
  EYE_STYLES,
  EYEBROW_STYLES,
  FACIAL_HAIR_STYLES,
  GLASSES_STYLES,
  HAIR_STYLES,
  HEAD_SHAPES,
  MII_NAME_MAX_LENGTH,
  MOUTH_STYLES,
  NOSE_STYLES,
} from '../src/miis/miiTypes';

describe('miiCatalog', () => {
  it('provides at least 24 valid CPU Miis with unique ids, case-insensitive unique names, and distinct skills', () => {
    expect(CPU_MIIS.length).toBeGreaterThanOrEqual(24);
    expect(CPU_MIIS.length).toBe(30);

    const ids = new Set(CPU_MIIS.map((mii) => mii.id));
    expect(ids.size).toBe(CPU_MIIS.length);
    expect(ids.has('player-mii')).toBe(false);

    const lowerNames = new Set(CPU_MIIS.map((mii) => mii.name.trim().toLowerCase()));
    expect(lowerNames.size).toBe(CPU_MIIS.length);

    const skills = new Set(CPU_MIIS.map((mii) => mii.skill));
    expect(skills.size).toBe(CPU_MIIS.length);

    for (const mii of CPU_MIIS) {
      expect(mii.isCpu).toBe(true);
      expect(mii.skill).toBeGreaterThan(0);
      expect(mii.skill).toBeLessThanOrEqual(1);
      expect(validateMiiProfile(mii)).toEqual({ valid: true, errors: [] });
    }
  });

  it('exercises all Mii Channel trait enums across the CPU roster', () => {
    const checkCoverage = (expected: readonly string[], getter: (m: (typeof CPU_MIIS)[number]) => string) => {
      const seen = new Set(CPU_MIIS.map(getter));
      for (const value of expected) {
        expect(seen.has(value)).toBe(true);
      }
    };

    checkCoverage(HEAD_SHAPES, (m) => m.headShape);
    checkCoverage(HAIR_STYLES, (m) => m.hairStyle);
    checkCoverage(EYEBROW_STYLES, (m) => m.eyebrowStyle);
    checkCoverage(EYE_STYLES, (m) => m.eyeStyle);
    checkCoverage(NOSE_STYLES, (m) => m.noseStyle);
    checkCoverage(MOUTH_STYLES, (m) => m.mouthStyle);
    checkCoverage(FACIAL_HAIR_STYLES, (m) => m.facialHair);
    checkCoverage(GLASSES_STYLES, (m) => m.glasses);
  });

  it('validates DEFAULT_PLAYER_MII cleanly', () => {
    expect(DEFAULT_PLAYER_MII.id).toBe('player-mii');
    expect(DEFAULT_PLAYER_MII.isCpu).toBe(false);
    expect(validateMiiProfile(DEFAULT_PLAYER_MII)).toEqual({ valid: true, errors: [] });
  });

  it('validateMiiProfile rejects invalid shapes, enums, ranges, colors, and names', () => {
    expect(validateMiiProfile(null).valid).toBe(false);
    expect(validateMiiProfile([]).valid).toBe(false);
    expect(validateMiiProfile('mii').valid).toBe(false);

    const bad = {
      ...DEFAULT_PLAYER_MII,
      id: '   ',
      name: '   ',
      isCpu: 'no',
      skill: Number.NaN,
      height: -0.2,
      build: Number.POSITIVE_INFINITY,
      headShape: 'hexagonal',
      hairStyle: 'afro-mega',
      eyebrowStyle: 'invisible',
      eyeStyle: 'laser',
      noseStyle: 'clown',
      mouthStyle: 'scream',
      facialHair: 'handlebar',
      glasses: 'monocle',
      skinTone: 'peach',
      hairColor: '#12345',
      eyeColor: 'rgb(0,0,0)',
      shirtColor: '',
    };
    const result = validateMiiProfile(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(15);

    const overlong = validateMiiProfile({ ...DEFAULT_PLAYER_MII, name: 'A'.repeat(MII_NAME_MAX_LENGTH + 1) });
    expect(overlong.valid).toBe(false);
  });

  it('sanitizeMiiProfile clamps numeric bounds, upgrades legacy V1 profiles, and does not mutate input', () => {
    const legacyInput = {
      id: 'legacy-1',
      name: '  Ana Clara Silva Extra  ',
      isCpu: false,
      skill: 1.8,
      skinTone: '#E0A370',
      hairStyle: 'bob',
      hairColor: '#A83226',
      eyeStyle: 'wink',
      eyeColor: '#2563EB',
      mouthStyle: 'grin',
      glasses: 'round',
      shirtColor: '#7C3AED',
      height: Number.NaN,
      build: -5,
    };
    const snapshot = structuredClone(legacyInput);
    const sanitized = sanitizeMiiProfile(legacyInput, DEFAULT_PLAYER_MII);

    expect(legacyInput).toEqual(snapshot);
    expect(sanitized.name).toBe('Ana Clara Silv');
    expect(sanitized.skill).toBe(1);
    expect(sanitized.height).toBe(DEFAULT_PLAYER_MII.height);
    expect(sanitized.build).toBe(0);
    expect(sanitized.headShape).toBe(DEFAULT_PLAYER_MII.headShape);
    expect(sanitized.eyebrowStyle).toBe(DEFAULT_PLAYER_MII.eyebrowStyle);
    expect(sanitized.noseStyle).toBe(DEFAULT_PLAYER_MII.noseStyle);
    expect(sanitized.facialHair).toBe(DEFAULT_PLAYER_MII.facialHair);
    expect(sanitized.hairStyle).toBe('bob');
    expect(validateMiiProfile(sanitized)).toEqual({ valid: true, errors: [] });

    expect(sanitizeMiiProfile(null, DEFAULT_PLAYER_MII)).toEqual(DEFAULT_PLAYER_MII);
    expect(sanitizeMiiProfile([1, 2, 3], DEFAULT_PLAYER_MII)).toEqual(DEFAULT_PLAYER_MII);
  });
});
