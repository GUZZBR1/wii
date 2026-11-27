import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createPunchingBag } from '../src/games/boxing/punchingBag';
import { disposeObjectTree } from '../src/games/core/GameLoop';

function meshesIn(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function expectTreeDisposable(root: THREE.Object3D): void {
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  for (const mesh of meshesIn(root)) {
    resources.add(mesh.geometry);
    resources.add(mesh.material as THREE.Material);
  }
  let disposals = 0;
  for (const resource of resources) {
    resource.addEventListener('dispose', () => {
      disposals += 1;
    });
  }
  disposeObjectTree(root);
  expect(disposals).toBe(resources.size);
}

describe('createPunchingBag', () => {
  it('creates a small vertex-colored procedural bag hierarchy', () => {
    const bag = createPunchingBag();
    const meshes = meshesIn(bag.root);

    expect(meshes.length).toBeGreaterThanOrEqual(5);
    expect(bag.root.getObjectByName('punching-bag-pivot')).toBeDefined();
    for (const mesh of meshes) {
      expect(mesh.geometry.getAttribute('color')).toBeDefined();
      expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    }
  });

  it('swings after a punch and recenters without reallocating', () => {
    const bag = createPunchingBag();
    const pivot = bag.root.getObjectByName('punching-bag-pivot')!;
    expect(pivot.rotation.x).toBe(0);

    bag.hit('right', 1);
    bag.update(1 / 60);
    const swung = pivot.rotation.x;
    expect(swung).toBeGreaterThan(0);

    bag.reset();
    expect(pivot.rotation.x).toBe(0);
    expect(pivot.rotation.z).toBe(0);
  });

  it('uses resources that disposeObjectTree can release exactly once', () => {
    expectTreeDisposable(createPunchingBag().root);
  });
});
