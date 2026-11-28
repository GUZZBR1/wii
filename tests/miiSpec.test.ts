import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MII_FACE_SPEC,
  deserializeMiiFaceSpec,
  generateMiiFromSeed,
  normalizeMiiFaceSpec,
  serializeMiiFaceSpec,
} from '../src/mii/miiSpec';

describe('miiSpec', () => {
  it('generates the same valid face for the same seed and different faces for different seeds', () => {
    const first = generateMiiFromSeed('rival-1');
    expect(generateMiiFromSeed('rival-1')).toEqual(first);
    expect(generateMiiFromSeed(123)).toEqual(generateMiiFromSeed('123'));
    expect(generateMiiFromSeed('rival-2')).not.toEqual(first);
  });

  it('keeps the vertical feature bands separated for a deterministic seed sample', () => {
    for (let index = 0; index < 100; index += 1) {
      const spec = generateMiiFromSeed(`npc-${index}`);
      expect(spec.browY).toBeGreaterThan(spec.eyeY);
      expect(spec.eyeY).toBeGreaterThan(spec.noseY);
      expect(spec.noseY).toBeGreaterThan(spec.mouthY);
    }
  });

  it('serializes compactly and round-trips exactly', () => {
    for (const spec of [DEFAULT_MII_FACE_SPEC, generateMiiFromSeed('compact'), generateMiiFromSeed(987654)]) {
      const encoded = serializeMiiFaceSpec(spec);
      expect(encoded.length).toBeLessThan(100);
      expect(deserializeMiiFaceSpec(encoded)).toEqual(spec);
    }
  });

  it('rejects corrupted or invalid stored tuples', () => {
    expect(deserializeMiiFaceSpec('not json')).toBeUndefined();
    expect(deserializeMiiFaceSpec('null')).toBeUndefined();
    expect(deserializeMiiFaceSpec('[2,1,1]')).toBeUndefined();
    const valid = serializeMiiFaceSpec(DEFAULT_MII_FACE_SPEC);
    expect(deserializeMiiFaceSpec(valid)).toEqual(DEFAULT_MII_FACE_SPEC);
    const tuple = JSON.parse(valid) as number[];
    tuple[15] = tuple[16]; // eyeY is no longer below browY in the upward-positive bands
    expect(deserializeMiiFaceSpec(JSON.stringify(tuple))).toBeUndefined();
  });

  it('normalizes edits back into separated bands', () => {
    const spec = normalizeMiiFaceSpec({ ...DEFAULT_MII_FACE_SPEC, mouthY: 34, noseY: 30, eyeY: 42, browY: 54 });
    expect(spec.browY).toBeGreaterThan(spec.eyeY);
    expect(spec.eyeY).toBeGreaterThan(spec.noseY);
    expect(spec.noseY).toBeGreaterThan(spec.mouthY);
  });
});
