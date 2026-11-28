/**
 * Everything the browser persists locally: language, theme, mute, quality, records and the player's
 * Mii. Storage is optional — private mode, blocked cookies and sandboxed frames all throw — so every
 * access is guarded here once instead of at each call site. A read that fails is "nothing saved";
 * a write that fails means the value lives for this visit only.
 */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns whether the value was actually persisted. */
export function writeStored(key: string, value: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
