import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createImpactSparkPool } from '../src/games/boxing/impactEffects';
import { disposeObjectTree } from '../src/games/core/GameLoop';

describe('createImpactSparkPool', () => {
  it('uses one preallocated points object with position and color attributes', () => {
    const pool = createImpactSparkPool(8);

    expect(pool.root).toBeInstanceOf(THREE.Points);
    expect(pool.root.geometry.getAttribute('position').count).toBe(8);
    expect(pool.root.geometry.getAttribute('color').count).toBe(8);
    expect(pool.activeCount).toBe(0);
  });

  it('reuses its fixed capacity across bursts', () => {
    const pool = createImpactSparkPool(6);

    pool.spawn(0, 1, 0, 0.5);
    expect(pool.activeCount).toBe(6);
    pool.spawn(0, 1, 0, 1);
    expect(pool.activeCount).toBeLessThanOrEqual(6);
  });

  it('integrates sparks in place and parks them below the arena when expired', () => {
    const pool = createImpactSparkPool(8);
    pool.spawn(0, 1, 0, 1);
    const positions = pool.root.geometry.getAttribute('position') as THREE.BufferAttribute;
    const before = Array.from(positions.array as Float32Array);

    pool.update(1 / 60);
    const afterFirst = Array.from(positions.array as Float32Array);
    expect(afterFirst).not.toEqual(before);

    for (let index = 0; index < 24; index += 1) pool.update(1 / 60);
    expect(pool.activeCount).toBe(0);
    for (let index = 0; index < positions.count; index += 1) {
      expect(positions.getY(index)).toBeLessThan(-100);
    }
  });

  it('draws sparks as round dots, not as square points', () => {
    const material = createImpactSparkPool().root.material as THREE.PointsMaterial;
    const { data, width, height } = (material.map as THREE.DataTexture).image;
    const alphaAt = (x: number, y: number) => data![(y * width + x) * 4 + 3];
    expect(alphaAt(width / 2, height / 2)).toBe(255);
    expect(alphaAt(0, 0)).toBe(0);
  });

  it('releases its single geometry and material through disposeObjectTree', () => {
    const pool = createImpactSparkPool(4);
    let disposals = 0;
    pool.root.geometry.addEventListener('dispose', () => {
      disposals += 1;
    });
    (pool.root.material as THREE.Material).addEventListener('dispose', () => {
      disposals += 1;
    });

    disposeObjectTree(pool.root);

    expect(disposals).toBe(2);
  });
});
