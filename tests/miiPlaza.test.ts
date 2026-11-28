import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CPU_MIIS, DEFAULT_PLAYER_MII } from '../src/miis/miiCatalog';
import { createMiiModel } from '../src/miis/miiMesh';
import {
  BOTTOM_MARGIN,
  createWalkers,
  depthScale,
  enterFromEdge,
  GRUMP_SECONDS,
  grumpPose,
  SIDE_MARGIN,
  stepWalker,
  TOP_MARGIN,
} from '../src/miis/miiSimulation';
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
    const walker = {
      x: bounds.width - SIDE_MARGIN,
      y: 500,
      heading: 0,
      timer: 10,
      walking: true,
      delay: 0,
      entering: 0,
    };
    stepWalker(walker, 0.5, bounds);
    stepWalker(walker, 0.5, bounds);
    expect(walker.x).toBeLessThan(bounds.width - SIDE_MARGIN);
  });

  it('puxa para dentro quem ficou fora depois de a página encolher', () => {
    const walker = { x: 900, y: 3000, heading: 0, timer: 10, walking: false, delay: 0, entering: 0 };
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

describe('profundidade dos Miis', () => {
  it('encolhe quem está longe e limita o tamanho fora da janela', () => {
    expect(depthScale(0, 800)).toBeLessThan(depthScale(800, 800));
    expect(depthScale(-50, 800)).toBe(depthScale(0, 800));
    expect(depthScale(900, 800)).toBe(depthScale(800, 800));
  });
});

describe('chegada dos Miis', () => {
  it('nasce fora da janela em portas diferentes, espera a vez e entra andando', () => {
    const bounds = { width: 800, height: 2000 };
    const rng = seeded(7);
    const walkers = createWalkers(6, bounds, rng);
    walkers.forEach((walker, index) => {
      enterFromEdge(walker, index, bounds, 500, 600, rng);
    });
    for (const { x, y } of walkers) expect(x < 0 || x > bounds.width || y > 500 + 600).toBe(true);
    expect(walkers.some(({ x }) => x < 0)).toBe(true);
    expect(walkers.some(({ x }) => x > bounds.width)).toBe(true);
    expect(walkers.some(({ y }) => y > 1100)).toBe(true);
    expect(walkers[5].delay).toBeGreaterThan(walkers[0].delay);
    const startX = walkers[5].x;
    stepWalker(walkers[5], 0.05, bounds, rng);
    expect(walkers[5].x).toBe(startX);
    for (let i = 0; i < 900; i++) for (const walker of walkers) stepWalker(walker, 1 / 60, bounds, rng);
    for (const { x, entering } of walkers) {
      expect(entering).toBeLessThanOrEqual(0);
      expect(x).toBeGreaterThanOrEqual(SIDE_MARGIN);
      expect(x).toBeLessThanOrEqual(bounds.width - SIDE_MARGIN);
    }
  });
});

describe('Mii incomodado', () => {
  it('pula e treme no começo e volta ao normal', () => {
    expect(grumpPose(0.13).hop).toBeGreaterThan(5);
    expect(grumpPose(GRUMP_SECONDS)).toEqual({ hop: 0, tilt: expect.closeTo(0), yaw: expect.closeTo(0) });
  });
});
