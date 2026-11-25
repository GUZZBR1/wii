import type { Delegate, PoseSnapshot, WorkerReply, WorkerRequest } from './protocol';
import { MEDIAPIPE_WASM_VERSION, POSE_MODEL_SHA8 } from './mediapipeAssets';

export interface PoseClientCallbacks {
  onPose(snapshot: PoseSnapshot): void;
  onStatus(status: 'loading' | 'ready' | 'fallback' | 'error', detail: string): void;
}

function mediapipeAssetUrls() {
  const base = `${import.meta.env.BASE_URL}mediapipe`;
  const wasmBaseUrl = new URL(`${base}/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href;
  return {
    wasmBaseUrl,
    wasmModuleUrls: [
      `${wasmBaseUrl}/vision_wasm_module_internal.js`,
      `${wasmBaseUrl}/vision_wasm_module_internal.wasm`,
    ],
    modelUrl: new URL(`${base}/models/pose_landmarker_lite.${POSE_MODEL_SHA8}.task`, location.origin).href,
  };
}

export class PoseClient {
  private worker?: Worker;
  private ready = false;
  private activeDelegate?: Delegate;
  private initPromise?: Promise<void>;
  private busy = false;
  private capturing = false;
  private lastTimestamp = 0;
  private callbackId?: number;
  private rafId?: number;
  private lastVideoTime = -1;
  private video?: HTMLVideoElement;
  private callbacks?: PoseClientCallbacks;
  private onReady?: () => void;

  static warmVisionAssets(): void {
    const { wasmModuleUrls, modelUrl } = mediapipeAssetUrls();
    for (const url of [...wasmModuleUrls, modelUrl]) void fetch(url).then((response) => (response.ok ? response.arrayBuffer() : undefined)).catch(() => undefined);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get delegate(): Delegate | undefined {
    return this.activeDelegate;
  }

  async init(callbacks: PoseClientCallbacks, preferred: Delegate = 'GPU'): Promise<void> {
    this.callbacks = callbacks;
    if (this.ready) return;
    this.initPromise ??= this.spawn(preferred);
    await this.initPromise;
  }

  beginCapture(video: HTMLVideoElement, callbacks: PoseClientCallbacks): void {
    this.callbacks = callbacks;
    if (!this.worker || !this.ready || this.capturing) return;
    this.capturing = true;
    this.video = video;
    this.lastVideoTime = -1;
    this.callbacks?.onStatus('ready', `MediaPipe pronto · ${this.activeDelegate} · capturando`);
    const schedule = () => {
      if (!this.capturing) return;
      const supportsVideoFrameCallback = typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
      if (supportsVideoFrameCallback) {
        this.callbackId = video.requestVideoFrameCallback((now) => {
          schedule();
          void this.capture(video, now);
        });
      } else {
        this.rafId = requestAnimationFrame(() => {
          schedule();
          if (video.currentTime !== this.lastVideoTime) {
            this.lastVideoTime = video.currentTime;
            void this.capture(video, performance.now());
          }
        });
      }
    };
    schedule();
  }

  pauseCapture(): void {
    this.capturing = false;
    if (this.callbackId !== undefined) this.video?.cancelVideoFrameCallback?.(this.callbackId);
    this.callbackId = undefined;
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
    this.video = undefined;
  }

  dispose(): void {
    this.pauseCapture();
    this.worker?.postMessage({ type: 'DISPOSE' } satisfies WorkerRequest);
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = false;
    this.activeDelegate = undefined;
    this.busy = false;
    this.initPromise = undefined;
    this.onReady?.();
    this.onReady = undefined;
    this.callbacks = undefined;
  }

  private async spawn(preferred: Delegate): Promise<void> {
    this.callbacks?.onStatus('loading', 'Carregando MediaPipe e modelo local…');
    const { wasmBaseUrl, modelUrl } = mediapipeAssetUrls();
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const initialized = new Promise<void>((resolve) => { this.onReady = resolve; });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.type === 'READY') {
        this.ready = true;
        this.activeDelegate = message.delegate;
        this.onReady?.();
        this.callbacks?.onStatus('ready', `MediaPipe pronto · ${message.delegate}`);
      } else if (message.type === 'FALLBACK') {
        this.callbacks?.onStatus('fallback', 'GPU indisponível; usando CPU.');
      } else if (message.type === 'ERROR') {
        this.busy = false;
        this.callbacks?.onStatus(message.fatal ? 'error' : 'fallback', message.message);
        if (message.fatal) { this.onReady?.(); this.dispose(); }
      } else if (message.type === 'POSE') {
        this.busy = false;
        if (!this.capturing) return;
        const { type: _type, ...data } = message;
        this.callbacks?.onPose({ ...data, trackingState: 'degraded', bodyConfidence: this.confidence(data.landmarks) });
      }
    };
    worker.onerror = (event) => {
      this.callbacks?.onStatus('error', event.message || 'Falha no Worker de visão.');
      this.onReady?.();
      this.dispose();
    };
    worker.postMessage({ type: 'INIT', delegate: preferred, wasmBaseUrl, modelUrl } satisfies WorkerRequest);
    let initializationTimeout: number | undefined;
    await Promise.race([
      initialized,
      new Promise<void>((resolve) => { initializationTimeout = window.setTimeout(resolve, 30_000); }),
    ]);
    if (initializationTimeout !== undefined) window.clearTimeout(initializationTimeout);
    this.onReady = undefined;
    if (this.worker !== worker) return;
    if (!this.ready) { this.callbacks?.onStatus('error', 'Inicialização do MediaPipe excedeu 30 segundos.'); this.dispose(); }
  }

  private async capture(video: HTMLVideoElement, now: number): Promise<void> {
    if (this.busy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    this.busy = true;
    const timestampMs = Math.max(now, this.lastTimestamp + 0.01);
    this.lastTimestamp = timestampMs;
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'low' });
      if (!this.capturing || !this.worker) { bitmap.close(); this.busy = false; return; }
      this.worker.postMessage({ type: 'FRAME', timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
    } catch (error) {
      this.busy = false;
      this.callbacks?.onStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  private confidence(points: PoseSnapshot['landmarks']): number {
    const indices = [11, 12, 15, 16, 23, 24, 25, 26];
    return Math.min(...indices.map((index) => points[index]?.visibility ?? 0));
  }
}
