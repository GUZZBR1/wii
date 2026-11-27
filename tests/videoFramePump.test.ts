import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoFramePump } from '../packages/core/src/providers/videoFramePump';

type FrameVideo = HTMLVideoElement & {
  fireFrame(now: number): void;
  currentTime: number;
};

function makeVideo(): FrameVideo {
  let nextId = 0;
  let callback: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
  return {
    readyState: 2,
    currentTime: 0,
    requestVideoFrameCallback: (next: (now: number, metadata: VideoFrameCallbackMetadata) => void) => {
      callback = next;
      return ++nextId;
    },
    cancelVideoFrameCallback: () => {
      callback = undefined;
    },
    fireFrame(now: number) {
      const frameCallback = callback;
      callback = undefined;
      frameCallback?.(now, {} as VideoFrameCallbackMetadata);
    },
  } as unknown as FrameVideo;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('VideoFramePump', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('drops frames while processing is pending and keeps one flight across restart', async () => {
    const pump = new VideoFramePump();
    const video = makeVideo();
    const oldFrame = deferred<void>();
    const oldOnFrame = vi.fn(() => oldFrame.promise);
    const newOnFrame = vi.fn(async () => {});
    const onError = vi.fn();

    pump.start(video, { onFrame: oldOnFrame, onError });
    video.fireFrame(10);
    video.fireFrame(15);
    expect(oldOnFrame).toHaveBeenCalledOnce();

    pump.start(video, { onFrame: newOnFrame, onError });
    video.fireFrame(20);
    expect(newOnFrame).not.toHaveBeenCalled();

    oldFrame.resolve();
    await flush();
    video.fireFrame(25);
    await flush();

    expect(newOnFrame).toHaveBeenCalledOnce();
    expect(newOnFrame).toHaveBeenCalledWith(25);
    expect(onError).not.toHaveBeenCalled();
    pump.stop();
  });

  it('uses rAF only for new video times, makes timestamps monotonic, and reports processing errors', async () => {
    const callbacks: FrameRequestCallback[] = [];
    let now = 20;
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const pump = new VideoFramePump();
    const video = { readyState: 2, currentTime: 1 } as FrameVideo;
    const onFrame = vi.fn(async (_timestampMs: number) => {});
    const onError = vi.fn();
    pump.start(video, { onFrame, onError });

    callbacks.shift()?.(20);
    await flush();
    callbacks.shift()?.(30);
    await flush();
    expect(onFrame).toHaveBeenCalledOnce();

    video.currentTime = 2;
    now = 10;
    callbacks.shift()?.(40);
    await flush();
    expect(onFrame.mock.calls[1]?.[0]).toBe(20.01);

    pump.stop();
    const failNextFrame = new VideoFramePump();
    const failingVideo = makeVideo();
    const failingOnFrame = vi.fn().mockRejectedValueOnce(new Error('consumer failed')).mockResolvedValue(undefined);
    const failingOnError = vi.fn();
    failNextFrame.start(failingVideo, { onFrame: failingOnFrame, onError: failingOnError });
    failingVideo.fireFrame(10);
    await flush();
    expect(failingOnError).toHaveBeenCalledWith(new Error('consumer failed'));
    failingVideo.fireFrame(20);
    await flush();
    expect(failingOnFrame).toHaveBeenCalledTimes(2);
    failNextFrame.stop();
  });

  it('ignores a queued callback after stop', () => {
    const pump = new VideoFramePump();
    let queued: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
    const video = {
      readyState: 2,
      requestVideoFrameCallback: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => {
        queued = callback;
        return 1;
      },
      cancelVideoFrameCallback: vi.fn(),
    } as unknown as HTMLVideoElement;
    const onFrame = vi.fn(async () => {});

    pump.start(video, { onFrame, onError: vi.fn() });
    const staleCallback = queued;
    pump.stop();
    staleCallback?.(10, {} as VideoFrameCallbackMetadata);

    expect(onFrame).not.toHaveBeenCalled();
  });
});
