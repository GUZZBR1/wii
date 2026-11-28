import type * as THREE from 'three';
import { createMiiFaceTexture } from './faceRenderer';
import { serializeMiiFaceSpec, type MiiFaceSpec } from './miiSpec';

export interface FaceTextureUploader {
  initTexture(texture: THREE.Texture): void;
}

export interface FaceCacheEntrySnapshot {
  key: string;
  refCount: number;
  hasTexture: boolean;
  lastUsedMs: number;
}

interface FaceCacheEntry {
  key: string;
  spec: MiiFaceSpec;
  size: number;
  texture?: THREE.CanvasTexture;
  refCount: number;
  lastUsedMs: number;
}

/** A live reference to one cache entry. Release is idempotent; texture lookup dies with eviction. */
export class FaceLease {
  private released = false;

  constructor(
    private readonly entry: FaceCacheEntry,
    private readonly onRelease: (entry: FaceCacheEntry, nowMs: number) => void,
  ) {}

  get key(): string {
    return this.entry.key;
  }
  get spec(): MiiFaceSpec {
    return this.entry.spec;
  }
  get size(): number {
    return this.entry.size;
  }
  get texture(): THREE.CanvasTexture | undefined {
    return this.released ? undefined : this.entry.texture;
  }

  release(nowMs = 0): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this.entry, nowMs);
  }
}

export interface FaceCacheOptions {
  /** Live and cold entries together; cold entries are evicted least-recently-used first. */
  capacity?: number;
  textureFactory?: (spec: MiiFaceSpec, size: number) => THREE.CanvasTexture;
}

/**
 * Reference-counted LRU for face textures. Zero-reference textures stay available for re-entry,
 * but only until capacity pressure evicts them; eviction and disposal are the sole texture owners.
 */
export class FaceCache {
  private readonly capacity: number;
  private readonly textureFactory: (spec: MiiFaceSpec, size: number) => THREE.CanvasTexture;
  private readonly entries = new Map<string, FaceCacheEntry>();

  constructor(options: FaceCacheOptions = {}) {
    this.capacity = options.capacity ?? 16;
    this.textureFactory = options.textureFactory ?? createMiiFaceTexture;
  }

  acquire(spec: MiiFaceSpec, size = 128, nowMs = 0): FaceLease {
    const key = `${serializeMiiFaceSpec(spec)}@${size}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, spec, size, refCount: 0, lastUsedMs: nowMs };
      this.entries.set(key, entry);
    }
    entry.refCount += 1;
    entry.lastUsedMs = nowMs;
    this.evictCold();
    return new FaceLease(entry, (released, releaseAtMs) => this.releaseEntry(released, releaseAtMs));
  }

  /** Builds exactly one missing texture and warms it in the renderer before it is first sampled. */
  build(lease: FaceLease, renderer: FaceTextureUploader | undefined, nowMs = 0): boolean {
    const entry = this.entries.get(lease.key);
    if (!entry || entry.refCount <= 0 || entry.texture || !renderer) return false;
    entry.texture = this.textureFactory(entry.spec, entry.size);
    renderer.initTexture(entry.texture);
    entry.lastUsedMs = nowMs;
    return true;
  }

  touch(lease: FaceLease, nowMs: number): void {
    const entry = this.entries.get(lease.key);
    if (entry && entry.refCount > 0) entry.lastUsedMs = nowMs;
  }

  private releaseEntry(entry: FaceCacheEntry, nowMs: number): void {
    if (!this.entries.has(entry.key)) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedMs = nowMs;
    this.evictCold();
  }

  private evictCold(): void {
    while (this.entries.size > this.capacity) {
      let oldest: FaceCacheEntry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.refCount !== 0) continue;
        if (!oldest || entry.lastUsedMs < oldest.lastUsedMs) oldest = entry;
      }
      if (!oldest) return;
      this.entries.delete(oldest.key);
      oldest.texture?.dispose();
      oldest.texture = undefined;
    }
  }

  /** Test/debug snapshot; callers in the frame loop use the allocation-free acquire/touch path. */
  snapshot(): FaceCacheEntrySnapshot[] {
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      refCount: entry.refCount,
      hasTexture: entry.texture !== undefined,
      lastUsedMs: entry.lastUsedMs,
    }));
  }

  get size(): number {
    return this.entries.size;
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      entry.texture?.dispose();
      entry.texture = undefined;
      entry.refCount = 0;
    }
    this.entries.clear();
  }
}
