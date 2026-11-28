import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MII_FACE_SPEC,
  deserializeMiiFaceSpec,
  generateMiiFromSeed,
  normalizeMiiFaceSpec,
  serializeMiiFaceSpec,
} from '../src/mii/miiSpec';

/** Fresh module instance per test so the module-level session fallback never leaks between tests. */
async function importFreshSpec() {
  vi.resetModules();
  return import('../src/mii/miiSpec');
}

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

/** Installs a localStorage global (or removes it with `undefined`) and returns a restore function. */
function installLocalStorage(storage: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

describe('miiSpec', () => {
  it('generates the same valid face for the same seed and different faces for different seeds', () => {
    const first = generateMiiFromSeed('rival-1');
    expect(generateMiiFromSeed('rival-1')).toEqual(first);
    expect(generateMiiFromSeed(123)).toEqual(generateMiiFromSeed('123'));
    expect(generateMiiFromSeed('rival-2')).not.toEqual(first);
  });

  it('keeps the vertical feature bands separated for a deterministic seed sample', () => {
    for (let index = 0; index < 100; index += 1) {
      const spec = generateMiiFromSeed(`npc-${index}`);
      expect(spec.browY).toBeGreaterThan(spec.eyeY);
      expect(spec.eyeY).toBeGreaterThan(spec.noseY);
      expect(spec.noseY).toBeGreaterThan(spec.mouthY);
    }
  });

  it('serializes compactly and round-trips exactly', () => {
    for (const spec of [DEFAULT_MII_FACE_SPEC, generateMiiFromSeed('compact'), generateMiiFromSeed(987654)]) {
      const encoded = serializeMiiFaceSpec(spec);
      expect(encoded.length).toBeLessThan(100);
      expect(deserializeMiiFaceSpec(encoded)).toEqual(spec);
    }
  });

  it('rejects corrupted or invalid stored tuples', () => {
    expect(deserializeMiiFaceSpec('not json')).toBeUndefined();
    expect(deserializeMiiFaceSpec('null')).toBeUndefined();
    expect(deserializeMiiFaceSpec('[2,1,1]')).toBeUndefined();
    const valid = serializeMiiFaceSpec(DEFAULT_MII_FACE_SPEC);
    expect(deserializeMiiFaceSpec(valid)).toEqual(DEFAULT_MII_FACE_SPEC);
    const tuple = JSON.parse(valid) as number[];
    tuple[15] = tuple[16]; // eyeY is no longer below browY in the upward-positive bands
    expect(deserializeMiiFaceSpec(JSON.stringify(tuple))).toBeUndefined();
  });

  it('normalizes edits back into separated bands', () => {
    const spec = normalizeMiiFaceSpec({ ...DEFAULT_MII_FACE_SPEC, mouthY: 34, noseY: 30, eyeY: 42, browY: 54 });
    expect(spec.browY).toBeGreaterThan(spec.eyeY);
    expect(spec.eyeY).toBeGreaterThan(spec.noseY);
    expect(spec.noseY).toBeGreaterThan(spec.mouthY);
  });

  it('normalizes NaN edits into serializable valid integers', () => {
    const spec = normalizeMiiFaceSpec({ ...DEFAULT_MII_FACE_SPEC, skin: Number.NaN, mouthY: Number.NaN });
    expect(Number.isInteger(spec.skin)).toBe(true);
    expect(Number.isInteger(spec.mouthY)).toBe(true);
    expect(deserializeMiiFaceSpec(serializeMiiFaceSpec(spec))).toEqual(spec);
  });
});

describe('player Mii storage', () => {
  it('returns true and persists the face when storage works', async () => {
    const spec = await importFreshSpec();
    const storage = createMemoryStorage();
    const restore = installLocalStorage(storage);
    try {
      const face = spec.generateMiiFromSeed('persisted');
      expect(spec.savePlayerMii(face)).toBe(true);
      expect(storage.getItem(spec.PLAYER_MII_STORAGE_KEY)).toBe(spec.serializeMiiFaceSpec(face));
      expect(spec.loadPlayerMii()).toEqual(face);
    } finally {
      restore();
    }
  });

  it('returns independent copies rather than shared mutable objects', async () => {
    const spec = await importFreshSpec();
    const restore = installLocalStorage(createMemoryStorage());
    try {
      const face = spec.generateMiiFromSeed('copies');
      expect(spec.savePlayerMii(face)).toBe(true);
      const first = spec.loadPlayerMii();
      const second = spec.loadPlayerMii();
      expect(first).not.toBe(second);
      first.mouthY = 18;
      first.mouth = (first.mouth + 1) % 12;
      expect(spec.loadPlayerMii()).toEqual(face);
    } finally {
      restore();
    }
  });

  it('returns false when localStorage is unavailable but keeps the face for the session', async () => {
    const spec = await importFreshSpec();
    const restore = installLocalStorage(undefined);
    try {
      const face = spec.generateMiiFromSeed('session-only');
      expect(spec.savePlayerMii(face)).toBe(false);
      expect(spec.loadPlayerMii()).toEqual(face);
    } finally {
      restore();
    }
  });

  it('returns false when storage throws and still serves the session copy', async () => {
    const spec = await importFreshSpec();
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const restore = installLocalStorage(throwing);
    try {
      const face = spec.generateMiiFromSeed('throwing-storage');
      expect(spec.savePlayerMii(face)).toBe(false);
      expect(spec.loadPlayerMii()).toEqual(face);
    } finally {
      restore();
    }
  });

  it('does not let stale readable storage shadow a newer session-only save', async () => {
    const spec = await importFreshSpec();
    const storedFace = spec.generateMiiFromSeed('old-persisted-face');
    const sessionFace = spec.generateMiiFromSeed('new-session-face');
    const readableButUnwritable = {
      getItem: () => spec.serializeMiiFaceSpec(storedFace),
      setItem: () => {
        throw new Error('quota');
      },
    };
    const restore = installLocalStorage(readableButUnwritable);
    try {
      expect(spec.savePlayerMii(sessionFace)).toBe(false);
      expect(spec.loadPlayerMii()).toEqual(sessionFace);
      expect(spec.loadPlayerMii()).not.toEqual(storedFace);
    } finally {
      restore();
    }
  });

  it('lets a valid external storage write win after a failed save', async () => {
    const spec = await importFreshSpec();
    const storedFace = spec.generateMiiFromSeed('preexisting-persisted-face');
    const sessionFace = spec.generateMiiFromSeed('unpersisted-session-face');
    const externalFace = spec.generateMiiFromSeed('external-post-failure-face');
    const backing = createMemoryStorage();
    backing.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(storedFace));
    let acceptsWrites = false;
    const intermittentlyWritable = {
      getItem: backing.getItem,
      setItem: (key: string, value: string) => {
        if (!acceptsWrites) throw new Error('quota');
        backing.setItem(key, value);
      },
    };
    const restore = installLocalStorage(intermittentlyWritable);
    try {
      expect(spec.savePlayerMii(sessionFace)).toBe(false);
      expect(spec.loadPlayerMii()).toEqual(sessionFace);
      acceptsWrites = true;
      intermittentlyWritable.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(externalFace));
      expect(spec.loadPlayerMii()).toEqual(externalFace);
    } finally {
      restore();
    }
  });

  it('detects an external write when storage becomes available after a session-only save', async () => {
    const spec = await importFreshSpec();
    const sessionFace = spec.generateMiiFromSeed('save-while-storage-unavailable');
    const externalFace = spec.generateMiiFromSeed('write-after-storage-returns');
    const restoreMissing = installLocalStorage(undefined);
    try {
      expect(spec.savePlayerMii(sessionFace)).toBe(false);
    } finally {
      restoreMissing();
    }
    const storage = createMemoryStorage();
    const restoreStorage = installLocalStorage(storage);
    try {
      expect(spec.loadPlayerMii()).toEqual(sessionFace);
      storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(externalFace));
      expect(spec.loadPlayerMii()).toEqual(externalFace);
    } finally {
      restoreStorage();
    }
  });

  it('treats the first readable payload as baseline when storage was unreadable during a failed save', async () => {
    const spec = await importFreshSpec();
    const sessionFace = spec.generateMiiFromSeed('save-while-storage-throws');
    const storedFace = spec.generateMiiFromSeed('first-readable-stored-face');
    const externalFace = spec.generateMiiFromSeed('later-external-stored-face');
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const restoreThrowing = installLocalStorage(throwing);
    try {
      expect(spec.savePlayerMii(sessionFace)).toBe(false);
    } finally {
      restoreThrowing();
    }
    const storage = createMemoryStorage();
    storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(storedFace));
    const restoreStorage = installLocalStorage(storage);
    try {
      expect(spec.loadPlayerMii()).toEqual(sessionFace);
      storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(externalFace));
      expect(spec.loadPlayerMii()).toEqual(externalFace);
    } finally {
      restoreStorage();
    }
  });

  it('does not treat storage that returns already populated as a proven external write', async () => {
    const spec = await importFreshSpec();
    const sessionFace = spec.generateMiiFromSeed('save-without-storage-api');
    const storedFace = spec.generateMiiFromSeed('storage-returning-populated');
    const restoreMissing = installLocalStorage(undefined);
    try {
      expect(spec.savePlayerMii(sessionFace)).toBe(false);
    } finally {
      restoreMissing();
    }
    const storage = createMemoryStorage();
    storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(storedFace));
    const restoreStorage = installLocalStorage(storage);
    try {
      expect(spec.loadPlayerMii()).toEqual(sessionFace);
    } finally {
      restoreStorage();
    }
  });

  it('conservatively keeps the session face when an early external write cannot be ordered', async () => {
    const spec = await importFreshSpec();
    const sessionFace = spec.generateMiiFromSeed('save-while-read-write-denied');
    const earlyExternalFace = spec.generateMiiFromSeed('external-write-during-outage');
    const laterExternalFace = spec.generateMiiFromSeed('external-write-after-baseline');
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const restoreThrowing = installLocalStorage(throwing);
    try {
      expect(spec.savePlayerMii(sessionFace)).toBe(false);
    } finally {
      restoreThrowing();
    }
    const storage = createMemoryStorage();
    storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(earlyExternalFace));
    const restoreStorage = installLocalStorage(storage);
    try {
      expect(spec.loadPlayerMii()).toEqual(sessionFace);
      storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(laterExternalFace));
      expect(spec.loadPlayerMii()).toEqual(laterExternalFace);
    } finally {
      restoreStorage();
    }
  });

  it('returns valid localStorage data again after a later save succeeds', async () => {
    const spec = await importFreshSpec();
    const firstFace = spec.generateMiiFromSeed('first-failed-save');
    const secondFace = spec.generateMiiFromSeed('second-successful-save');
    const restoreFirst = installLocalStorage(undefined);
    try {
      expect(spec.savePlayerMii(firstFace)).toBe(false);
    } finally {
      restoreFirst();
    }
    const storage = createMemoryStorage();
    const restoreSecond = installLocalStorage(storage);
    try {
      expect(spec.savePlayerMii(secondFace)).toBe(true);
      storage.setItem(
        spec.PLAYER_MII_STORAGE_KEY,
        spec.serializeMiiFaceSpec(spec.generateMiiFromSeed('external-update')),
      );
      expect(spec.loadPlayerMii()).toEqual(spec.generateMiiFromSeed('external-update'));
    } finally {
      restoreSecond();
    }
  });

  it('prefers valid localStorage data over the session fallback', async () => {
    const spec = await importFreshSpec();
    const storage = createMemoryStorage();
    const restore = installLocalStorage(storage);
    try {
      const sessionFace = spec.generateMiiFromSeed('session-face');
      expect(spec.savePlayerMii(sessionFace)).toBe(true);
      const storedFace = { ...sessionFace, mouth: (sessionFace.mouth + 1) % 12 };
      storage.setItem(spec.PLAYER_MII_STORAGE_KEY, spec.serializeMiiFaceSpec(storedFace));
      expect(spec.loadPlayerMii()).toEqual(storedFace);
      expect(spec.loadPlayerMii()).not.toEqual(sessionFace);
    } finally {
      restore();
    }
  });

  it('falls back to the session copy when stored data is corrupted', async () => {
    const spec = await importFreshSpec();
    const storage = createMemoryStorage();
    const restore = installLocalStorage(storage);
    try {
      const face = spec.generateMiiFromSeed('corrupted-storage');
      expect(spec.savePlayerMii(face)).toBe(true);
      storage.setItem(spec.PLAYER_MII_STORAGE_KEY, 'corrupted-not-json');
      expect(spec.loadPlayerMii()).toEqual(face);
    } finally {
      restore();
    }
  });

  it('returns the default face when nothing was ever saved', async () => {
    const spec = await importFreshSpec();
    const restore = installLocalStorage(createMemoryStorage());
    try {
      const loaded = spec.loadPlayerMii();
      expect(loaded).toEqual(spec.DEFAULT_MII_FACE_SPEC);
      expect(loaded).not.toBe(spec.DEFAULT_MII_FACE_SPEC);
    } finally {
      restore();
    }
  });
});
