import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ItemAssets } from '../src/games/track/itemAssets';

const meshes = (group: THREE.Group) => group.children as THREE.Mesh[];

describe('item assets', () => {
  it('shares resources between instances and frees each exactly once', () => {
    const assets = new ItemAssets();
    const items = (['hurdle', 'hurdle', 'coin', 'coin'] as const).map((kind) => assets.create(kind));
    expect(meshes(items[0]!)[0]!.geometry).toBe(meshes(items[1]!)[0]!.geometry);
    expect(meshes(items[2]!)[0]!.material).toBe(meshes(items[3]!)[0]!.material);
    const resources = new Set(items.flatMap((item) => meshes(item).flatMap((mesh) => [mesh.geometry, mesh.material as THREE.Material])));
    let disposals = 0;
    for (const resource of resources) (resource as THREE.BufferGeometry).addEventListener('dispose', () => { disposals += 1; });
    assets.dispose();
    expect(disposals).toBe(resources.size);
  });
});
