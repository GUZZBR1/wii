import { useSyncExternalStore } from 'react';
import { loadSiteMii, type SiteMii, saveSiteMii } from './siteMii';

// The home-page creator and the app plaza read the same player Mii.
const listeners = new Set<() => void>();
let current: SiteMii | null = null;

export function getPlayerMii(): SiteMii {
  current ??= loadSiteMii();
  return current;
}

export function setPlayerMii(mii: SiteMii): void {
  current = saveSiteMii(mii);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // While nobody is reading it (in the arena), that editor can change the face; read it again on return.
    if (listeners.size === 0) current = null;
  };
}

export function usePlayerMii(): SiteMii {
  return useSyncExternalStore(subscribe, getPlayerMii);
}
