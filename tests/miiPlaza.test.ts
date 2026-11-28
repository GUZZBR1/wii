import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CPU_MIIS, DEFAULT_PLAYER_MII } from '../src/miis/miiCatalog';
import { createMiiModel } from '../src/miis/miiMesh';
import { BOTTOM_MARGIN, createWalkers, SIDE_MARGIN, stepWalker, TOP_MARGIN } from '../src/miis/miiSimulation';
import { MII_STYLE_COUNT } from '../src/mii/miiSpec';
import { siteMiiFromProfile } from '../src/miis/siteMii';

function seeded(seed = 1) {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

describe('passeio dos Miis', () => {
  const bounds = { width: 400, height: 1600 };

  it('mantém todos dentro da página e os espalha pela altura inteira', () => {
    const rng = seeded();
    const walkers = createWalkers(31, bounds, rng);
    for (let i = 0; i < 3600; i++) for (const walker of walkers) stepWalker(walker, 1 / 60, bounds, rng);
    for (const { x, y } of walkers) {
      expect(x).toBeGreaterThanOrEqual(SIDE_MARGIN);
      expect(x).toBeLessThanOrEqual(bounds.width - SIDE_MARGIN);
      expect(y).toBeGreaterThanOrEqual(TOP_MARGIN);
      expect(y).toBeLessThanOrEqual(bounds.height - BOTTOM_MARGIN);
    }
    const ys = walkers.map((walker) => walker.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(bounds.height / 2);
  });

  it('dá meia-volta na borda', () => {
    const walker = { x: bounds.width - SIDE_MARGIN, y: 500, heading: 0, timer: 10, walking: true };
    stepWalker(walker, 0.5, bounds);
    stepWalker(walker, 0.5, bounds);
    expect(walker.x).toBeLessThan(bounds.width - SIDE_MARGIN);
  });

  it('puxa para dentro quem ficou fora depois de a página encolher', () => {
    const walker = { x: 900, y: 3000, heading: 0, timer: 10, walking: false };
    stepWalker(walker, 0, bounds);
    expect(walker).toMatchObject({ x: bounds.width - SIDE_MARGIN, y: bounds.height - BOTTOM_MARGIN });
  });
});

describe('modelo 3D', () => {
  it('monta o elenco e cada formato com os pés no chão', () => {
    const base = siteMiiFromProfile(DEFAULT_PLAYER_MII);
    const variants = [
      ...CPU_MIIS.map(siteMiiFromProfile),
      ...Array.from({ length: MII_STYLE_COUNT.hair }, (_, hair) => ({ ...base, face: { ...base.face, hair } })),
      ...Array.from({ length: MII_STYLE_COUNT.head }, (_, head) => ({ ...base, face: { ...base.face, head } })),
    ];
    for (const mii of variants) {
      const box = new THREE.Box3().setFromObject(createMiiModel(mii).root);
      expect(box.min.y).toBeGreaterThan(-0.05);
      expect(box.max.y).toBeGreaterThan(1.5);
      expect(box.max.y).toBeLessThan(2.8);
    }
  });
});
