import { describe, expect, it } from 'vitest';
import { fovFor, scrollZ } from '../src/games/track/scroll';

describe('scenery scroll', () => {
  it('advances and wraps to the far end keeping the overshoot', () => {
    expect(scrollZ(0, 2, -66, 14)).toBe(2);
    expect(scrollZ(13, 3, -66, 14)).toBe(-64);
    expect(scrollZ(14, 0, -66, 14)).toBe(-66);
  });

  it('keeps pieces evenly spaced after many laps', () => {
    let pieces = [-66, -62, -58];
    for (let i = 0; i < 5000; i += 1) pieces = pieces.map((z) => scrollZ(z, 0.37, -66, 14));
    expect((pieces[1]! - pieces[0]! + 80) % 80).toBeCloseTo(4);
    expect((pieces[2]! - pieces[1]! + 80) % 80).toBeCloseTo(4);
  });

  it('widens the view with speed within bounds', () => {
    expect(fovFor(0)).toBe(52);
    expect(fovFor(1)).toBe(58);
    expect(fovFor(5)).toBe(58);
  });
});
