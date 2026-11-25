import { describe, expect, it } from 'vitest';
import { type Lane, LANES, nextKind, nextLane } from '../src/games/track/spawn';

describe('fair spawn', () => {
  it('maps the rng across all lanes when nothing repeats', () => {
    expect([0, 0.5, 0.99].map((r) => nextLane([], () => r))).toEqual([...LANES]);
    expect([0, 0.5, 0.99].map((r) => nextLane([0, 1], () => r))).toEqual([...LANES]);
  });

  it('closes a lane that already took two hurdles in a row', () => {
    for (const lane of LANES) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.99]) expect(nextLane([lane, lane], () => r)).not.toBe(lane);
    }
  });

  it('never produces three in a row even with a stuck rng', () => {
    for (const r of [0, 0.5, 0.99]) {
      const history: Lane[] = [];
      for (let i = 0; i < 30; i += 1) history.push(nextLane(history, () => r));
      expect(history.some((lane, i) => lane === history[i + 1] && lane === history[i + 2])).toBe(false);
    }
  });
});

describe('item kind', () => {
  it('spawns mostly hurdles with some coins', () => {
    expect(nextKind(() => 0.1)).toBe('coin');
    expect(nextKind(() => 0.9)).toBe('hurdle');
  });
});
