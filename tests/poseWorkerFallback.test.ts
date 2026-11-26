import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandWorkerReply, HandWorkerRequest } from '../packages/core/src/providers/handProtocol';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';

const mediaPipe = vi.hoisted(() => {
  const consumedModuleUrls = new Set<string>();
  const moduleUrls: string[] = [];

  return {
    moduleUrls,
    reset() {
      consumedModuleUrls.clear();
      moduleUrls.length = 0;
    },
    forVisionTasks: vi.fn(async (baseUrl: string) => ({
      wasmLoaderPath: `${baseUrl}/vision_wasm_module_internal.js`,
      wasmBinaryPath: `${baseUrl}/vision_wasm_module_internal.wasm`,
    })),
    createFromOptions: vi.fn(
      async (fileset: { wasmLoaderPath: string }, options: { baseOptions: { delegate: string } }) => {
        const loaderUrl = fileset.wasmLoaderPath;
        if (consumedModuleUrls.has(loaderUrl)) throw new Error('ModuleFactory not set.');
        consumedModuleUrls.add(loaderUrl);
        moduleUrls.push(loaderUrl);

        if (options.baseOptions.delegate === 'GPU') {
          return {
            close: vi.fn(),
            detectForVideo: vi.fn(() => {
              throw new Error('GPU graph failed.');
            }),
          };
        }

        return {
          close: vi.fn(),
          detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [] })),
        };
      },
    ),
  };
});

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: mediaPipe.forVisionTasks },
  PoseLandmarker: { createFromOptions: mediaPipe.createFromOptions },
  HandLandmarker: { createFromOptions: mediaPipe.createFromOptions },
}));

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest | HandWorkerRequest>) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
  location: { href: string };
}

describe('MediaPipe worker GPU-to-CPU fallback', () => {
  let worker: WorkerScope;

  beforeEach(() => {
    vi.resetModules();
    mediaPipe.reset();
    mediaPipe.forVisionTasks.mockClear();
    mediaPipe.createFromOptions.mockClear();

    worker = {
      onmessage: null,
      postMessage: vi.fn(),
      location: { href: 'http://localhost/packages/core/src/providers/pose.worker.js' },
    };
    vi.stubGlobal('self', worker);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(1),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recreates the WASM loader for CPU and continues processing frames', async () => {
    await import('../packages/core/src/providers/pose.worker');
    const dispatch = async (data: WorkerRequest) => {
      if (!worker.onmessage) throw new Error('worker message handler was not installed');
      await worker.onmessage({ data } as MessageEvent<WorkerRequest>);
    };

    await dispatch({
      type: 'INIT',
      delegate: 'GPU',
      wasmBaseUrl: '/mediapipe/wasm-1.2.3',
      modelUrl: '/mediapipe/pose.task',
    });

    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    await dispatch({ type: 'FRAME', bitmap, requestId: 1, captureEpoch: 1, timestampMs: 10 });

    const replies = () => worker.postMessage.mock.calls.map(([reply]) => reply as WorkerReply);
    expect(replies().some((reply) => reply.type === 'FALLBACK' && reply.to === 'CPU')).toBe(true);
    expect(replies().some((reply) => reply.type === 'ERROR' && !reply.fatal)).toBe(true);
    expect(mediaPipe.moduleUrls).toHaveLength(2);
    expect(mediaPipe.moduleUrls[1]).not.toBe(mediaPipe.moduleUrls[0]);
    expect(bitmap.close).toHaveBeenCalledOnce();

    const cpuBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    await dispatch({ type: 'FRAME', bitmap: cpuBitmap, requestId: 2, captureEpoch: 1, timestampMs: 20 });

    expect(replies().some((reply) => reply.type === 'POSE' && reply.requestId === 2)).toBe(true);
    expect(cpuBitmap.close).toHaveBeenCalledOnce();
  });

  it('recreates the WASM loader for the hand worker CPU fallback too', async () => {
    await import('../packages/core/src/providers/hand.worker');
    const dispatch = async (data: HandWorkerRequest) => {
      if (!worker.onmessage) throw new Error('worker message handler was not installed');
      await worker.onmessage({ data } as MessageEvent<HandWorkerRequest>);
    };

    await dispatch({
      type: 'INIT',
      delegate: 'GPU',
      wasmBaseUrl: '/mediapipe/wasm-1.2.3',
      modelUrl: '/mediapipe/hand.task',
    });

    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    await dispatch({ type: 'FRAME', bitmap, requestId: 1, timestampMs: 10 });

    const replies = () => worker.postMessage.mock.calls.map(([reply]) => reply as HandWorkerReply);
    expect(replies().some((reply) => reply.type === 'FALLBACK' && reply.to === 'CPU')).toBe(true);
    expect(replies().some((reply) => reply.type === 'ERROR' && !reply.fatal)).toBe(true);
    expect(mediaPipe.moduleUrls).toHaveLength(2);
    expect(mediaPipe.moduleUrls[1]).not.toBe(mediaPipe.moduleUrls[0]);
    expect(bitmap.close).toHaveBeenCalledOnce();

    const cpuBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    await dispatch({ type: 'FRAME', bitmap: cpuBitmap, requestId: 2, timestampMs: 20 });

    expect(replies().some((reply) => reply.type === 'HAND' && reply.requestId === 2)).toBe(true);
    expect(cpuBitmap.close).toHaveBeenCalledOnce();
  });
});
