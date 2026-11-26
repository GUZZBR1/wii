import { describe, expect, it, vi } from 'vitest';
import { AthleticsGame } from '../src/games/athletics/AthleticsGame';

const gameLoopState = vi.hoisted(() => ({ dispose: vi.fn() }));

vi.mock('../src/games/core/GameLoop', () => ({
  GameLoop: class {
    readonly renderer = {};

    constructor(..._args: unknown[]) {}

    dispose(): void {
      gameLoopState.dispose();
    }
  },
}));

vi.mock('../src/games/athletics/stadiumScene', () => ({
  buildStadium: () => {
    throw new Error('Canvas 2D indisponível');
  },
}));

describe('AthleticsGame lifecycle', () => {
  it('disposes the game loop when stadium construction fails', () => {
    expect(() => new AthleticsGame({} as HTMLCanvasElement, () => {})).toThrow('Canvas 2D indisponível');
    expect(gameLoopState.dispose).toHaveBeenCalledTimes(1);
  });
});
