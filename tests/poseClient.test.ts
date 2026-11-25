import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point3, WorkerReply, WorkerRequest } from '../src/cv/protocol';
import { PoseClient } from '../src/cv/poseClient';

class FakeWorker {
  static instance: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  throwOnNextFrame = false;

  constructor(_url: URL, _options: WorkerOptions) { FakeWorker.instance = this; }

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    if (message.type === 'FRAME' && this.throwOnNextFrame) {
      this.throwOnNextFrame = false;
      throw new Error('DataCloneError');
    }
    this.sent.push(message);
    this.transfers.push(transfer);
    if (message.type === 'INIT') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'READY', delegate: message.delegate } } as MessageEvent<WorkerReply>));
    }
  }

  terminate(): void {}

  reply(message: WorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerReply>);
  }
}

function makeVideo(): HTMLVideoElement & { fireFrame(now: number): void } {
  let nextId = 0;
  let callback: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
  return {
    readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
    requestVideoFrameCallback: (nextCallback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => {
      callback = nextCallback;
      return ++nextId;
    },
    cancelVideoFrameCallback: () => { callback = undefined; },
    fireFrame(now: number) {
      const frameCallback = callback;
      callback = undefined;
      frameCallback?.(now, {} as VideoFrameCallbackMetadata);
    },
  } as unknown as HTMLVideoElement & { fireFrame(now: number): void };
}

function visibleLandmarks(): Point3[] {
  return Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
}

async function flushCapture(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PoseClient capture sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeWorker.instance = undefined;
  });

  it('discards an old pose after restart and releases backpressure for the new session', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const client = new PoseClient();
    const oldOnPose = vi.fn();
    const newOnPose = vi.fn();
    const onStatus = vi.fn();
    await client.init({ onPose: oldOnPose, onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();

    client.beginCapture(video, { onPose: oldOnPose, onStatus });
    video.fireFrame(10);
    await flushCapture();
    const oldFrame = worker.sent.find((message) => message.type === 'FRAME');
    expect(oldFrame?.type).toBe('FRAME');
    if (oldFrame?.type !== 'FRAME') throw new Error('Expected an old-session frame');
    video.fireFrame(15);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);

    client.pauseCapture();
    client.beginCapture(video, { onPose: newOnPose, onStatus });
    worker.reply({
      type: 'POSE',
      requestId: oldFrame.requestId,
      captureEpoch: oldFrame.captureEpoch,
      timestampMs: 10,
      landmarks: visibleLandmarks(),
      worldLandmarks: visibleLandmarks(),
    });

    expect(oldOnPose).not.toHaveBeenCalled();
    expect(newOnPose).not.toHaveBeenCalled();

    video.fireFrame(20);
    await flushCapture();
    const frames = worker.sent.filter((message) => message.type === 'FRAME');
    const newFrame = frames.at(-1);
    expect(newFrame?.type).toBe('FRAME');
    if (newFrame?.type !== 'FRAME') throw new Error('Expected a new-session frame');
    expect(newFrame.captureEpoch).toBeGreaterThan(oldFrame.captureEpoch);
    expect(newFrame.requestId).toBeGreaterThan(oldFrame.requestId);
    expect(worker.transfers.at(-1)).toEqual([bitmap]);

    const poseReply = {
      type: 'POSE' as const,
      requestId: newFrame.requestId,
      captureEpoch: newFrame.captureEpoch,
      timestampMs: 20,
      landmarks: visibleLandmarks(),
      worldLandmarks: visibleLandmarks(),
    };
    worker.reply({ ...poseReply, requestId: poseReply.requestId + 1 });
    expect(newOnPose).not.toHaveBeenCalled();
    worker.reply(poseReply);
    worker.reply(poseReply);
    expect(newOnPose).toHaveBeenCalledOnce();

    client.dispose();
  });

  it('closes a bitmap created for a session that ended before the async copy finished', async () => {
    let resolveBitmap: ((value: ImageBitmap) => void) | undefined;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; }));

    const client = new PoseClient();
    const onPose = vi.fn();
    const onStatus = vi.fn();
    await client.init({ onPose, onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();

    client.beginCapture(video, { onPose, onStatus });
    video.fireFrame(10);
    client.pauseCapture();
    client.beginCapture(video, { onPose, onStatus });
    resolveBitmap?.(bitmap);
    await flushCapture();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);

    client.dispose();
  });

  it('closes a bitmap if postMessage fails before transferring ownership', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const client = new PoseClient();
    const onStatus = vi.fn();
    await client.init({ onPose: vi.fn(), onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    worker.throwOnNextFrame = true;

    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    video.fireFrame(10);
    await flushCapture();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);

    client.dispose();
  });

  it('releases backpressure after an ImageBitmap copy rejects', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    let copies = 0;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(() => {
      copies += 1;
      return copies === 1 ? Promise.reject(new Error('bitmap copy failed')) : Promise.resolve(bitmap);
    }));

    const client = new PoseClient();
    const onStatus = vi.fn();
    await client.init({ onPose: vi.fn(), onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    video.fireFrame(10);
    await flushCapture();

    expect(onStatus).toHaveBeenCalledWith('error', 'bitmap copy failed');
    video.fireFrame(20);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);

    client.dispose();
  });
});
