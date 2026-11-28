import { FilesetResolver } from '@mediapipe/tasks-vision';
import type { Delegate } from '../types';
import { shouldFallbackForLatency } from './delegateProbe';

export type DelegateOutcome = { ok: true } | { ok: false; message: string };
export type VisionFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/** Frames needed for the latency verdict: one warmup plus enough warmed samples for a median. */
const LATENCY_PROBE_FRAMES = 5;

export interface DelegateTask<T extends { close(): void }> {
  /**
   * Creates and warms up the task, falling back to CPU when the preferred GPU creation fails, and
   * returns the delegate that actually came up. Throws when no delegate could be created.
   */
  init(preferred: Delegate): Promise<Delegate>;
  /**
   * The landmarker for this frame. Undefined while a delegate switch is in progress — the frame
   * must be dropped, not treated as the fatal missing-task invariant.
   */
  readonly task: T | undefined;
  readonly delegate: Delegate;
  readonly switching: boolean;
  /** GPU→CPU switch, allowed once per session; also cancels a pending latency verdict. */
  fallback(reason: string): Promise<DelegateOutcome>;
  /** Real per-frame inference time on the GPU delegate; starts the latency verdict. */
  judgeLatency(inferenceMs: number): Promise<DelegateOutcome>;
  dispose(): void;
}

/** Fetches the task model into memory; the workers ship it as bytes so no second request is made. */
export async function loadModelBytes(modelUrl: string, label: string): Promise<Uint8Array> {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`${label} model request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Delegate lifecycle of a MediaPipe VIDEO task in a worker: creation through a refreshed WASM
 * fileset, the single GPU→CPU switch a session allows, and the latency verdict that triggers it.
 *
 * The verdict exists because the GPU delegate over software GL (SwiftShader/llvmpipe — GPU
 * blocklists, VMs, RDP) costs ~96-243 ms/frame without ever throwing, so only timing evidence can
 * catch it. Everything here is correlated with the delegate it was measured on: a worker whose CPU
 * task is already live does not collect samples for a verdict that no longer applies.
 *
 * The workers keep the protocol and the frame loop; this is only which delegate is live.
 */
export function createDelegateTask<T extends { close(): void }>(options: {
  wasmBaseUrl: string;
  create(fileset: VisionFileset, delegate: Delegate): Promise<T>;
  /** Pays the first-inference setup cost (shader compilation, buffers) before a real frame. */
  warmUp?(task: T): void;
}): DelegateTask<T> {
  let task: T | undefined;
  let delegate: Delegate = 'GPU';
  let attemptedFallback = false;
  let creations = 0;
  let switching = false;
  let latencyVerdictDone = false;
  const gpuInferenceTimes: number[] = [];

  /**
   * The fileset for the next task creation. MediaPipe consumes and clears `self.ModuleFactory`
   * after instantiation, and a module worker caches the ESM import by URL, so every creation after
   * the first needs a fresh loader URL to restore the factory.
   */
  async function fileset(): Promise<VisionFileset> {
    const vision = await FilesetResolver.forVisionTasks(options.wasmBaseUrl, true);
    const attempt = creations++;
    if (attempt === 0) return vision;
    const loaderUrl = new URL(vision.wasmLoaderPath, self.location.href);
    loaderUrl.searchParams.set('instance', String(attempt));
    vision.wasmLoaderPath = loaderUrl.href;
    return vision;
  }

  async function switchToCpu(reason: string): Promise<DelegateOutcome> {
    switching = true;
    closeTask(task);
    task = undefined;
    try {
      const created = await options.create(await fileset(), 'CPU');
      options.warmUp?.(created);
      task = created;
      delegate = 'CPU';
      self.postMessage({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason });
      return { ok: true };
    } catch (error) {
      const cpuReason = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `GPU falhou (${reason}); fallback CPU também falhou (${cpuReason}).` };
    } finally {
      switching = false;
    }
  }

  function fallback(reason: string): Promise<DelegateOutcome> {
    if (delegate !== 'GPU' || attemptedFallback) return Promise.resolve({ ok: false, message: reason });
    attemptedFallback = true;
    // A verdict that lost the race must not fire again after the switch it did not own.
    latencyVerdictDone = true;
    return switchToCpu(reason);
  }

  return {
    get delegate() {
      return delegate;
    },
    async init(preferred: Delegate): Promise<Delegate> {
      try {
        const created = await options.create(await fileset(), preferred);
        options.warmUp?.(created);
        task = created;
        delegate = preferred;
      } catch (error) {
        if (preferred !== 'GPU') throw error;
        const outcome = await fallback(error instanceof Error ? error.message : String(error));
        if (!outcome.ok) throw new Error(outcome.message);
      }
      return delegate;
    },
    get task() {
      return task;
    },
    get switching() {
      return switching;
    },
    fallback,
    async judgeLatency(inferenceMs: number): Promise<DelegateOutcome> {
      if (delegate !== 'GPU' || latencyVerdictDone) return { ok: true };
      gpuInferenceTimes.push(inferenceMs);
      if (gpuInferenceTimes.length < LATENCY_PROBE_FRAMES) return { ok: true };
      latencyVerdictDone = true;
      if (!shouldFallbackForLatency(gpuInferenceTimes)) return { ok: true };
      const sorted = [...gpuInferenceTimes.slice(1)].sort((a, b) => a - b);
      const median = Math.round(sorted[Math.floor(sorted.length / 2)]!);
      return fallback(`GPU lento (mediana ${median} ms/frame — provável GL de software)`);
    },
    dispose(): void {
      closeTask(task);
      task = undefined;
    },
  };
}

/** MediaPipe tasks throw while closing a graph that failed before initializing. */
export function closeTask(task: { close(): void } | undefined): void {
  try {
    task?.close();
  } catch {
    /* task may have failed before initialization */
  }
}
