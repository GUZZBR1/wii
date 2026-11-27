import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';
import { PoseClient } from '../packages/core/src/providers/poseClient';

class FakeWorker {
  static instance: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  throwOnFrame = false;

  constructor() { FakeWorker.instance = this; }

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    if (message.type === 'FRAME' && this.throwOnFrame) throw new Error('DataCloneError');
    this.sent.push(message);
    this.transfers.push(transfer);
    if (message.type === 'INIT') queueMicrotask(() => this.reply({ type: 'READY', delegate: message.delegate }));
  }

  terminate(): void {}

  reply(message: WorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerReply>);
  }
}

class FakeVideoFrame {
  static readonly created: FakeVideoFrame[] = [];
  readonly close = vi.fn();
  constructor(readonly source: unknown, readonly init: { timestamp: number }) { FakeVideoFrame.created.push(this); }
}

function makeVideo(videoWidth: number) {
  let callback: ((now: number) => void) | undefined;
  return {
    videoWidth,
    readyState: 2,
    requestVideoFrameCallback: (next: (now: number) => void) => { callback = next; return 1; },
    cancelVideoFrameCallback: () => { callback = undefined; },
    async fireFrame(now: number) {
      callback?.(now);
      await Promise.resolve();
      await Promise.resolve();
    },
  } as unknown as HTMLVideoElement & { fireFrame(now: number): Promise<void> };
}

describe('PoseClient frame transport', () => {
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const createBitmap = vi.fn(async () => bitmap);

  beforeEach(() => {
    FakeVideoFrame.created.length = 0;
    createBitmap.mockClear();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', createBitmap);
    vi.stubGlobal('VideoFrame', FakeVideoFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function start(videoWidth: number, delegate: 'GPU' | 'CPU' = 'GPU') {
    const client = new PoseClient({ wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });
    const callbacks = { onPose: vi.fn(), onStatus: vi.fn() };
    await client.init(callbacks, delegate);
    const video = makeVideo(videoWidth);
    client.beginCapture(video, callbacks);
    return { client, callbacks, video, worker: FakeWorker.instance! };
  }

  it('transfers a VideoFrame for video up to 640 wide and leaves closing to the worker', async () => {
    const { client, video, worker } = await start(640);
    await video.fireFrame(10);

    const [frame] = FakeVideoFrame.created;
    expect(frame?.source).toBe(video);
    expect(frame?.init.timestamp).toBe(10_000);
    expect(worker.transfers.at(-1)).toEqual([frame]);
    expect(frame?.close).not.toHaveBeenCalled();
    expect(createBitmap).not.toHaveBeenCalled();
    client.dispose();
  });

  it('downscales wider video through createImageBitmap', async () => {
    const { client, video, worker } = await start(1280);
    await video.fireFrame(10);

    expect(FakeVideoFrame.created).toHaveLength(0);
    expect(createBitmap).toHaveBeenCalledWith(video, { resizeWidth: 640, resizeQuality: 'medium' });
    expect(worker.transfers.at(-1)).toEqual([bitmap]);
    client.dispose();
  });

  it('falls back to createImageBitmap when the VideoFrame constructor throws', async () => {
    vi.stubGlobal('VideoFrame', class { constructor() { throw new Error('unsupported source'); } });
    const { client, callbacks, video, worker } = await start(640);
    await video.fireFrame(10);

    expect(worker.transfers.at(-1)).toEqual([bitmap]);
    expect(callbacks.onStatus).not.toHaveBeenCalledWith('error', expect.anything());
    client.dispose();
  });

  it('closes a VideoFrame on the main thread only when postMessage throws', async () => {
    const { client, callbacks, video, worker } = await start(640);
    worker.throwOnFrame = true;
    await video.fireFrame(10);

    expect(FakeVideoFrame.created[0]?.close).toHaveBeenCalledOnce();
    expect(callbacks.onStatus).toHaveBeenCalledWith('error', 'DataCloneError');
    client.dispose();
  });

  it('sends the CPU delegate the same input as the GPU one', async () => {
    // Athletics and tennis are tuned on CPU at this width.
    const { client, video } = await start(1280, 'CPU');
    await video.fireFrame(10);

    expect(createBitmap).toHaveBeenCalledWith(video, { resizeWidth: 640, resizeQuality: 'medium' });
    client.dispose();
  });
});
