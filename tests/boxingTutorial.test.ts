import { describe, expect, it } from 'vitest';
import {
  BoxingTutorial, DODGE_HOLD_S, GIVE_UP_AFTER_S, NEUTRAL_S, PROOF_WARN_S, PUNCHES_NEEDED, SETTLE_S, type TutorialFrame,
} from '../src/games/boxing/boxingTutorial';

const STILL: TutorialFrame = { dtS: 0.05, seen: true, guard: false, zone: 0, ducked: false, reach: 0 };

function run(tutorial: BoxingTutorial, seconds: number, frame: Partial<TutorialFrame> = {}) {
  for (let i = 0; i < Math.round(seconds / 0.05); i += 1) tutorial.tick({ ...STILL, ...frame });
}

/** Does every step up to, and not including, the test. */
function reachProof(tutorial: BoxingTutorial) {
  run(tutorial, SETTLE_S + NEUTRAL_S + 0.1);
  run(tutorial, SETTLE_S + 1, { guard: true });
  for (let i = 0; i < PUNCHES_NEEDED; i += 1) tutorial.punch(0.9);
  for (let i = 0; i < 3; i += 1) run(tutorial, SETTLE_S + DODGE_HOLD_S + 0.1, { reach: 1 });
}

describe('BoxingTutorial', () => {
  it('takes nothing while the instruction is being read, nor off camera', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, SETTLE_S - 0.1);
    expect(tutorial.teaching).toBeUndefined();
    run(tutorial, 10, { seen: false });
    expect(tutorial.step).toBe('neutral');
    run(tutorial, 0.2);
    expect(tutorial.teaching).toBe('neutral');
  });

  it('fills a dodge only while the movement is big enough, and says how close it is', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, SETTLE_S + NEUTRAL_S + 0.1);
    run(tutorial, SETTLE_S + 1, { guard: true });
    for (let i = 0; i < PUNCHES_NEEDED; i += 1) tutorial.punch();
    expect(tutorial.step).toBe('left');
    run(tutorial, SETTLE_S + 1, { reach: 0.6 });
    expect(tutorial.step).toBe('left');
    expect(tutorial.progress01).toBeCloseTo(0.09);
    expect(tutorial.text.detail).toBe('Quase! Um pouco mais');
    run(tutorial, DODGE_HOLD_S + 0.1, { reach: 1 });
    expect(tutorial.step).toBe('right');
  });

  it('passes the test with two dodged attacks and adapts the punch travel', () => {
    const tutorial = new BoxingTutorial();
    reachProof(tutorial);
    expect(tutorial.step).toBe('proof');
    run(tutorial, SETTLE_S + 0.1);
    expect(tutorial.attackInS).toBeGreaterThan(0);
    expect(tutorial.attackInS).toBeLessThan(PROOF_WARN_S);
    for (let i = 0; i < 200 && !tutorial.done; i += 1) run(tutorial, 0.1, { ducked: true });
    expect(tutorial.done).toBe(true);
    expect(tutorial.punchTravel).toBeCloseTo(0.25);
    expect(tutorial.learned).toBe(7);
  });

  it('teaches the dodges again once when the test fails, then moves on', () => {
    const tutorial = new BoxingTutorial();
    reachProof(tutorial);
    for (let i = 0; i < 400 && tutorial.step === 'proof'; i += 1) run(tutorial, 0.1);
    expect(tutorial.step).toBe('left');
    for (let i = 0; i < 3; i += 1) run(tutorial, SETTLE_S + DODGE_HOLD_S + 0.1, { reach: 1 });
    for (let i = 0; i < 400 && !tutorial.done; i += 1) run(tutorial, 0.1);
    expect(tutorial.done).toBe(true);
  });

  it('never traps a player the camera cannot satisfy', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, GIVE_UP_AFTER_S * 12);
    expect(tutorial.done).toBe(true);
    expect(tutorial.punchTravel).toBeUndefined();
  });
});
