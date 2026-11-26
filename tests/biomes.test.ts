import { describe, expect, it } from 'vitest';
import { biomeAt } from '../src/games/track/biomes';

describe('biomeAt', () => {
  it('clamps zero and negative travel to the first biome', () => {
    const start = biomeAt(0);
    expect(start).toMatchObject({ current: { id: 'neighborhood' }, next: { id: 'park' }, blend01: 0 });
    expect(biomeAt(-1)).toEqual(start);
  });

  it('stays unblended in the middle of a biome', () => {
    expect(biomeAt(500)).toMatchObject({ current: { id: 'park' }, next: { id: 'coast' }, blend01: 0 });
  });

  it('blends toward the next biome inside the transition zone', () => {
    const result = biomeAt(260);
    expect(result).toMatchObject({ current: { id: 'neighborhood' }, next: { id: 'park' } });
    expect(result.blend01).toBeCloseTo(0.5);
  });

  it('blends from night back to neighborhood', () => {
    const result = biomeAt(2750);
    expect(result).toMatchObject({ current: { id: 'night' }, next: { id: 'neighborhood' } });
    expect(result.blend01).toBeCloseTo(0.375);
  });

  it('wraps after the full loop distance', () => {
    expect(biomeAt(2800)).toEqual(biomeAt(0));
    expect(biomeAt(2801)).toEqual(biomeAt(1));
  });
});
