import type { Delegate, PoseSnapshot, WorkerReply, WorkerRequest } from './protocol';

export interface PoseClientCallbacks {
  onPose(snapshot: PoseSnapshot, capturedAtMs: number): void;
  onStatus(status: 'loading' | 'ready' | 'fallback' | 'error', detail: string): void;
  onDrop(): void;
}

export class PoseClient {
  private worker?: Worker;
  private busy = false;
  private stopped = true;
  private frameId = 0;
  private lastTimestamp = 0;
  private callbackId?: number;
  private rafId?: number;
  private lastVideoTime = -1;
  private capturedAtById = new Map<number, number>();
  private video?: HTMLVideoElement;

  async start(video: HTMLVideoElement, callbacks: PoseClientCallbacks, preferred: Delegate = 'GPU'): Promise<void> {
    this.stop();
    this.stopped = false;
    this.video = video;
    callbacks.onStatus('loading', 'Carregando MediaPipe e modelo local…');
    let resolveInitialization!: () => void;
    const initialized = new Promise<void>((resolve) => { resolveInitialization = resolve; });
    this.onReady = () => { this.ready = true; resolveInitialization(); };
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.type === 'READY') {
        this.ready = true;
        this.onReady?.();
        callbacks.onStatus('ready', `MediaPipe pronto · ${message.delegate}`);
      } else if (message.type === 'FALLBACK') {
        callbacks.onStatus('fallback', 'GPU indisponível; usando CPU.');
      } else if (message.type === 'ERROR') {
        this.busy = false;
        callbacks.onStatus(message.fatal ? 'error' : 'fallback', message.message);
        if (message.fatal) { this.onReady?.(); this.stop(); }
      } else if (message.type === 'POSE') {
        this.busy = false;
        const receivedAtMs = performance.now();
        const capturedAtMs = this.capturedAtById.get(message.frameId) ?? receivedAtMs;
        this.capturedAtById.delete(message.frameId);
        const { type: _type, ...data } = message;
        callbacks.onPose({ ...data, receivedAtMs, trackingState: 'degraded', bodyConfidence: this.confidence(data.landmarks) }, capturedAtMs);
      }
    };
    worker.onerror = (event) => {
      callbacks.onStatus('error', event.message || 'Falha no Worker de visão.');
      this.onReady?.();
      this.stop();
    };
    worker.postMessage({
      type: 'INIT', delegate: preferred,
      wasmBaseUrl: new URL(`${import.meta.env.BASE_URL}mediapipe/wasm/`, location.origin).href,
      modelUrl: new URL(`${import.meta.env.BASE_URL}mediapipe/models/pose_landmarker_lite.task`, location.origin).href,
    } satisfies WorkerRequest);
    let initializationTimeout: number | undefined;
    await Promise.race([
      initialized,
      new Promise<void>((resolve) => { initializationTimeout = window.setTimeout(resolve, 30_000); }),
    ]);
    if (initializationTimeout !== undefined) window.clearTimeout(initializationTimeout);
    this.onReady = undefined;
    if (!this.worker || this.stopped) return;
    if (!this.ready) { callbacks.onStatus('error', 'Inicialização do MediaPipe excedeu 30 segundos.'); this.stop(); return; }
    const schedule = () => {
      if (this.stopped) return;
      const supportsVideoFrameCallback = typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
      if (supportsVideoFrameCallback) {
        this.callbackId = video.requestVideoFrameCallback((now) => {
          schedule();
          void this.capture(video, now, callbacks);
        });
      } else {
        this.rafId = requestAnimationFrame(() => {
          schedule();
          if (video.currentTime !== this.lastVideoTime) {
            this.lastVideoTime = video.currentTime;
            void this.capture(video, performance.now(), callbacks);
          }
        });
      }
    };
    schedule();
  }

  private ready = false;
  private onReady?: () => void;

  private async capture(video: HTMLVideoElement, now: number, callbacks: PoseClientCallbacks): Promise<void> {
    if (this.busy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) { this.busy && callbacks.onDrop(); return; }
    this.busy = true;
    const timestampMs = Math.max(now, this.lastTimestamp + 0.01);
    this.lastTimestamp = timestampMs;
    const frameId = ++this.frameId;
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'low' });
      if (this.stopped || !this.worker) { bitmap.close(); this.busy = false; return; }
      this.capturedAtById.set(frameId, timestampMs);
      this.worker.postMessage({ type: 'FRAME', frameId, timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
    } catch (error) {
      this.busy = false;
      callbacks.onStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.callbackId !== undefined) this.video?.cancelVideoFrameCallback?.(this.callbackId);
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    this.worker?.postMessage({ type: 'DISPOSE' } satisfies WorkerRequest);
    this.worker?.terminate();
    this.worker = undefined; this.video = undefined; this.busy = false; this.ready = false; this.capturedAtById.clear();
  }

  private confidence(points: PoseSnapshot['landmarks']): number {
    const indices = [11, 12, 15, 16, 23, 24, 25, 26];
    return Math.min(...indices.map((index) => points[index]?.visibility ?? 0));
  }
}
