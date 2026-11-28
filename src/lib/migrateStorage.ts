/**
 * The project was renamed, and with it every browser storage key. Moves what a visitor had saved
 * (Mii, records, language, theme, quality, mute) to the new names. A value already saved under the
 * new name wins; the old one is removed only once its content is safe.
 */
export function migrateRenamedStorage(storage: Storage): void {
  for (const key of Object.keys(storage)) {
    if (!key.startsWith('wii-')) continue;
    const renamed = `nevergear-${key.slice('wii-'.length)}`;
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
    storage.removeItem(key);
  }
}

// Runs on import, ahead of any module that reads storage while loading.
try {
  migrateRenamedStorage(localStorage);
} catch { /* no storage, or no room: the app starts with defaults */ }
