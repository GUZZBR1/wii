import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoseClient } from '@nevergear/spatial-core';
import type { WorkerReply, WorkerRequest } from '@nevergear/spatial-core';

class InitFailureWorker {
  static instance: InitFailureWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(_url: URL, _options: WorkerOptions) {
    InitFailureWorker.instance = this;
  }

  postMessage(message: WorkerRequest): void {
    if (message.type === 'INIT') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: { type: 'ERROR', stage: 'init', fatal: true, message: 'model load failed' },
        } as MessageEvent<WorkerReply>);
      });
    }
  }

  terminate(): void {}
}

class SilentWorker {
  static instance: SilentWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(_url: URL, _options: WorkerOptions) {
    SilentWorker.instance = this;
  }

  postMessage(_message: WorkerRequest): void {}
  terminate(): void {}
}

const callbacks = {
  onPose: vi.fn(),
  onStatus: vi.fn(),
};

describe('spatial-core PoseClient initialization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    InitFailureWorker.instance = undefined;
    SilentWorker.instance = undefined;
    callbacks.onPose.mockReset();
    callbacks.onStatus.mockReset();
  });

  it('rejects init when the worker reports a fatal initialization error', async () => {
    vi.stubGlobal('Worker', InitFailureWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const client = new PoseClient({ wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });

    await expect(client.init(callbacks, 'CPU')).rejects.toThrow('model load failed');
    expect(client.isReady).toBe(false);
    expect(callbacks.onStatus).toHaveBeenCalledWith('error', 'model load failed');
  });

  it('rejects init when the worker does not become ready before the initialization timeout', async () => {
    vi.stubGlobal('Worker', SilentWorker);
    vi.stubGlobal('window', {
      setTimeout(callback: TimerHandler) {
        if (typeof callback === 'function') callback();
        return 1;
      },
      clearTimeout: vi.fn(),
    });
    const client = new PoseClient({ wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });

    await expect(client.init(callbacks, 'CPU')).rejects.toThrow(/excedeu 30 segundos/i);
    expect(client.isReady).toBe(false);
    expect(callbacks.onStatus).toHaveBeenCalledWith('error', expect.stringMatching(/excedeu 30 segundos/i));
  });

  it('rejects an in-progress init if the client is disposed', async () => {
    vi.stubGlobal('Worker', SilentWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const client = new PoseClient({ wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });
    const initialization = client.init(callbacks, 'CPU');

    client.dispose();

    await expect(initialization).rejects.toThrow(/disposed before initialization/i);
    expect(client.isReady).toBe(false);
  });
});
