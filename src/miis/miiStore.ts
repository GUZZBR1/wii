import { useSyncExternalStore } from 'react';
import { loadSiteMii, type SiteMii, saveSiteMii } from './siteMii';

// O criador (na home) e a praça (no App) leem o mesmo Mii do jogador.
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
    // Sem ninguém lendo (arena), o editor de lá pode mudar o rosto: relê na volta.
    if (listeners.size === 0) current = null;
  };
}

export function usePlayerMii(): SiteMii {
  return useSyncExternalStore(subscribe, getPlayerMii);
}
