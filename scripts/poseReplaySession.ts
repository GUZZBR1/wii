import type { Delegate, WorkerReply, WorkerRequest } from '@wii/spatial-core';

type PoseReply = Extract<WorkerReply, { type: 'POSE' }>;

interface PendingFrame {
  resolve: (reply: PoseReply | undefined) => void;
  reject: (error: Error) => void;
  timeout: number;
}

export class PoseWorkerSession {
  private readonly pending = new Map<number, PendingFrame>();
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private requestId = 1;
  private effectiveDelegate: Delegate;
  private ready = false;
  private poseReplyCount = 0;
  private mixedConfigurationSamples = false;

  constructor(private readonly worker: Worker, preferredDelegate: Delegate) {
    this.effectiveDelegate = preferredDelegate;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => this.onMessage(data);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'Pose worker failed.'));
  }

  get delegate(): Delegate {
    return this.effectiveDelegate;
  }

  get hasMixedConfigurationSamples(): boolean {
    return this.mixedConfigurationSamples;
  }

  assertSingleConfigurationRun(): void {
    if (!this.mixedConfigurationSamples) return;
    throw new Error('GPU fell back after primary-model samples were collected; this mixed-configuration replay cannot be used as a single-configuration reference. Rerun with a healthy GPU or choose CPU from the start.');
  }

  async initialize(wasmBaseUrl: string, modelUrl: string, cpuModelUrl?: string): Promise<Delegate> {
    this.worker.postMessage({
      type: 'INIT',
      delegate: this.effectiveDelegate,
      wasmBaseUrl,
      modelUrl,
      ...(cpuModelUrl ? { cpuModelUrl } : {}),
    } satisfies WorkerRequest);
    let timeout: number | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('Pose worker initialization timed out.')), 30_000);
        }),
      ]);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
    return this.effectiveDelegate;
  }

  detect(bitmap: ImageBitmap, timestampMs: number): Promise<PoseReply | undefined> {
    const requestId = this.requestId++;
    const captureEpoch = 1;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Pose inference timed out at ${timestampMs} ms.`));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.worker.postMessage({ type: 'FRAME', requestId, captureEpoch, timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(requestId);
        bitmap.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    try {
      this.worker.postMessage({ type: 'DISPOSE' } satisfies WorkerRequest);
    } finally {
      this.worker.terminate();
      this.failAll(new Error('Pose worker was disposed.'));
    }
  }

  private onMessage(message: WorkerReply): void {
    if (message.type === 'READY') {
      this.effectiveDelegate = message.delegate;
      this.ready = true;
      this.settleReady();
    } else if (message.type === 'FALLBACK') {
      if (this.ready && this.poseReplyCount > 0) this.mixedConfigurationSamples = true;
      this.effectiveDelegate = message.to;
    } else if (message.type === 'ERROR') {
      const error = new Error(message.message);
      if (message.stage === 'init') {
        if (message.fatal) this.settleReady(error);
        return;
      }

      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      if (message.fatal) pending.reject(error);
      else pending.resolve(undefined);
    } else if (message.type === 'POSE') {
      this.poseReplyCount += 1;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      pending.resolve(message);
    }
  }

  private settleReady(error?: Error): void {
    const resolve = this.readyResolve;
    const reject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private failAll(error: Error): void {
    this.settleReady(error);
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
