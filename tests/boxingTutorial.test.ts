import { describe, expect, it } from 'vitest';
import {
  BoxingTutorial, DODGE_HOLD_S, GIVE_UP_AFTER_S, PROOF_WARN_S, PUNCHES_NEEDED, SETTLE_S, type TutorialFrame,
} from '../src/games/boxing/boxingTutorial';

const STILL: TutorialFrame = { dtS: 0.05, seen: true, guard: false, zone: 0, ducked: false };

function run(tutorial: BoxingTutorial, seconds: number, frame: Partial<TutorialFrame> = {}) {
  for (let i = 0; i < Math.round(seconds / 0.05); i += 1) tutorial.tick({ ...STILL, ...frame });
}

const DODGES = [{ zone: -1 as const }, { zone: 1 as const }, { ducked: true }];

function reachProof(tutorial: BoxingTutorial) {
  run(tutorial, SETTLE_S + 1, { guard: true });
  for (let i = 0; i < PUNCHES_NEEDED; i += 1) tutorial.punch();
  for (const dodge of DODGES) run(tutorial, SETTLE_S + DODGE_HOLD_S + 0.1, dodge);
}

describe('BoxingTutorial', () => {
  it('updates tutorial text when the game language changes', () => {
    const tutorial = new BoxingTutorial('en');
    expect(tutorial.text.title).toBe('Guard: fists by your face');
    expect(tutorial.text.detail).toBe('Raise both hands to skip');
    tutorial.setLanguage('pt');
    expect(tutorial.text.title).toBe('Defesa: punhos no rosto');
  });

  it('counts nothing while the instruction is being read, nor off camera', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, SETTLE_S - 0.1, { guard: true });
    run(tutorial, 10, { guard: true, seen: false });
    expect(tutorial.step).toBe('guard');
  });

  it('asks for each side on its own: the wrong one does not count', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, SETTLE_S + 1, { guard: true });
    for (let i = 0; i < PUNCHES_NEEDED; i += 1) tutorial.punch();
    run(tutorial, SETTLE_S + 2, { zone: 1 });
    expect(tutorial.step).toBe('left');
    run(tutorial, DODGE_HOLD_S + 0.1, { zone: -1 });
    expect(tutorial.step).toBe('right');
  });

  it('passes the test with two dodged attacks', () => {
    const tutorial = new BoxingTutorial();
    reachProof(tutorial);
    expect(tutorial.step).toBe('proof');
    run(tutorial, SETTLE_S + 0.1);
    expect(tutorial.attackInS).toBeGreaterThan(0);
    expect(tutorial.attackInS).toBeLessThan(PROOF_WARN_S);
    for (let i = 0; i < 200 && !tutorial.done; i += 1) run(tutorial, 0.1, { ducked: true });
    expect(tutorial.done).toBe(true);
    expect(tutorial.learned).toBe(6);
  });

  it('has the dodges practised once more when the test fails, then moves on', () => {
    const tutorial = new BoxingTutorial();
    reachProof(tutorial);
    for (let i = 0; i < 400 && tutorial.step === 'proof'; i += 1) run(tutorial, 0.1);
    expect(tutorial.step).toBe('left');
    for (const dodge of DODGES) run(tutorial, SETTLE_S + DODGE_HOLD_S + 0.1, dodge);
    for (let i = 0; i < 400 && !tutorial.done; i += 1) run(tutorial, 0.1);
    expect(tutorial.done).toBe(true);
  });

  it('never traps a player the camera cannot satisfy', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, GIVE_UP_AFTER_S * 12);
    expect(tutorial.done).toBe(true);
  });
});
