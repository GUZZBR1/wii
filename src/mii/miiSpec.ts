export const SKIN_PALETTE = [0xffd9b3, 0xf2c29a, 0xdca57c, 0xb97a56, 0x8f543c, 0x5f3527] as const;
export const HAIR_PALETTE = [0x17120f, 0x3a2418, 0x5b3824, 0x8a5a32, 0xb88755, 0xd8d3c8, 0xb7432f, 0x4f6f9f] as const;
export const EYE_PALETTE = [0x191919, 0x4a2f1f, 0x2f5f8f, 0x3e7a4f, 0x6b4f8f, 0x7d6b57] as const;
export const LIP_PALETTE = [0xb96f68, 0xd1847a, 0x9e5257, 0x7e3f48, 0xc99a8d, 0x6e4a44] as const;
export const GLASSES_PALETTE = [0x1d252d, 0x6d4b32, 0x8d9299, 0x244d7a, 0x7a2440, 0xd7b23f] as const;

export const MII_STYLE_COUNT = {
  head: 8,
  hair: 12,
  eyes: 12,
  brows: 8,
  nose: 8,
  mouth: 12,
  glasses: 6,
  beard: 6,
} as const;

/**
 * A complete face in small integer coordinates. Vertical positions are face-local, upward-positive
 * percentages, hence browY > eyeY > noseY > mouthY for every valid face.
 */
export interface MiiFaceSpec {
  v: 1;
  skin: number;
  hairColor: number;
  eyeColor: number;
  lipColor: number;
  glassesColor: number;
  head: number;
  hair: number;
  eyes: number;
  brows: number;
  nose: number;
  mouth: number;
  glasses: number;
  beard: number;
  browY: number;
  eyeY: number;
  noseY: number;
  mouthY: number;
  eyeSpacing: number;
  eyeScale: number;
  eyeTilt: number;
  browTilt: number;
  mouthWidth: number;
  mouthCurve: number;
}

const PALETTE_RANGES = {
  skin: SKIN_PALETTE.length,
  hairColor: HAIR_PALETTE.length,
  eyeColor: EYE_PALETTE.length,
  lipColor: LIP_PALETTE.length,
  glassesColor: GLASSES_PALETTE.length,
} as const;

const LIMITS = {
  browY: [54, 78],
  eyeY: [42, 62],
  noseY: [30, 50],
  mouthY: [18, 34],
  eyeSpacing: [12, 26],
  eyeScale: [7, 14],
  eyeTilt: [-14, 14],
  browTilt: [-16, 16],
  mouthWidth: [16, 36],
  mouthCurve: [-10, 10],
} as const;

const MIN_NOSE_GAP = 8;
const MIN_EYE_GAP = 9;
const MIN_BROW_GAP = 7;

export const PLAYER_MII_STORAGE_KEY = 'wii-mii-face-v1';

export const DEFAULT_MII_FACE_SPEC: MiiFaceSpec = Object.freeze({
  v: 1,
  skin: 1,
  hairColor: 1,
  eyeColor: 0,
  lipColor: 0,
  glassesColor: 0,
  head: 0,
  hair: 1,
  eyes: 0,
  brows: 1,
  nose: 1,
  mouth: 0,
  glasses: 0,
  beard: 0,
  browY: 65,
  eyeY: 55,
  noseY: 41,
  mouthY: 27,
  eyeSpacing: 18,
  eyeScale: 10,
  eyeTilt: 0,
  browTilt: 0,
  mouthWidth: 24,
  mouthCurve: 3,
});

const integerIn = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
const integerInLimits = (value: number, [min, max]: readonly [number, number]) => integerIn(value, min, max);

/** Clamps and quantizes a face, then re-establishes the non-overlapping vertical bands bottom-up. */
export function normalizeMiiFaceSpec(spec: MiiFaceSpec): MiiFaceSpec {
  const mouthY = integerInLimits(spec.mouthY, LIMITS.mouthY);
  const noseY = Math.max(integerInLimits(spec.noseY, LIMITS.noseY), mouthY + MIN_NOSE_GAP);
  const eyeY = Math.max(integerInLimits(spec.eyeY, LIMITS.eyeY), noseY + MIN_EYE_GAP);
  const browY = Math.max(integerInLimits(spec.browY, LIMITS.browY), eyeY + MIN_BROW_GAP);
  return {
    v: 1,
    skin: integerIn(spec.skin, 0, PALETTE_RANGES.skin - 1),
    hairColor: integerIn(spec.hairColor, 0, PALETTE_RANGES.hairColor - 1),
    eyeColor: integerIn(spec.eyeColor, 0, PALETTE_RANGES.eyeColor - 1),
    lipColor: integerIn(spec.lipColor, 0, PALETTE_RANGES.lipColor - 1),
    glassesColor: integerIn(spec.glassesColor, 0, PALETTE_RANGES.glassesColor - 1),
    head: integerIn(spec.head, 0, MII_STYLE_COUNT.head - 1),
    hair: integerIn(spec.hair, 0, MII_STYLE_COUNT.hair - 1),
    eyes: integerIn(spec.eyes, 0, MII_STYLE_COUNT.eyes - 1),
    brows: integerIn(spec.brows, 0, MII_STYLE_COUNT.brows - 1),
    nose: integerIn(spec.nose, 0, MII_STYLE_COUNT.nose - 1),
    mouth: integerIn(spec.mouth, 0, MII_STYLE_COUNT.mouth - 1),
    glasses: integerIn(spec.glasses, 0, MII_STYLE_COUNT.glasses - 1),
    beard: integerIn(spec.beard, 0, MII_STYLE_COUNT.beard - 1),
    browY,
    eyeY,
    noseY,
    mouthY,
    eyeSpacing: integerInLimits(spec.eyeSpacing, LIMITS.eyeSpacing),
    eyeScale: integerInLimits(spec.eyeScale, LIMITS.eyeScale),
    eyeTilt: integerInLimits(spec.eyeTilt, LIMITS.eyeTilt),
    browTilt: integerInLimits(spec.browTilt, LIMITS.browTilt),
    mouthWidth: integerInLimits(spec.mouthWidth, LIMITS.mouthWidth),
    mouthCurve: integerInLimits(spec.mouthCurve, LIMITS.mouthCurve),
  };
}

const TUPLE_KEYS = [
  'v',
  'skin',
  'hairColor',
  'eyeColor',
  'lipColor',
  'glassesColor',
  'head',
  'hair',
  'eyes',
  'brows',
  'nose',
  'mouth',
  'glasses',
  'beard',
  'browY',
  'eyeY',
  'noseY',
  'mouthY',
  'eyeSpacing',
  'eyeScale',
  'eyeTilt',
  'browTilt',
  'mouthWidth',
  'mouthCurve',
] as const;

/** Compact tuple JSON: every generated face is below 100 bytes and needs no asset or extra storage. */
export function serializeMiiFaceSpec(spec: MiiFaceSpec): string {
  const normalized = normalizeMiiFaceSpec(spec);
  return JSON.stringify(TUPLE_KEYS.map((key) => normalized[key]));
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function validTupleFace(values: unknown[]): MiiFaceSpec | undefined {
  if (values.length !== TUPLE_KEYS.length || values[0] !== 1) return undefined;
  const numbers = values.slice(1);
  const ranges = [
    [0, PALETTE_RANGES.skin - 1],
    [0, PALETTE_RANGES.hairColor - 1],
    [0, PALETTE_RANGES.eyeColor - 1],
    [0, PALETTE_RANGES.lipColor - 1],
    [0, PALETTE_RANGES.glassesColor - 1],
    [0, MII_STYLE_COUNT.head - 1],
    [0, MII_STYLE_COUNT.hair - 1],
    [0, MII_STYLE_COUNT.eyes - 1],
    [0, MII_STYLE_COUNT.brows - 1],
    [0, MII_STYLE_COUNT.nose - 1],
    [0, MII_STYLE_COUNT.mouth - 1],
    [0, MII_STYLE_COUNT.glasses - 1],
    [0, MII_STYLE_COUNT.beard - 1],
    LIMITS.browY,
    LIMITS.eyeY,
    LIMITS.noseY,
    LIMITS.mouthY,
    LIMITS.eyeSpacing,
    LIMITS.eyeScale,
    LIMITS.eyeTilt,
    LIMITS.browTilt,
    LIMITS.mouthWidth,
    LIMITS.mouthCurve,
  ] as const;
  if (!numbers.every((value, index) => validInteger(value, ranges[index]![0], ranges[index]![1]))) return undefined;
  const spec = Object.fromEntries(TUPLE_KEYS.map((key, index) => [key, values[index]])) as unknown as MiiFaceSpec;
  if (!(spec.browY > spec.eyeY && spec.eyeY > spec.noseY && spec.noseY > spec.mouthY)) return undefined;
  return spec;
}

export function deserializeMiiFaceSpec(encoded: string): MiiFaceSpec | undefined {
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!Array.isArray(parsed)) return undefined;
    return validTupleFace(parsed);
  } catch {
    return undefined;
  }
}

/** In-memory copy kept even when persistent storage fails, so the face survives within the session. */
let sessionPlayerMii: MiiFaceSpec | undefined;

/**
 * A save that could not be persisted. `encodedBeforeSave` is the exact storage payload immediately before
 * the failed write (`null` when absent, `undefined` when unreadable), letting a later changed valid payload
 * win as an external write while an unchanged stale payload cannot shadow the session save.
 */
let pendingSessionSave:
  | {
      spec: MiiFaceSpec;
      encodedBeforeSave: string | null | undefined;
    }
  | undefined;

/** Returns the raw storage payload, `null` when absent, or `undefined` when storage cannot be read. */
function readEncodedPlayerMii(): string | null | undefined {
  try {
    const storage = globalThis.localStorage;
    return storage ? storage.getItem(PLAYER_MII_STORAGE_KEY) : null;
  } catch {
    return undefined;
  }
}

export function loadPlayerMii(): MiiFaceSpec {
  const encoded = readEncodedPlayerMii();
  const pending = pendingSessionSave;
  if (pending && pending.encodedBeforeSave === undefined && encoded !== undefined) {
    // If storage was unreadable during the failed save, conservatively treat the first readable payload as
    // the pre-save baseline; subsequent changed valid payloads are then recognizable as external writes.
    pending.encodedBeforeSave = encoded;
  }

  const stored = typeof encoded === 'string' ? deserializeMiiFaceSpec(encoded) : undefined;
  if (stored) {
    if (!pending) return { ...stored };
    if (encoded !== pending.encodedBeforeSave) {
      pendingSessionSave = undefined;
      return { ...stored };
    }
    return { ...pending.spec };
  }
  return { ...((pending?.spec ?? sessionPlayerMii) ?? DEFAULT_MII_FACE_SPEC) };
}

/** Returns true only when the face was actually persisted; it always lives on in session memory either way. */
export function savePlayerMii(spec: MiiFaceSpec): boolean {
  const normalized = normalizeMiiFaceSpec(spec);
  sessionPlayerMii = normalized;
  let encodedBeforeSave: string | null | undefined;
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      pendingSessionSave = { spec: normalized, encodedBeforeSave: null };
      return false;
    }
    encodedBeforeSave = readEncodedPlayerMii();
    storage.setItem(PLAYER_MII_STORAGE_KEY, serializeMiiFaceSpec(normalized));
    pendingSessionSave = undefined;
    return true;
  } catch {
    pendingSessionSave = { spec: normalized, encodedBeforeSave };
    return false;
  }
}

/** 32-bit FNV-1a, stable across platforms because every multiplication is coerced to uint32. */
export function fnv1a(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** NPC faces are derived only from their seed: deterministic, valid and never written to storage. */
export function generateMiiFromSeed(seed: string | number): MiiFaceSpec {
  const random = mulberry32(fnv1a(String(seed)));
  const pick = (count: number) => Math.floor(random() * count);
  const mouthY = 22 + pick(7);
  const noseY = mouthY + 10 + pick(4);
  const eyeY = noseY + 12 + pick(4);
  const browY = eyeY + 8 + pick(4);
  return normalizeMiiFaceSpec({
    v: 1,
    skin: pick(PALETTE_RANGES.skin),
    hairColor: pick(PALETTE_RANGES.hairColor),
    eyeColor: pick(PALETTE_RANGES.eyeColor),
    lipColor: pick(PALETTE_RANGES.lipColor),
    glassesColor: pick(PALETTE_RANGES.glassesColor),
    head: pick(MII_STYLE_COUNT.head),
    hair: pick(MII_STYLE_COUNT.hair),
    eyes: pick(MII_STYLE_COUNT.eyes),
    brows: pick(MII_STYLE_COUNT.brows),
    nose: pick(MII_STYLE_COUNT.nose),
    mouth: pick(MII_STYLE_COUNT.mouth),
    glasses: random() < 0.72 ? 0 : 1 + pick(MII_STYLE_COUNT.glasses - 1),
    beard: random() < 0.68 ? 0 : 1 + pick(MII_STYLE_COUNT.beard - 1),
    browY,
    eyeY,
    noseY,
    mouthY,
    eyeSpacing: 14 + pick(10),
    eyeScale: 8 + pick(6),
    eyeTilt: -10 + pick(21),
    browTilt: -12 + pick(25),
    mouthWidth: 18 + pick(15),
    mouthCurve: -7 + pick(15),
  });
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}
