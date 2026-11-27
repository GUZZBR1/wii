import { describe, expect, it } from 'vitest';
import {
  fighterDistance,
  inPunchRange,
  MIN_FIGHTER_DISTANCE,
  moveAround,
  OPPONENT_START,
  PLAYER_START,
  PUNCH_RANGE,
  RING_LIMIT,
  type RingPosition,
  stepOpponentPosition,
} from '../src/games/boxing/ringMovement';

const repeat = (times: number, position: RingPosition, step: (p: RingPosition) => RingPosition) => {
  let current = position;
  for (let i = 0; i < times; i += 1) current = step(current);
  return current;
};

describe('ring movement', () => {
  it('starts both fighters 2.70 m apart, inside punch range', () => {
    expect(fighterDistance(PLAYER_START, OPPONENT_START)).toBeCloseTo(2.7);
    expect(inPunchRange(PLAYER_START, OPPONENT_START)).toBe(true);
  });

  it('stops at the ropes', () => {
    const back = repeat(200, PLAYER_START, (p) => moveAround(p, OPPONENT_START, -0.05, 0));
    expect(back).toEqual({ x: 0, z: RING_LIMIT });
    const circled = repeat(500, PLAYER_START, (p) => moveAround(p, OPPONENT_START, 0, 0.05));
    expect(Math.abs(circled.x)).toBeLessThanOrEqual(RING_LIMIT);
    expect(Math.abs(circled.z)).toBeLessThanOrEqual(RING_LIMIT);
  });

  it('keeps the minimum distance when walking in, even in one huge step', () => {
    for (const forward of [0.05, 10]) {
      const close = repeat(100, PLAYER_START, (p) => moveAround(p, OPPONENT_START, forward, 0));
      expect(fighterDistance(close, OPPONENT_START)).toBeCloseTo(MIN_FIGHTER_DISTANCE);
      expect(close.z).toBeGreaterThan(OPPONENT_START.z);
    }
  });

  it('never ends up overlapping the other fighter against the ropes', () => {
    const cornered = { x: RING_LIMIT, z: RING_LIMIT };
    const other = { x: RING_LIMIT - 1.1, z: RING_LIMIT - 1.1 };
    for (const strafe of [-0.3, 0.3]) {
      const moved = moveAround(cornered, other, 0.2, strafe);
      expect(fighterDistance(moved, other)).toBeGreaterThanOrEqual(MIN_FIGHTER_DISTANCE - 1e-6);
    }
  });

  it('circles on an arc, to the mover own right when strafe is positive', () => {
    const right = moveAround(PLAYER_START, OPPONENT_START, 0, 0.5);
    expect(right.x).toBeGreaterThan(0);
    expect(fighterDistance(right, OPPONENT_START)).toBeCloseTo(2.7);
    expect(moveAround(PLAYER_START, OPPONENT_START, 0, -0.5).x).toBeLessThan(0);
  });

  it('checks reach', () => {
    expect(inPunchRange({ x: 0, z: 0 }, { x: 0, z: PUNCH_RANGE })).toBe(true);
    expect(inPunchRange({ x: 0, z: 0 }, { x: 0, z: PUNCH_RANGE + 0.01 })).toBe(false);
  });

  it('walks the opponent back into range', () => {
    const player = { x: 0, z: 2.5 };
    let opponent: RingPosition = { x: 0, z: -2.5 };
    for (let i = 0; i < 300; i += 1) opponent = stepOpponentPosition(opponent, player, 'guard', 1, 1 / 60).position;
    expect(fighterDistance(opponent, player)).toBeCloseTo(2.75);
  });

  it('circles while guarding or recovering and plants its feet to wind up', () => {
    for (const phase of ['guard', 'recover'] as const) {
      const { position } = stepOpponentPosition(OPPONENT_START, PLAYER_START, phase, 1, 0.5);
      expect(position.x).not.toBeCloseTo(0);
      expect(fighterDistance(position, PLAYER_START)).toBeCloseTo(2.7);
    }
    for (const player of [PLAYER_START, { x: 0, z: 2.5 }]) {
      expect(stepOpponentPosition(OPPONENT_START, player, 'windup', 1, 0.5).position).toEqual(OPPONENT_START);
    }
  });

  it('turns around at the ropes instead of leaving the ring', () => {
    let move = { position: OPPONENT_START, direction: 1 as -1 | 1 };
    const directions = new Set<number>();
    for (let i = 0; i < 3000; i += 1) {
      move = stepOpponentPosition(move.position, PLAYER_START, 'guard', move.direction, 1 / 60);
      directions.add(move.direction);
      expect(Math.abs(move.position.x)).toBeLessThanOrEqual(RING_LIMIT);
      expect(Math.abs(move.position.z)).toBeLessThanOrEqual(RING_LIMIT);
    }
    expect(directions).toEqual(new Set([-1, 1]));
  });
});
