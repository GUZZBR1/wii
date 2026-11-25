import { describe, expect, it } from 'vitest';
import { awardText, SHAKE_DURATION_S, shakeOffset } from '../src/games/track/feedback';

describe('track feedback', () => {
  it('names the points, the perfect and the multiplier', () => {
    expect(awardText({ points: 100, multiplier: 1, perfect: false })).toBe('+100');
    expect(awardText({ points: 450, multiplier: 3, perfect: true })).toBe('+450 · PERFECT · ×3');
  });

  it('shakes briefly and comes to rest', () => {
    for (let t = SHAKE_DURATION_S; t > 0; t -= 1 / 60) expect(Math.abs(shakeOffset(t).x)).toBeLessThanOrEqual(0.18);
    expect(Math.abs(shakeOffset(0).x)).toBe(0);
    expect(Math.abs(shakeOffset(0).y)).toBe(0);
  });
});
