import { describe, expect, it } from 'vitest';
import { formatTime, MAX_SPEED_MPS, Race, type Split } from '../src/games/athletics/race';

const STEP = 1 / 60;

describe('Race', () => {
  it('records each 100 m split once and stops at the goal', () => {
    const race = new Race(400);
    const splits: Split[] = [];
    for (let i = 0; i < 60 * 60; i += 1) {
      const split = race.advance(STEP, 1);
      if (split) splits.push(split);
    }
    expect(splits.map((split) => split.meters)).toEqual([100, 200, 300, 400]);
    expect(splits[0]!.seconds).toBeCloseTo(100 / MAX_SPEED_MPS, 5);
    expect(race.finished).toBe(true);
    expect(race.distance).toBe(400);
    expect(race.seconds).toBeCloseTo(400 / MAX_SPEED_MPS, 5);
  });

  it('keeps the clock running while stopped', () => {
    const race = new Race();
    race.advance(1, 0);
    expect(race.seconds).toBe(1);
    expect(race.distance).toBe(0);
  });

  it('handles zero speed exactly on a split mark', () => {
    const race = new Race();
    race.advance(100 / MAX_SPEED_MPS, 1);
    expect(race.distance).toBe(100);
    race.advance(1, 0);
    expect(race.distance).toBe(100);
    expect(race.seconds).toBeCloseTo(100 / MAX_SPEED_MPS + 1, 5);
    expect(race.splits).toHaveLength(1);
  });

  it('formats minutes, seconds and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(65.47)).toBe('1:05.4');
  });
});
