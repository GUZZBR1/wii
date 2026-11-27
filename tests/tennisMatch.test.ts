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
    resolveSwing(swing: { hand?: 'left' | 'right'; side: 'forehand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number }): void;
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

it('plays again when both hands are held up after the match, and not before they come down', () => {
  const huds: { tennis?: { restart01: number } }[] = [];
  const game = new TennisGame(document.createElement('canvas'), (hud) => { huds.push(hud as never); });
  const state = game as unknown as {
    phase: { kind: string };
    stepPhase(dt: number, now: number, wallTimeMs: number): void;
    publishHud(): void;
  };
  try {
    state.phase = { kind: 'match-over' };
    let atMs = 0;
    const hold = (raised: boolean, seconds: number) => {
      for (let i = 0; i < seconds * 60; i += 1) {
        atMs += 1000 / 60;
        game.setHandsRaised(raised, atMs);
        state.stepPhase(1 / 60, atMs, atMs);
      }
    };
    hold(true, 5); // still swinging after the last point
    state.publishHud();
    expect(huds.at(-1)!.tennis!.restart01).toBe(0);
    hold(false, 2);
    hold(true, 1.6);
    state.publishHud();
    expect(huds.at(-1)!.tennis!.restart01).toBe(1);
  } finally {
    game.dispose();
  }
});

it.each([-900, -300, 0, 400, 1500])('puts any serve stroke in play, %i ms from the apex', (offsetMs) => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  try {
    state.startPoint(1000);
    clock.mockReturnValue(1100);
    game.setTossHand(undefined);
    game.setTossHand('left');
    const { idealHitMs } = state.phase as unknown as { idealHitMs: number };
    state.resolveSwing({ side: 'forehand', power01: 0, verticalSpeed: 0, contactY: -1, peakTimestampMs: idealHitMs + offsetMs });
    expect(state.phase.kind).toBe('rally');
    for (let now = 1100; now < 3500 && state.ball && state.ball.bounces === 0 && state.faults === 0; now += 1000 / 60) {
      state.stepBall(1 / 60, now);
    }
    // First bounce reached on the far side: no net, no fault, no point against.
    expect(state.ball?.bounces).toBe(1);
    expect(state.ball!.position.z).toBeLessThan(0);
    expect(state.faults).toBe(0);
    expect(state.score.points.opponent).toBe(0);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it.each([0, 1])('serves the opponent diagonally into the box, never a fault (point %i)', (points) => {
  const { game, state } = match();
  const opponent = state as unknown as { stepPhase(dt: number, now: number): void };
  try {
    state.score = { ...state.score, server: 'opponent', points: { player: points, opponent: 0 } };
    state.startPoint(1000);
    opponent.stepPhase(1 / 60, 3000);
    for (let now = 3000; now < 6000 && state.ball.bounces === 0 && state.faults === 0; now += 1000 / 60) state.stepBall(1 / 60, now);
    expect(state.faults).toBe(0);
    expect(state.ball.bounces).toBe(1);
  } finally {
    game.dispose();
  }
});

it('tosses into the simulation after a long pause in rendering', () => {
  const { game, state } = match();
  const timing = state as unknown as { lastSimulationTimeMs: number; lastWallTimeMs: number; wallToSimulationOffsetMs: number };
  const clock = vi.spyOn(performance, 'now').mockReturnValue(11_000);
  try {
    timing.lastSimulationTimeMs = 1000;
    timing.lastWallTimeMs = 11_000;
    timing.wallToSimulationOffsetMs = -10_000;
    state.startPoint(1000);
    game.setTossHand(undefined);
    game.setTossHand('left');
    state.stepBall(1 / 60, 1017);
    expect(state.ball.velocity.y).toBeGreaterThan(0);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('throws at once when the free hand rises, and only the racket hand strikes', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const swing = (hand: 'left' | 'right') => state.resolveSwing({ hand, side: 'forehand', power01: 0.5, verticalSpeed: 0, contactY: 0, peakTimestampMs: performance.now() });
  try {
    state.startPoint(1000);
    clock.mockReturnValue(1300);
    game.setTossHand('left'); // already up when the serve began: does not count
    game.setTossHand(undefined);
    game.setTossHand('right'); // the racket arm never throws
    swing('right');
    expect(state.phase.kind).toBe('player-serve');
    game.setTossHand('left');
    clock.mockReturnValue(2500); // 1.2 s later, as recorded: the ball is still there to be struck
    state.stepBall(1 / 60, 2500);
    swing('left');
    expect(state.phase.kind).toBe('player-serve');
    swing('right');
    expect(state.phase.kind).toBe('rally');
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});


it('opens with the warm-up and starts the match once it is done', () => {
  const huds: { banner?: { title: string } }[] = [];
  const travels: number[] = [];
  const game = new TennisGame(document.createElement('canvas'), (hud) => huds.push(hud), undefined, { tutorial: true, onStrokeTravel: (travel) => travels.push(travel) });
  const state = game as unknown as { phase: { kind: string }; publishHud(): void };
  const swing = (side: 'forehand' | 'backhand') => game.onAction({ type: 'swing', id: 1, timestampMs: 0, confidence: 1, trackingState: 'tracked', source: 'cv', hand: 'right', side, power01: 0.5, travel: 3, contactY: 0, verticalSpeed: 0 });
  try {
    state.publishHud();
    expect(huds.at(-1)?.banner?.title).toBe('Dê 3 raquetadas');
    for (const side of ['forehand', 'forehand', 'forehand', 'backhand', 'backhand'] as const) swing(side);
    for (let i = 0; i < 4; i += 1) {
      game.setTossHand(undefined);
      game.setTossHand('left');
      if (i >= 2) swing('forehand');
    }
    expect(state.phase.kind).toBe('point-over');
    expect(travels).toEqual([1.6, 1.9]);
  } finally {
    game.dispose();
  }
});

it('returns an arriving ball on plain arm movement when no stroke was read, and not without it', () => {
  for (const moved of [true, false]) {
    const { game, state } = match();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const help = state as unknown as { helpWithMotion(now: number): void };
    try {
      const incoming = createBall({ x: 0, y: 0.9, z: 7.2 + 8 * 0.2 }, { x: 0, y: 1, z: 8 }, 'opponent');
      state.phase = { kind: 'rally' };
      state.ball = incoming;
      state.tape = [{ tMs: 700, ball: createBall({ x: 0, y: 0.9, z: 7.2 - 8 * 0.1 }, { x: 0, y: 1, z: 8 }, 'opponent') }];
      if (moved) game.setArmMotions([{ hand: 'right', sideways: 1 }]);
      help.helpWithMotion(1000);
      expect(state.ball.lastHitter).toBe(moved ? 'player' : 'opponent');
    } finally {
      clock.mockRestore();
      game.dispose();
    }
  }
});
