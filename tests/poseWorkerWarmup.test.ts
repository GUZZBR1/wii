import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';

const mediaPipe = vi.hoisted(() => ({
  detectForVideo: vi.fn(),
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({ wasmLoaderPath: 'http://localhost/loader.js' }) },
  PoseLandmarker: {
    createFromOptions: async () => ({ close: vi.fn(), detectForVideo: mediaPipe.detectForVideo }),
  },
}));

class FakeCanvas {
  constructor(readonly width: number, readonly height: number) {}
  getContext() { return { fillRect: vi.fn() }; }
}

describe('pose worker warm-up and frame ownership', () => {
  let scope: { onmessage: ((event: MessageEvent<WorkerRequest>) => Promise<void>) | null; postMessage: ReturnType<typeof vi.fn> };
  const result = { landmarks: [], worldLandmarks: [] };
  const replies = () => scope.postMessage.mock.calls.map(([reply]) => reply as WorkerReply);
  const dispatch = (data: WorkerRequest) => scope.onmessage!({ data } as MessageEvent<WorkerRequest>);
  const videoFrame = () => ({ displayWidth: 640, displayHeight: 480, close: vi.fn() }) as unknown as VideoFrame;

  beforeEach(async () => {
    vi.resetModules();
    mediaPipe.detectForVideo.mockReset().mockReturnValue(result);
    scope = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', scope);
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    await import('../packages/core/src/providers/pose.worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const init = () => dispatch({ type: 'INIT', delegate: 'GPU', wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });

  it('warms up once before READY, below the first real timestamp even when it is 0', async () => {
    mediaPipe.detectForVideo.mockImplementationOnce(() => {
      expect(replies()).toHaveLength(0);
      return result;
    });
    await init();
    expect(mediaPipe.detectForVideo).toHaveBeenCalledOnce();
    expect(mediaPipe.detectForVideo.mock.calls[0]?.[0]).toBeInstanceOf(FakeCanvas);

    const frame = videoFrame();
    await dispatch({ type: 'FRAME', bitmap: frame, requestId: 1, captureEpoch: 1, timestampMs: 0 });

    expect(mediaPipe.detectForVideo).toHaveBeenCalledTimes(2);
    const [warmupTimestamp, frameTimestamp] = mediaPipe.detectForVideo.mock.calls.map(([, timestamp]) => timestamp as number);
    expect(frameTimestamp).toBeGreaterThan(warmupTimestamp!);
    expect(replies().at(-1)).toMatchObject({ type: 'POSE', timestampMs: 0, frameWidth: 640, frameHeight: 480 });
    expect(frame.close).toHaveBeenCalledOnce();
  });

  it('ignores a failing warm-up without falling back', async () => {
    mediaPipe.detectForVideo.mockImplementationOnce(() => { throw new Error('warm-up failed'); });
    await init();

    expect(replies()).toEqual([{ type: 'READY', delegate: 'GPU' }]);
  });

  it('closes frames from any capture epoch, including after disposal', async () => {
    await init();
    const stale = videoFrame();
    await dispatch({ type: 'FRAME', bitmap: stale, requestId: 1, captureEpoch: 0, timestampMs: 10 });
    expect(stale.close).toHaveBeenCalledOnce();

    await dispatch({ type: 'DISPOSE' });
    const late = videoFrame();
    await dispatch({ type: 'FRAME', bitmap: late, requestId: 2, captureEpoch: 1, timestampMs: 20 });
    expect(late.close).toHaveBeenCalledOnce();
    expect(replies().at(-1)).toMatchObject({ type: 'ERROR', stage: 'detect', fatal: true });
  });
});
