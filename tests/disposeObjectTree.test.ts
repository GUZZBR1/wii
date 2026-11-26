import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { disposeObjectTree } from '../src/games/core/GameLoop';

describe('disposeObjectTree', () => {
  it('disposes instanced meshes, batched meshes, and shader uniform textures once', () => {
    const root = new THREE.Group();
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
    const batched = new THREE.BatchedMesh(1, 8, 12, new THREE.MeshBasicMaterial());
    const texture = new THREE.Texture();
    const material = new THREE.ShaderMaterial({ uniforms: { map: { value: texture } } });
    root.add(instanced, batched, new THREE.Mesh(new THREE.BoxGeometry(), material));
    let instancedDisposals = 0;
    let batchedDisposals = 0;
    let textureDisposals = 0;
    instanced.addEventListener('dispose', () => { instancedDisposals += 1; });
    batched.addEventListener('dispose', () => { batchedDisposals += 1; });
    texture.addEventListener('dispose', () => { textureDisposals += 1; });
    disposeObjectTree(root);
    expect(instancedDisposals).toBe(1);
    expect(batchedDisposals).toBe(1);
    expect(textureDisposals).toBe(1);
  });
});
