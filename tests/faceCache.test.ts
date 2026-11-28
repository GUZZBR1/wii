import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FaceCache, type FaceTextureUploader } from '../src/mii/faceCache';
import { DEFAULT_MII_FACE_SPEC, type MiiFaceSpec } from '../src/mii/miiSpec';

function specWith(patch: Partial<MiiFaceSpec>): MiiFaceSpec {
  return { ...DEFAULT_MII_FACE_SPEC, ...patch };
}

function fakeTexture(disposals?: { count: number }): THREE.CanvasTexture {
  const texture = new THREE.Texture() as THREE.CanvasTexture;
  if (disposals)
    texture.addEventListener('dispose', () => {
      disposals.count += 1;
    });
  return texture;
}

function setup(capacity: number, textures: (spec: MiiFaceSpec, size: number) => THREE.CanvasTexture) {
  const renderer: FaceTextureUploader = { initTexture: vi.fn() };
  const cache = new FaceCache({ capacity, textureFactory: (spec, size) => textures(spec, size) });
  return { cache, renderer };
}

describe('FaceCache', () => {
  it('shares one texture between references to the same face and builds it once', () => {
    const created = vi.fn(() => fakeTexture());
    const { cache, renderer } = setup(4, created);
    const first = cache.acquire(DEFAULT_MII_FACE_SPEC, 128, 1);
    const second = cache.acquire(DEFAULT_MII_FACE_SPEC, 128, 2);
    expect(first.key).toBe(second.key);
    expect(cache.build(first, renderer, 3)).toBe(true);
    expect(cache.build(second, renderer, 4)).toBe(false);
    expect(created).toHaveBeenCalledTimes(1);
    expect(renderer.initTexture).toHaveBeenCalledTimes(1);
    expect(second.texture).toBe(first.texture);
    expect(cache.snapshot()[0]).toMatchObject({ refCount: 2, hasTexture: true });
  });

  it('evicts and disposes an over-capacity entry when release makes it cold', () => {
    const disposals = { a: { count: 0 }, b: { count: 0 } };
    const created = vi
      .fn()
      .mockImplementationOnce(() => fakeTexture(disposals.a))
      .mockImplementationOnce(() => fakeTexture(disposals.b));
    const { cache, renderer } = setup(1, created);
    const a = cache.acquire(specWith({ eyes: 1 }), 128, 1);
    cache.build(a, renderer, 1);
    const b = cache.acquire(specWith({ eyes: 2 }), 128, 2);
    cache.build(b, renderer, 2);
    expect(cache.size).toBe(2); // both are still referenced, so neither can be evicted

    a.release(3);
    expect(disposals.a.count).toBe(1);
    expect(disposals.b.count).toBe(0);
    expect(cache.size).toBe(1);
    expect(cache.snapshot()[0]!.key).toBe(b.key);
    b.release(4);
  });

  it('evicts the least recently used cold entry before newer cold entries', () => {
    const disposalCounts = [{ count: 0 }, { count: 0 }, { count: 0 }];
    const created = vi
      .fn()
      .mockImplementationOnce(() => fakeTexture(disposalCounts[0]))
      .mockImplementationOnce(() => fakeTexture(disposalCounts[1]))
      .mockImplementationOnce(() => fakeTexture(disposalCounts[2]));
    const { cache, renderer } = setup(2, created);
    const a = cache.acquire(specWith({ nose: 1 }), 128, 1);
    cache.build(a, renderer, 1);
    a.release(2);
    const b = cache.acquire(specWith({ nose: 2 }), 128, 3);
    cache.build(b, renderer, 3);
    b.release(4);
    const c = cache.acquire(specWith({ nose: 3 }), 128, 5);
    cache.build(c, renderer, 5);

    expect(disposalCounts[0]!.count).toBe(1);
    expect(disposalCounts[1]!.count).toBe(0);
    expect(cache.snapshot().map((entry) => entry.key)).toEqual([b.key, c.key]);
    c.release(6);
  });

  it('disposeAll releases every retained texture exactly once', () => {
    const disposals = [{ count: 0 }, { count: 0 }];
    const created = vi
      .fn()
      .mockImplementationOnce(() => fakeTexture(disposals[0]))
      .mockImplementationOnce(() => fakeTexture(disposals[1]));
    const { cache, renderer } = setup(4, created);
    const a = cache.acquire(specWith({ mouth: 1 }), 128, 1);
    const b = cache.acquire(specWith({ mouth: 2 }), 128, 2);
    cache.build(a, renderer, 1);
    cache.build(b, renderer, 2);
    cache.disposeAll();
    expect(disposals[0]!.count).toBe(1);
    expect(disposals[1]!.count).toBe(1);
    expect(cache.size).toBe(0);
    a.release(3);
    b.release(3);
  });
});
