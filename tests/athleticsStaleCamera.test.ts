// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { SportActionEvent } from '../src/cv/protocol';

type UpdateFn = (dt: number, simulationTimeMs: number, wallTimeMs: number) => void;
const loopState = vi.hoisted(() => ({ update: undefined as UpdateFn | undefined }));

vi.mock('../src/games/core/GameLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/games/core/GameLoop')>();
  return {
    ...actual,
    GameLoop: class {
      constructor(...args: unknown[]) {
        loopState.update = args[3] as UpdateFn;
      }
      dispose(): void {}
    },
  };
});
// The stadium needs a real WebGL renderer; the race rules do not.
vi.mock('../src/games/athletics/stadiumScene', () => ({
  buildStadium: () => ({ follow() {}, setShadows() {}, dispose() {} }),
}));

const { AthleticsGame } = await import('../src/games/athletics/AthleticsGame');

type Internals = { race: { distance: number; seconds: number }; rivals: { race: { distance: number } }[] };

function sprint(id: number, timestampMs: number, speed01: number): SportActionEvent {
  const base = { id, timestampMs, confidence: 1, trackingState: 'tracked' as const, source: 'cv' as const };
  return { ...base, type: 'sprint', speed01, cadenceSpm: 150 };
}

describe('athletics camera adjudication', () => {
  it('holds the whole race still once camera pace readings stop arriving', () => {
    const game = new AthleticsGame(document.createElement('canvas'), () => {});
    const internals = game as unknown as Internals;
    let now = 1000;
    let id = 1;
    const run = (seconds: number, speed01?: number) => {
      for (let frame = 0; frame < Math.round(seconds * 60); frame += 1) {
        now += 1000 / 60;
        if (speed01 !== undefined && frame % 5 === 0) game.onAction(sprint(id++, now, speed01));
        loopState.update!(1 / 60, now, now);
      }
    };

    game.setTracking('TRACKING');
    // Intro (2.2 s) and the 3-2-1 countdown, standing still.
    run(5.4, 0);
    expect(internals.race.distance).toBe(0);
    run(2, 1);
    expect(internals.race.distance).toBeGreaterThan(5);

    // The camera goes silent while the label still reads TRACKING: only the 400 ms of
    // grace may count, then nobody moves and the clock stops.
    run(0.5);
    const held = {
      player: internals.race.distance,
      clock: internals.race.seconds,
      rival: internals.rivals[0]!.race.distance,
    };
    run(2);
    expect(internals.race.distance).toBe(held.player);
    expect(internals.race.seconds).toBe(held.clock);
    expect(internals.rivals[0]!.race.distance).toBe(held.rival);

    // Fresh readings resume the race.
    run(0.5, 1);
    expect(internals.race.distance).toBeGreaterThan(held.player);
    game.dispose();
  });

  it('keeps a keyboard-paced race running without camera readings', () => {
    const game = new AthleticsGame(document.createElement('canvas'), () => {});
    const internals = game as unknown as Internals;
    for (let i = 0; i < 5; i += 1) game.onKey('ArrowUp');
    let now = 1000;
    for (let frame = 0; frame < 60 * 8; frame += 1) {
      now += 1000 / 60;
      loopState.update!(1 / 60, now, now);
    }
    expect(internals.race.distance).toBeGreaterThan(10);
    game.dispose();
  });
});
