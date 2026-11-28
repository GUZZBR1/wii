import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPlayerMii, MII_STYLE_COUNT, normalizeMiiFaceSpec, savePlayerMii } from '../src/mii/miiSpec';
import { FACE_SLIDERS, FACE_STYLES } from '../src/miis/faceLabels';
import { CPU_MIIS } from '../src/miis/miiCatalog';
import { loadSiteMii, saveSiteMii, siteMiiFromProfile } from '../src/miis/siteMii';

function stubStorage() {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
}

describe('Mii shared between the site and games', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the face saved by the site is the one loaded by the games, and vice versa', () => {
    stubStorage();
    const mii = { ...siteMiiFromProfile(CPU_MIIS[3]), name: 'Ana' };
    saveSiteMii(mii);
    expect(loadPlayerMii()).toEqual(mii.face);
    savePlayerMii({ ...mii.face, hair: 11 });
    expect(loadSiteMii()).toMatchObject({ name: 'Ana', shirtColor: mii.shirtColor, face: { hair: 11 } });
  });

  it('converts the entire cast into valid faces', () => {
    for (const profile of CPU_MIIS) {
      const { face } = siteMiiFromProfile(profile);
      expect(normalizeMiiFaceSpec(face)).toEqual(face);
    }
  });

  it('has a name for every style and uses only existing controls', () => {
    for (const [key, , names] of FACE_STYLES) expect(names).toHaveLength(MII_STYLE_COUNT[key]);
    const face = siteMiiFromProfile(CPU_MIIS[0]).face;
    for (const [key, , min, max] of FACE_SLIDERS) {
      expect(normalizeMiiFaceSpec({ ...face, [key]: min })[key]).toBeGreaterThanOrEqual(min);
      expect(normalizeMiiFaceSpec({ ...face, [key]: max })[key]).toBeLessThanOrEqual(max);
    }
  });
});
