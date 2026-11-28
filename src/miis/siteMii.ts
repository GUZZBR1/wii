/**
 * The site's Mii representation. The face uses the games' `MiiFaceSpec` (the same saved key), so
 * the Mii created on the home page enters the arena; name, outfit, and build are site-only details.
 */
import {
  EYE_PALETTE,
  generateMiiFromSeed,
  HAIR_PALETTE,
  loadPlayerMii as loadFace,
  type MiiFaceSpec,
  normalizeMiiFaceSpec,
  SKIN_PALETTE,
  savePlayerMii as saveFace,
  DEFAULT_MII_FACE_SPEC,
} from '../mii/miiSpec';
import { DEFAULT_PLAYER_MII, sanitizeMiiProfile, STORAGE_KEY } from './miiCatalog';
import { type MiiProfile, SHIRT_COLORS } from './miiTypes';

export interface SiteMii {
  readonly name: string;
  readonly isCpu: boolean;
  readonly skill: number;
  readonly shirtColor: string;
  readonly height: number;
  readonly build: number;
  readonly face: MiiFaceSpec;
}

// Map catalog/photo styles to the game-style indices.
const HEAD = { oval: 1, round: 0, square: 2, tapered: 5 };
const HAIR = {
  short: 1, spiky: 3, bob: 4, long: 9, bald: 0, ponytail: 5,
  curly: 7, parted: 2, mohawk: 6, buns: 11, sideSweep: 10, buzz: 8,
};
const BROWS = { classic: 1, arched: 3, thick: 4, flat: 1, raised: 2 };
const EYES = { classic: 0, wide: 8, relaxed: 4, wink: 3, sharp: 6, sparkle: 7 };
const NOSE = { button: 1, straight: 4, wide: 3, pointed: 2 };
const MOUTH = { smile: 0, grin: 5, neutral: 1, open: 2, smirk: 9, cat: 6 };
const BEARD = { none: 0, stubble: 1, mustache: 3, goatee: 2, beard: 4 };
const GLASSES = { none: 0, round: 1, square: 2, halfRim: 4, sunglasses: 3 };

function nearest(palette: readonly number[], hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const distance = (color: number) =>
    [16, 8, 0].reduce((sum, shift) => sum + (((color >> shift) & 255) - ((value >> shift) & 255)) ** 2, 0);
  return palette.reduce((best, color, index) => (distance(color) < distance(palette[best]) ? index : best), 0);
}

export function faceFromProfile(profile: MiiProfile): MiiFaceSpec {
  return normalizeMiiFaceSpec({
    ...DEFAULT_MII_FACE_SPEC,
    skin: nearest(SKIN_PALETTE, profile.skinTone),
    hairColor: nearest(HAIR_PALETTE, profile.hairColor),
    eyeColor: nearest(EYE_PALETTE, profile.eyeColor),
    head: HEAD[profile.headShape],
    hair: HAIR[profile.hairStyle],
    brows: BROWS[profile.eyebrowStyle],
    eyes: EYES[profile.eyeStyle],
    nose: NOSE[profile.noseStyle],
    mouth: MOUTH[profile.mouthStyle],
    beard: BEARD[profile.facialHair],
    glasses: GLASSES[profile.glasses],
  });
}

export function siteMiiFromProfile(profile: MiiProfile): SiteMii {
  const { name, isCpu, skill, shirtColor, height, build } = profile;
  return { name, isCpu, skill, shirtColor, height, build, face: faceFromProfile(profile) };
}

export function randomSiteMii(current: SiteMii, rng: () => number = Math.random): SiteMii {
  return {
    ...current,
    face: generateMiiFromSeed(rng()),
    shirtColor: SHIRT_COLORS[Math.floor(rng() * SHIRT_COLORS.length) % SHIRT_COLORS.length],
    height: rng(),
    build: rng(),
  };
}

export function loadSiteMii(): SiteMii {
  let stored: unknown;
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  const { name, shirtColor, height, build } = sanitizeMiiProfile(stored, DEFAULT_PLAYER_MII);
  return { name, shirtColor, height, build, isCpu: false, skill: 0.5, face: loadFace() };
}

export function saveSiteMii(mii: SiteMii): SiteMii {
  const { name, shirtColor, height, build } = sanitizeMiiProfile(mii, DEFAULT_PLAYER_MII);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ name, shirtColor, height, build }));
  } catch {
    // Without storage, this value lasts only for the current visit.
  }
  const face = normalizeMiiFaceSpec(mii.face);
  saveFace(face);
  return { name, shirtColor, height, build, face, isCpu: false, skill: 0.5 };
}
