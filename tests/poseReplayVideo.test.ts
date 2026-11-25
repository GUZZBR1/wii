import { describe, expect, it } from 'vitest';
import { seekVideoTo } from '../scripts/poseReplayVideo';

function fakeVideo(currentTime: number, readyState: number): HTMLVideoElement {
  const target = new EventTarget() as EventTarget & { currentTime: number; readyState: number };
  target.currentTime = currentTime;
  target.readyState = readyState;
  return target as unknown as HTMLVideoElement;
}

function setReadyState(video: HTMLVideoElement, readyState: number): void {
  Object.defineProperty(video, 'readyState', { value: readyState, configurable: true });
}

describe('pose replay video readiness', () => {
  it('waits for decoded data when the requested time is already selected', async () => {
    const video = fakeVideo(0, 1);
    let settled = false;
    const seeking = seekVideoTo(video, 0, 1_000).then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);

    setReadyState(video, 2);
    video.dispatchEvent(new Event('loadeddata'));
    await seeking;
    expect(settled).toBe(true);
  });

  it('waits for decoded data after a completed seek', async () => {
    const video = fakeVideo(0, 2);
    let settled = false;
    const seeking = seekVideoTo(video, 1, 1_000).then(() => { settled = true; });

    setReadyState(video, 1);
    video.dispatchEvent(new Event('seeked'));
    await Promise.resolve();
    expect(settled).toBe(false);

    setReadyState(video, 2);
    video.dispatchEvent(new Event('loadeddata'));
    await seeking;
    expect(settled).toBe(true);
  });
});
