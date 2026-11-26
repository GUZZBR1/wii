// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

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

function makeGame() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const game = new TrackGame(canvas, () => {});
  return { game, canvas, lane: () => (game as unknown as { lane: number }).lane };
}

/** Advances the countdown into the running phase — keyboard lane input only exists there. */
function run(game: InstanceType<typeof TrackGame>, seconds: number) {
  let now = 1000;
  for (let frame = 0; frame < Math.round(seconds * 60); frame += 1) {
    now += 1000 / 60;
    loopState.update!(1 / 60, now, now);
  }
  void game;
}

describe('authoritative camera lane zones in the track game', () => {
  it('applies zones absolutely during countdown — a return to center never reverses the lane', () => {
    // The exact reported desync: lean right during the countdown, hold through the start,
    // stand upright. Relative steps dropped at the gate used to turn the return into a left move.
    const { game, canvas, lane } = makeGame();
    game.setLaneZone(1); // lean right during countdown
    expect(lane()).toBe(1);
    game.setLaneZone(1); // restated every frame — never a second step
    expect(lane()).toBe(1);
    game.setLaneZone(0); // back to upright: the lane follows to center, never past it
    expect(lane()).toBe(0);
    game.setLaneZone(-1);
    expect(lane()).toBe(-1);
    game.dispose();
    canvas.remove();
  });

  it('lets keyboard steps hold until the body zone changes again', () => {
    const { game, canvas, lane } = makeGame();
    run(game, 4);
    game.setLaneZone(1);
    expect(lane()).toBe(1);
    game.onKey('ArrowLeft'); // deliberate hybrid input wins while the body stays put
    expect(lane()).toBe(0);
    game.setLaneZone(1); // same zone restated: the keyboard pick is not steamrolled
    expect(lane()).toBe(0);
    game.setLaneZone(0); // but a real body transition reasserts the camera's authority
    expect(lane()).toBe(0);
    game.setLaneZone(-1);
    expect(lane()).toBe(-1);
    game.dispose();
    canvas.remove();
  });

  it('keeps a keyboard lane override through a transient tracking drop and reacquisition', () => {
    // Regression: a blurry frame omits the zone, and reacquiring the SAME zone must not look
    // like a body movement — the player never moved, so the keyboard pick must survive.
    const { game, canvas, lane } = makeGame();
    run(game, 4);
    game.setLaneZone(0);
    game.onKey('ArrowRight');
    expect(lane()).toBe(1);
    game.setLaneZone(undefined); // degraded frame: camera has no opinion
    game.setLaneZone(undefined);
    game.setLaneZone(0); // tracking recovers, body still centered — no movement happened
    expect(lane()).toBe(1);
    game.setLaneZone(-1); // but a genuine body movement to the left lane still reasserts
    expect(lane()).toBe(-1);
    game.dispose();
    canvas.remove();
  });

  it('hands the lane to the keyboard outright while the camera has no opinion', () => {
    const { game, canvas, lane } = makeGame();
    run(game, 4);
    game.setLaneZone(undefined);
    game.onKey('ArrowRight');
    expect(lane()).toBe(1);
    game.setLaneZone(undefined);
    expect(lane()).toBe(1); // camera silence never moves the runner
    game.dispose();
    canvas.remove();
  });
});
