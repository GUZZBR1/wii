import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoseWorkerSession } from '../scripts/poseReplaySession';
import type { WorkerReply, WorkerRequest } from '@wii/spatial-core';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: WorkerRequest[] = [];

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    this.messages.push(message);
  }

  terminate(): void {}

  emit(data: WorkerReply): void {
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
}

describe('pose replay worker session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records a recoverable GPU fallback as a dropped sample and continues on CPU', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await expect(initialization).resolves.toBe('GPU');

    const firstSample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 0);
    const firstFrame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    expect(firstFrame?.type).toBe('FRAME');
    if (firstFrame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    worker.emit({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason: 'GPU context lost' });
    worker.emit({
      type: 'ERROR', stage: 'detect', fatal: false, requestId: firstFrame.requestId,
      captureEpoch: firstFrame.captureEpoch, message: 'GPU failed; next frame will use CPU.',
    });
    await expect(firstSample).resolves.toBeUndefined();
    expect(session.delegate).toBe('CPU');

    const nextSample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 100);
    const nextFrame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    expect(nextFrame?.type).toBe('FRAME');
    if (nextFrame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    const poseReply: WorkerReply = {
      type: 'POSE', requestId: nextFrame.requestId, captureEpoch: nextFrame.captureEpoch,
      timestampMs: 100, landmarks: [], worldLandmarks: [],
    };
    worker.emit(poseReply);
    await expect(nextSample).resolves.toEqual(poseReply);
  });

  it('rejects a frame when CPU inference fails after fallback', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await initialization;

    const sample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 0);
    const frame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    if (frame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    worker.emit({
      type: 'ERROR', stage: 'detect', fatal: true, requestId: frame.requestId,
      captureEpoch: frame.captureEpoch, message: 'GPU and CPU inference failed.',
    });

    await expect(sample).rejects.toThrow('GPU and CPU inference failed.');
  });
});
