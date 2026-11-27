import type { Delegate, PoseSnapshot, WorkerReply, WorkerRequest } from './poseProtocol';

export interface PoseClientCallbacks {
  onPose(snapshot: PoseSnapshot): void;
  onStatus(status: 'loading' | 'ready' | 'fallback' | 'error', detail: string): void;
}

export interface PoseClientAssets {
  wasmBaseUrl: string;
  modelUrl: string;
}

/** Widest video sent as a raw VideoFrame; wider video is downscaled on the bitmap path. */
const MAX_DIRECT_FRAME_WIDTH = 640;
/** Bitmap copy width on the CPU delegate, where inference cost makes smaller input worthwhile. */
const CPU_BITMAP_WIDTH = 320;

export class PoseClient {
  private worker?: Worker;
  private ready = false;
  private activeDelegate?: Delegate;
  private initPromise?: Promise<void>;
  private inFlight?: { requestId: number; captureEpoch: number };
  private nextRequestId = 1;
  private captureEpoch = 0;
  private capturing = false;
  private lastTimestamp = 0;
  private callbackId?: number;
  private rafId?: number;
  private lastVideoTime = -1;
  private video?: HTMLVideoElement;
  private callbacks?: PoseClientCallbacks;
  private resolveInitialization?: () => void;
  private rejectInitialization?: (error: Error) => void;

  constructor(private readonly assets: PoseClientAssets) {}

  get isReady(): boolean {
    return this.ready;
  }

  get delegate(): Delegate | undefined {
    return this.activeDelegate;
  }

  async init(callbacks: PoseClientCallbacks, preferred: Delegate = 'GPU'): Promise<void> {
    this.callbacks = callbacks;
    if (this.ready) return;
    let initialization = this.initPromise;
    if (!initialization) {
      initialization = this.spawn(preferred);
      this.initPromise = initialization;
    }
    try {
      await initialization;
    } catch (error) {
      if (this.initPromise === initialization) this.initPromise = undefined;
      throw error;
    }
  }

  beginCapture(video: HTMLVideoElement, callbacks: PoseClientCallbacks): void {
    this.callbacks = callbacks;
    if (!this.worker || !this.ready || this.capturing) return;
    this.captureEpoch += 1;
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
    this.inFlight = undefined;
    this.initPromise = undefined;
    this.completeInitialization(new Error('PoseClient was disposed before initialization completed.'));
    this.callbacks = undefined;
  }

  private async spawn(preferred: Delegate): Promise<void> {
    this.callbacks?.onStatus('loading', 'Carregando MediaPipe e modelo local…');
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const initialized = new Promise<void>((resolve, reject) => {
      this.resolveInitialization = resolve;
      this.rejectInitialization = reject;
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === 'READY') {
        this.ready = true;
        this.activeDelegate = message.delegate;
        this.completeInitialization();
        this.callbacks?.onStatus('ready', `MediaPipe pronto · ${message.delegate}`);
      } else if (message.type === 'FALLBACK') {
        this.activeDelegate = message.to;
        this.callbacks?.onStatus('fallback', 'GPU indisponível; usando CPU.');
      } else if (message.type === 'ERROR') {
        if (message.stage === 'detect') {
          if (this.inFlight?.requestId !== message.requestId || this.inFlight.captureEpoch !== message.captureEpoch) return;
          this.releaseFrame(message.requestId, message.captureEpoch);
          if (!message.fatal && message.captureEpoch !== this.captureEpoch) return;
        }
        this.callbacks?.onStatus(message.fatal ? 'error' : 'fallback', message.message);
        if (message.fatal) {
          this.completeInitialization(new Error(message.message));
          this.dispose();
        }
      } else if (message.type === 'POSE') {
        if (this.inFlight?.requestId !== message.requestId || this.inFlight.captureEpoch !== message.captureEpoch) return;
        this.releaseFrame(message.requestId, message.captureEpoch);
        if (!this.capturing || message.captureEpoch !== this.captureEpoch) return;
        this.callbacks?.onPose({
          timestampMs: message.timestampMs,
          landmarks: message.landmarks,
          worldLandmarks: message.worldLandmarks,
          trackingState: 'degraded',
          bodyConfidence: this.confidence(message.landmarks),
          frameWidth: message.frameWidth,
          frameHeight: message.frameHeight,
        });
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'Falha no Worker de visão.');
      this.callbacks?.onStatus('error', error.message);
      this.completeInitialization(error);
      this.dispose();
    };
    worker.postMessage({ type: 'INIT', delegate: preferred, ...this.assets } satisfies WorkerRequest);
    let initializationTimeout: number | undefined;
    try {
      await Promise.race([
        initialized,
        new Promise<never>((_resolve, reject) => {
          initializationTimeout = window.setTimeout(() => {
            const error = new Error('Inicialização do MediaPipe excedeu 30 segundos.');
            if (this.worker === worker) {
              this.callbacks?.onStatus('error', error.message);
              this.completeInitialization(error);
              this.dispose();
            }
            reject(error);
          }, 30_000);
        }),
      ]);
    } catch (error) {
      if (this.worker === worker) this.dispose();
      throw error;
    } finally {
      if (initializationTimeout !== undefined) window.clearTimeout(initializationTimeout);
    }
  }

  private completeInitialization(error?: Error): void {
    const resolve = this.resolveInitialization;
    const reject = this.rejectInitialization;
    this.resolveInitialization = undefined;
    this.rejectInitialization = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private async capture(video: HTMLVideoElement, now: number): Promise<void> {
    if (this.inFlight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const requestId = this.nextRequestId++;
    const captureEpoch = this.captureEpoch;
    const frameRequest = { requestId, captureEpoch };
    this.inFlight = frameRequest;
    const timestampMs = Math.max(now, this.lastTimestamp + 0.01);
    this.lastTimestamp = timestampMs;
    // Owned by this thread until postMessage transfers it; cleared at that commit point.
    let bitmap: ImageBitmap | VideoFrame | undefined;
    try {
      // Synchronous when possible: no await means no session change can slip in before the post.
      bitmap = this.directFrame(video, timestampMs)
        ?? await createImageBitmap(video, {
          resizeWidth: this.activeDelegate === 'CPU' ? CPU_BITMAP_WIDTH : MAX_DIRECT_FRAME_WIDTH,
          resizeQuality: 'low',
        });
      if (!this.capturing || captureEpoch !== this.captureEpoch || !this.worker) {
        bitmap.close();
        this.releaseFrame(requestId, captureEpoch);
        return;
      }
      this.worker.postMessage({ type: 'FRAME', ...frameRequest, timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
      bitmap = undefined;
    } catch (error) {
      bitmap?.close();
      this.releaseFrame(requestId, captureEpoch);
      if (this.capturing && captureEpoch === this.captureEpoch) {
        this.callbacks?.onStatus('error', error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Undefined when the video needs downscaling or VideoFrame cannot be built from it. */
  private directFrame(video: HTMLVideoElement, timestampMs: number): VideoFrame | undefined {
    if (typeof VideoFrame === 'undefined' || !(video.videoWidth <= MAX_DIRECT_FRAME_WIDTH)) return undefined;
    try {
      // VideoFrame timestamps are integer microseconds.
      return new VideoFrame(video, { timestamp: Math.round(timestampMs * 1000) });
    } catch {
      return undefined;
    }
  }

  private releaseFrame(requestId: number, captureEpoch: number): void {
    if (this.inFlight?.requestId === requestId && this.inFlight.captureEpoch === captureEpoch) this.inFlight = undefined;
  }

  private confidence(points: PoseSnapshot['landmarks']): number {
    const indices = [11, 12, 23, 24];
    if (indices.some((index) => !points[index])) return 0;
    return Math.min(...indices.map((index) => {
      const point = points[index]!;
      const visibility = point.visibility ?? point.presence ?? 0;
      const presence = point.presence ?? point.visibility ?? 0;
      return Math.min(visibility, presence);
    }));
  }
}
