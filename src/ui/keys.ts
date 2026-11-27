// Discrete presses: the track's pace toggle and the boxing punch. Holding must not fire extra ones.
const TOGGLE_KEYS = new Set(['arrowdown', 's', 'e']);

export function forwardKeyDown(key: string, repeat: boolean): boolean {
  return !repeat || !TOGGLE_KEYS.has(key.toLowerCase());
}
