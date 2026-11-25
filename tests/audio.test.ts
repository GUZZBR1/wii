import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProceduralAudio } from '../src/games/audio';

class FakeAudioContext {
  state = 'running';
  currentTime = 1;
  destination = {};
  oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];

  createOscillator() {
    const oscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }

  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

afterEach(() => vi.unstubAllGlobals());

describe('ProceduralAudio tennis cues', () => {
  it('schedules bounce, success, failure and milestone cues through Web Audio', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();

    audio.bounce(0.4);
    audio.success(0.8);
    audio.failure();
    audio.milestone();

    const context = audio as unknown as { context: FakeAudioContext };
    expect(context.context.oscillators).toHaveLength(8);
    expect(context.context.oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1)).toBe(true);
    expect(context.context.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 1)).toBe(true);

    audio.setMuted(true);
    audio.bounce();
    expect(context.context.oscillators).toHaveLength(8);
    audio.dispose();
  });
});
