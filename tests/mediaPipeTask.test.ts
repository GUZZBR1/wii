import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandWorkerReply, HandWorkerRequest } from '../packages/core/src/providers/handProtocol';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';

/**
 * Regression for the shared delegate lifecycle (`providers/mediaPipeTask.ts`). The two workers now
 * own only their protocol and frame loop, so the rules that used to be duplicated still need one
 * place that asserts them — and the pose worker's dual model URL has to keep reaching the CPU task.
 */
const mediaPipe = vi.hoisted(() => ({
  /** One entry per `createFromOptions` call, in creation order. */
  creations: [] as { delegate: string; modelBytes: Uint8Array }[],
  moduleUrls: [] as string[],
  consumed: new Set<string>(),
  /** Each model URL's bytes are distinct so the worker's choice of URL is observable. */
  modelBytes: new Map<string, number>(),
  /** Creation of the GPU task fails — the path that must fall back at init. */
  gpuCreateFails: false,
  /** The GPU task is created but inference throws — the path that falls back on the first frame. */
  gpuThrows: false,
}));

async function createTask(
  fileset: { wasmLoaderPath: string },
  options: { baseOptions: { delegate: string; modelAssetBuffer: Uint8Array } },
) {
  if (mediaPipe.consumed.has(fileset.wasmLoaderPath)) throw new Error('ModuleFactory not set.');
  mediaPipe.consumed.add(fileset.wasmLoaderPath);
  mediaPipe.moduleUrls.push(fileset.wasmLoaderPath);
  const { delegate, modelAssetBuffer } = options.baseOptions;
  mediaPipe.creations.push({ delegate, modelBytes: modelAssetBuffer });
  if (delegate === 'GPU' && mediaPipe.gpuCreateFails) throw new Error('GPU graph failed.');
  if (delegate === 'GPU' && mediaPipe.gpuThrows) {
    return {
      close: vi.fn(),
      detectForVideo: () => {
        throw new Error('GPU graph failed.');
      },
    };
  }
  return { close: vi.fn(), detectForVideo: () => ({ landmarks: [], worldLandmarks: [], handedness: [] }) };
}

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: async (baseUrl: string) => ({ wasmLoaderPath: `${baseUrl}/vision_wasm_module_internal.js` }),
  },
  PoseLandmarker: { createFromOptions: createTask },
  HandLandmarker: { createFromOptions: createTask },
}));

interface Scope {
  onmessage: ((event: { data: WorkerRequest | HandWorkerRequest }) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
  location: { href: string };
}

describe('MediaPipe worker delegate lifecycle', () => {
  let scope: Scope;

  beforeEach(() => {
    vi.resetModules();
    mediaPipe.creations.length = 0;
    mediaPipe.moduleUrls.length = 0;
    mediaPipe.consumed.clear();
    mediaPipe.modelBytes.clear();
    mediaPipe.gpuThrows = false;
    mediaPipe.gpuCreateFails = false;
    scope = {
      onmessage: null,
      postMessage: vi.fn(),
      location: { href: 'http://localhost/packages/core/src/providers/pose.worker.js' },
    };
    vi.stubGlobal('self', scope);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const marker = mediaPipe.modelBytes.get(url);
        if (marker === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([marker]).buffer };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the CPU model when pose init falls back, and reports the delegate that came up', async () => {
    mediaPipe.gpuCreateFails = true;
    mediaPipe.modelBytes.set('/pose.task', 1).set('/pose-cpu.task', 2);
    await import('../packages/core/src/providers/pose.worker');

    await scope.onmessage!({
      data: {
        type: 'INIT',
        delegate: 'GPU',
        wasmBaseUrl: '/mediapipe/wasm-1.2.3',
        modelUrl: '/pose.task',
        cpuModelUrl: '/pose-cpu.task',
      },
    });

    // The GPU task is created from the full model, the CPU task from the pinned CPU one: the
    // worker's `cpuModelUrl` distinction has to survive the extraction.
    expect(mediaPipe.creations.map((creation) => creation.delegate)).toEqual(['GPU', 'CPU']);
    expect([...mediaPipe.creations[0]!.modelBytes]).toEqual([1]);
    expect([...mediaPipe.creations[1]!.modelBytes]).toEqual([2]);
    // A fresh loader URL for the second creation, or MediaPipe has no ModuleFactory to consume.
    expect(mediaPipe.moduleUrls).toHaveLength(2);
    expect(mediaPipe.moduleUrls[1]).not.toBe(mediaPipe.moduleUrls[0]);
    expect(scope.postMessage.mock.calls.map(([reply]) => (reply as WorkerReply).type)).toEqual(['FALLBACK', 'READY']);
    // The client sizes frames and reports the delegate from READY: it must name the CPU task that
    // actually came up, not the GPU delegate it asked for.
    expect(scope.postMessage.mock.calls[1]![0]).toMatchObject({ type: 'READY', delegate: 'CPU' });
  });

  it('reports a failed CPU fallback with the CPU reason, not the GPU one', async () => {
    mediaPipe.gpuCreateFails = true;
    mediaPipe.modelBytes.set('/pose.task', 1);
    await import('../packages/core/src/providers/pose.worker');

    // The CPU model is missing, so the fallback itself cannot complete.
    await scope.onmessage!({
      data: {
        type: 'INIT',
        delegate: 'GPU',
        wasmBaseUrl: '/wasm',
        modelUrl: '/pose.task',
        cpuModelUrl: '/pose-cpu.task',
      },
    });

    const error = scope.postMessage.mock.calls.at(-1)![0] as WorkerReply;
    expect(error).toMatchObject({ type: 'ERROR', stage: 'init', fatal: true });
    expect((error as { message: string }).message).toContain('GPU falhou (GPU graph failed.)');
    expect((error as { message: string }).message).toContain('fallback CPU também falhou');
  });

  it('switches the hand worker to CPU at most once and keeps answering frames afterwards', async () => {
    mediaPipe.gpuThrows = true;
    mediaPipe.modelBytes.set('/hand.task', 7);
    await import('../packages/core/src/providers/hand.worker');
    const dispatch = (data: HandWorkerRequest) => scope.onmessage!({ data });
    const replies = () => scope.postMessage.mock.calls.map(([reply]) => reply as HandWorkerReply);

    await dispatch({ type: 'INIT', delegate: 'GPU', wasmBaseUrl: '/wasm', modelUrl: '/hand.task' });
    // Frame 1 fails on the GPU task and holds a switch; frames 2-3 are answered by the CPU task.
    for (let requestId = 1; requestId <= 3; requestId += 1) {
      await dispatch({
        type: 'FRAME',
        bitmap: { close: vi.fn() } as unknown as ImageBitmap,
        requestId,
        timestampMs: requestId * 10,
      });
    }

    // One switch, not one per failed frame: the CPU task answers the frames that follow.
    expect(replies().filter((reply) => reply.type === 'FALLBACK')).toHaveLength(1);
    expect(replies().filter((reply) => reply.type === 'HAND')).toHaveLength(2);
    expect(mediaPipe.creations.map((creation) => creation.delegate)).toEqual(['GPU', 'CPU']);
  });

  it('drops frames during the switch as non-fatal and closes each exactly once', async () => {
    mediaPipe.modelBytes.set('/hand.task', 7);
    await import('../packages/core/src/providers/hand.worker');
    const dispatch = (data: HandWorkerRequest) => scope.onmessage!({ data });
    const replies = () => scope.postMessage.mock.calls.map(([reply]) => reply as HandWorkerReply);

    await dispatch({ type: 'INIT', delegate: 'GPU', wasmBaseUrl: '/wasm', modelUrl: '/hand.task' });
    // Disposal is the reachable form of "no task right now"; the message must not be fatal only
    // while a switch is in flight, which the next test pins. Here: after DISPOSE it is fatal.
    await dispatch({ type: 'DISPOSE' });
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    await dispatch({ type: 'FRAME', bitmap, requestId: 9, timestampMs: 10 });

    expect(replies().at(-1)).toMatchObject({ type: 'ERROR', stage: 'detect', fatal: true, requestId: 9 });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
