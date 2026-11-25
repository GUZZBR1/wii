import { describe, expect, it } from 'vitest';
import { BimanualSeparationTracker, MagneticSnapFilter, bimanualSeparationRatio } from '@wii/spatial-core';
import { syntheticHand } from './fixtures/syntheticHand';

function pair(scale = 1, separationPx = 0.4) {
  const scaledSeparation = separationPx * scale;
  const left = syntheticHand({ handedness: 'left', scale, screenX: 0.5 - scaledSeparation / 2 });
  const right = syntheticHand({ handedness: 'right', scale, screenX: 0.5 + scaledSeparation / 2 });
  return [left, right] as const;
}

describe('bimanual separation', () => {
  it('normalizes wrist separation by palm size and corrects non-square image dimensions', () => {
    const base = bimanualSeparationRatio(pair(1, 0.4), { width: 640, height: 480 });
    const scaled = bimanualSeparationRatio(pair(2, 0.4), { width: 1280, height: 960 });
    expect(scaled).toBeCloseTo(base!, 9);
    expect(
      bimanualSeparationRatio([syntheticHand({ handedness: 'left' })], { width: 640, height: 480 }),
    ).toBeUndefined();
  });

  it('resets filtered history when either hand disappears', () => {
    const tracker = new BimanualSeparationTracker({ minCutoff: 1, beta: 0 });
    const first = tracker.update(pair(), { width: 640, height: 480 }, 0);
    expect(first).toBeGreaterThan(0);
    expect(tracker.update([syntheticHand({ handedness: 'left' })], { width: 640, height: 480 }, 33)).toBeUndefined();
    expect(tracker.update(pair(1, 0.6), { width: 640, height: 480 }, 66)).toBeGreaterThan(first!);
  });
});

describe('magnetic snap filter', () => {
  it('snaps at 0, 50%, and 100%, then releases with hysteresis', () => {
    const snap = new MagneticSnapFilter();
    expect(snap.update(0.02)).toBe(0);
    expect(snap.update(0.05)).toBe(0);
    expect(snap.update(0.07)).toBeCloseTo(0.07, 9);
    expect(snap.update(0.49)).toBe(0.5);
    expect(snap.update(0.98)).toBe(1);
    expect(snap.update(undefined)).toBeUndefined();
    expect(snap.update(0.98)).toBe(1);
  });
});
