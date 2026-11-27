// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { createBall, type BallState } from '../src/games/tennis/ballistics';
import { TennisGame } from '../src/games/tennis/TennisGame';
import type { TennisScoreState } from '../src/games/tennis/tennisScore';

vi.mock('../src/games/core/GameLoop', () => ({ GameLoop: class { dispose() {} } }));

function match() {
  const game = new TennisGame(document.createElement('canvas'), () => {});
  const state = game as unknown as {
    ball: BallState;
    score: TennisScoreState;
    faults: number;
    servingFlight: boolean;
    phase: { kind: string };
    tape: { tMs: number; ball: BallState }[];
    pendingPoint?: { deadAt: number };
    startPoint(now: number): void;
    stepBall(dt: number, now: number): void;
    resolveSwing(swing: { side: 'forehand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number }): void;
  };
  return { game, state };
}

it('keeps the serve side on first fault and scores the second fault exactly once', () => {
  const { game, state } = match();
  try {
    state.startPoint(1000);
    const firstX = state.ball.position.x;
    for (const time of [1200, 1400]) {
      state.phase = { kind: 'rally' };
      state.servingFlight = true;
      state.ball = createBall({ x: 2, y: 0.01, z: -4 }, { x: 0, y: -2, z: 0 }, 'player');
      state.stepBall(1 / 60, time);
      if (time === 1200) {
        expect(state.faults).toBe(1);
        expect(state.ball.position.x).toBe(firstX);
        expect(state.score.points.opponent).toBe(0);
      }
    }
    state.stepBall(1 / 60, 1500);
    expect(state.score.points.opponent).toBe(1);
    expect(state.faults).toBe(0);
  } finally {
    game.dispose();
  }
});

it('accepts a confirmed return from before the second bounce', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1200);
  try {
    const incoming = { ...createBall({ x: 0, y: 0.5, z: 7.2 }, { x: 0, y: -3, z: 5 }, 'opponent'), bounces: 1 };
    state.phase = { kind: 'rally' };
    state.ball = incoming;
    state.tape = [{ tMs: 1000, ball: incoming }];
    state.stepBall(0.15, 1150);
    expect(state.pendingPoint).toBeDefined();
    const swing = { side: 'forehand' as const, power01: 0.5, verticalSpeed: 0, contactY: 0 };
    state.resolveSwing({ ...swing, peakTimestampMs: 999 });
    state.resolveSwing({ ...swing, peakTimestampMs: 1190 });
    expect(state.pendingPoint).toBeDefined();
    state.resolveSwing({ ...swing, peakTimestampMs: 1000 });
    expect(state.pendingPoint).toBeUndefined();
    expect(state.ball.lastHitter).toBe('player');
    expect(state.score.points.opponent).toBe(0);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});
