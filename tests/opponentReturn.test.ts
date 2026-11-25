import { describe, expect, it } from 'vitest';
import { advanceBall, createBall, solveOutgoing, type BallState } from '../src/games/tennis/ballistics';
import { resolveScheduledOpponentReturn, type OpponentHitPlan } from '../src/games/tennis/opponentReturn';

const closeState = (actual: BallState, expected: BallState) => {
  expect(actual.position.x).toBeCloseTo(expected.position.x, 10);
  expect(actual.position.y).toBeCloseTo(expected.position.y, 10);
  expect(actual.position.z).toBeCloseTo(expected.position.z, 10);
  expect(actual.velocity.x).toBeCloseTo(expected.velocity.x, 10);
  expect(actual.velocity.y).toBeCloseTo(expected.velocity.y, 10);
  expect(actual.velocity.z).toBeCloseTo(expected.velocity.z, 10);
};

describe('scheduled opponent return', () => {
  it('returns from the scheduled crossing and advances only the post-contact overrun', () => {
    const fromBall = createBall({ x: 0.8, y: 1.4, z: -6.5 }, { x: -0.5, y: 1.8, z: -10 }, 'player');
    const plan: OpponentHitPlan = {
      fromBall,
      contactAfterSeconds: 0.07,
      hitAtMs: 1_070,
    };
    const nowMs = 1_086;
    const target = { x: -1.2, z: 7.5 };
    const flightTimeSeconds = 0.9;
    const contact = advanceBall(fromBall, plan.contactAfterSeconds);
    const outgoing = solveOutgoing(contact.position, target, flightTimeSeconds);
    const expected = advanceBall(createBall(contact.position, outgoing, 'opponent'), 0.016);

    const actual = resolveScheduledOpponentReturn(plan, nowMs, target, flightTimeSeconds);

    closeState(actual, expected);
    expect(actual.position.z).toBeGreaterThan(contact.position.z);
    expect(actual.position.z).toBeLessThan(contact.position.z + 0.3);
  });

  it('does not move the return before its scheduled contact time', () => {
    const fromBall = createBall({ x: 0, y: 1.2, z: -6 }, { x: 0, y: 0, z: -10 }, 'player');
    const plan: OpponentHitPlan = { fromBall, contactAfterSeconds: 0.1, hitAtMs: 1_100 };
    const contact = advanceBall(fromBall, 0.1);
    const target = { x: 0.5, z: 8 };
    const flightTimeSeconds = 1;
    const outgoing = solveOutgoing(contact.position, target, flightTimeSeconds);

    const actual = resolveScheduledOpponentReturn(plan, 1_100, target, flightTimeSeconds);

    closeState(actual, createBall(contact.position, outgoing, 'opponent'));
  });
});
