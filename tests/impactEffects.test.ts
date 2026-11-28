import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createImpactRing, createImpactSparkPool, createPunchTrail } from '../src/games/boxing/impactEffects';
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

describe('createImpactRing', () => {
  it('pools multiple concurrent rings for rapid combos and fades them out', () => {
    const ring = createImpactRing();
    const camera = new THREE.PerspectiveCamera();

    ring.burst({ x: 0, y: 1, z: 0 }, 0.8, 'hit');
    ring.burst({ x: 0.2, y: 1.1, z: 0 }, 0.9, 'block');
    ring.update(0.05, camera);

    const visibleRings = ring.root.children.filter((child) => child.visible && child.name.startsWith('impact-ring-'));
    expect(visibleRings.length).toBe(2);

    ring.update(0.3, camera);
    expect(ring.root.children.some((child) => child.visible)).toBe(false);
    disposeObjectTree(ring.root);
  });
});

describe('createPunchTrail', () => {
  it('lays shrinking dots from the glove toward the shoulder and hides them on clear', () => {
    const trail = createPunchTrail();
    const dots = trail.root.children as THREE.Mesh[];
    expect(dots).toHaveLength(5);
    expect(new Set(dots.map((dot) => dot.geometry)).size).toBe(1);
    expect(dots.some((dot) => dot.visible)).toBe(false);

    trail.show(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 'counter');
    expect(dots.every((dot) => dot.visible)).toBe(true);
    expect(dots[0]!.position.z).toBeCloseTo(-1, 5);
    expect(dots[4]!.position.z).toBeGreaterThan(dots[0]!.position.z);
    expect(dots[4]!.scale.x).toBeLessThan(dots[0]!.scale.x);
    expect((dots[0]!.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x66f2ff);

    trail.clear();
    expect(dots.some((dot) => dot.visible)).toBe(false);
    disposeObjectTree(trail.root);
  });
});
