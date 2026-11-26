// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { SportActionEvent } from '../src/cv/protocol';
import type { GameHudState } from '../src/games/track/TrackGame';

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

const { TrackGame } = await import('../src/games/track/TrackGame');

function sprint(timestampMs: number, trackingState: SportActionEvent['trackingState'], speed01: number): SportActionEvent {
  return { id: timestampMs, timestampMs, confidence: 1, trackingState, source: 'cv', type: 'sprint', speed01, cadenceSpm: 150 };
}

describe('track blackout adjudication', () => {
  it('preserves a same-lane hurdle while camera input coasts and judges it only after control returns', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    let hud: GameHudState | undefined;
    const game = new TrackGame(canvas, (state) => { hud = state; });
    const update = loopState.update;
    expect(update).toBeDefined();
    let now = 1000;
    let nextEventId = 1;
    const step = (seconds: number, trackingState: SportActionEvent['trackingState'], speed01: number) => {
      const frames = Math.round(seconds * 60);
      for (let frame = 0; frame < frames; frame += 1) {
        now += 1000 / 60;
        if (frame % 5 === 0) {
          game.onAction({ ...sprint(now, trackingState, speed01), id: nextEventId++ });
        }
        update!(1 / 60, now, now);
      }
    };

    game.setTracking('TRACKING');
    step(3, 'tracked', 0);
    game.onKey('ArrowLeft');
    step(1.2, 'tracked', 1);
    const beforeBlackout = hud?.score;
    step(1, 'degraded', 0.45);
    expect(hud?.feedback?.kind).not.toBe('hit');
    expect(hud?.score).toBe(beforeBlackout);

    step(0.8, 'tracked', 1);
    expect(hud?.feedback?.kind).toBe('hit');
    game.dispose();
    canvas.remove();
  });
});
