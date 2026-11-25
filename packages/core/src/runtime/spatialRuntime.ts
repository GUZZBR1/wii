import type { HandClientCallbacks, HandClientAssets } from '../providers/handClient';
import { HandClient } from '../providers/handClient';
import type { HandSnapshot } from '../providers/handProtocol';
import { PoseClient } from '../providers/poseClient';
import type { PoseClientAssets } from '../providers/poseClient';
import type { Delegate, PoseSnapshot } from '../types';

export type PerceptionContext = 'hand' | 'pose';
export type RuntimeStatus = 'loading' | 'ready' | 'fallback' | 'error';

export type SpatialObservation =
  | { source: 'hand'; snapshot: HandSnapshot }
  | { source: 'pose'; snapshot: PoseSnapshot };

export interface PoseProviderCallbacks {
  onPose(snapshot: PoseSnapshot): void;
  onStatus(status: RuntimeStatus, detail: string): void;
}

export interface HandProviderClient {
  readonly isReady: boolean;
  init(callbacks: HandClientCallbacks, preferred?: Delegate): Promise<void>;
  processFrame(bitmap: ImageBitmap, timestampMs: number): Promise<HandSnapshot | undefined>;
  dispose(): void;
}

export interface PoseProviderClient {
  readonly isReady: boolean;
  init(callbacks: PoseProviderCallbacks, preferred?: Delegate): Promise<void>;
  beginCapture(video: HTMLVideoElement, callbacks: PoseProviderCallbacks): void;
  pauseCapture(): void;
  dispose(): void;
}

export interface SpatialRuntimeCallbacks {
  onObservation(observation: SpatialObservation): void;
  onStatus(context: PerceptionContext, status: RuntimeStatus, detail: string): void;
}

export interface SpatialRuntimeOptions extends SpatialRuntimeCallbacks {
  video: HTMLVideoElement;
  handAssets: HandClientAssets;
  poseAssets?: PoseClientAssets;
  preferredDelegate?: Delegate;
  createHandClient?: () => HandProviderClient;
  createPoseClient?: () => PoseProviderClient;
}

type ActiveProvider = { context: 'hand'; client: HandProviderClient } | { context: 'pose'; client: PoseProviderClient };

interface HandCaptureSession {
  epoch: number;
  video: HTMLVideoElement;
  client: HandProviderClient;
  capturing: boolean;
  busy: boolean;
  callbackId?: number;
  rafId?: number;
  lastVideoTime: number;
  lastTimestamp: number;
}

type VideoFrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface InitializationStatus {
  errorReported: boolean;
}

const HAVE_CURRENT_DATA = 2;

/** Switches headless perception contexts and forwards typed observations from the active provider. */
export class SpatialRuntime {
  private readonly video: HTMLVideoElement;
  private readonly handAssets: HandClientAssets;
  private readonly preferredDelegate: Delegate;
  private readonly callbacks: SpatialRuntimeCallbacks;
  private readonly createHandClient: () => HandProviderClient;
  private readonly createPoseClient?: () => PoseProviderClient;
  private active?: ActiveProvider;
  private handCapture?: HandCaptureSession;
  private generation = 0;
  private activation?: { context: PerceptionContext; generation: number; promise: Promise<boolean> };

  constructor(options: SpatialRuntimeOptions) {
    this.video = options.video;
    this.handAssets = options.handAssets;
    this.preferredDelegate = options.preferredDelegate ?? 'GPU';
    this.callbacks = { onObservation: options.onObservation, onStatus: options.onStatus };
    this.createHandClient = options.createHandClient ?? (() => new HandClient(this.handAssets));
    const poseAssets = options.poseAssets;
    this.createPoseClient = options.createPoseClient ?? (poseAssets ? () => new PoseClient(poseAssets) : undefined);
  }

  get activeContext(): PerceptionContext | undefined {
    return this.active?.client.isReady ? this.active.context : undefined;
  }

  activate(context: PerceptionContext): Promise<boolean> {
    if (this.active?.context === context && this.active.client.isReady) return Promise.resolve(true);
    if (this.activation?.context === context) return this.activation.promise;

    const generation = ++this.generation;
    this.activation = undefined;
    this.disposeActive();
    const promise = Promise.resolve().then(() => this.initializeContext(context, generation));
    this.activation = { context, generation, promise };
    const clearActivation = () => {
      if (this.activation?.generation === generation) this.activation = undefined;
    };
    void promise.then(clearActivation, clearActivation);
    return promise;
  }

  deactivate(): void {
    this.generation += 1;
    this.activation = undefined;
    this.disposeActive();
  }

  dispose(): void {
    this.deactivate();
  }

  private async initializeContext(context: PerceptionContext, generation: number): Promise<boolean> {
    let active: ActiveProvider;
    try {
      if (context === 'hand') {
        active = { context, client: this.createHandClient() };
      } else if (this.createPoseClient) {
        active = { context, client: this.createPoseClient() };
      } else {
        throw new Error('A pose provider adapter must be supplied to activate the pose context.');
      }
    } catch (error) {
      if (generation === this.generation) {
        this.callbacks.onStatus(context, 'error', error instanceof Error ? error.message : String(error));
      }
      return false;
    }
    this.active = active;

    const initializationStatus: InitializationStatus = { errorReported: false };
    let initialization: Promise<void>;
    try {
      if (active.context === 'hand') {
        initialization = active.client.init(
          this.handCallbacks(active, generation, initializationStatus),
          this.preferredDelegate,
        );
      } else {
        initialization = active.client.init(
          this.poseCallbacks(active, generation, initializationStatus),
          this.preferredDelegate,
        );
      }
      if (!this.isCurrent(active, generation)) active.client.dispose();
      await initialization;
    } catch (error) {
      if (this.isCurrent(active, generation)) {
        this.disposeActive();
        if (!initializationStatus.errorReported) {
          this.callbacks.onStatus(context, 'error', error instanceof Error ? error.message : String(error));
        }
      }
      return false;
    }

    if (!this.isCurrent(active, generation)) return false;
    if (!active.client.isReady) {
      this.disposeActive();
      if (!initializationStatus.errorReported) {
        this.callbacks.onStatus(
          context,
          'error',
          'Perception provider finished initialization without becoming ready.',
        );
      }
      return false;
    }
    if (active.context === 'pose') {
      active.client.beginCapture(this.video, this.poseCallbacks(active, generation));
    } else {
      this.startHandCapture(active, generation);
    }
    return true;
  }

  private handCallbacks(
    active: ActiveProvider,
    generation: number,
    initializationStatus: InitializationStatus,
  ): HandClientCallbacks {
    return {
      onStatus: (status, detail) => {
        if (status === 'error') initializationStatus.errorReported = true;
        if (this.isCurrent(active, generation)) this.callbacks.onStatus('hand', status, detail);
      },
    };
  }

  private poseCallbacks(
    active: ActiveProvider,
    generation: number,
    initializationStatus?: InitializationStatus,
  ): PoseProviderCallbacks {
    return {
      onPose: (snapshot) => {
        if (this.isCurrent(active, generation)) this.callbacks.onObservation({ source: 'pose', snapshot });
      },
      onStatus: (status, detail) => {
        if (status === 'error' && initializationStatus) initializationStatus.errorReported = true;
        if (this.isCurrent(active, generation)) this.callbacks.onStatus('pose', status, detail);
      },
    };
  }

  private isCurrent(active: ActiveProvider, generation: number): boolean {
    return this.active === active && this.generation === generation;
  }

  private startHandCapture(active: Extract<ActiveProvider, { context: 'hand' }>, generation: number): void {
    const session: HandCaptureSession = {
      epoch: generation,
      video: this.video,
      client: active.client,
      capturing: true,
      busy: false,
      lastVideoTime: -1,
      lastTimestamp: 0,
    };
    this.handCapture = session;
    this.scheduleHandFrame(session);
  }

  private scheduleHandFrame(session: HandCaptureSession): void {
    if (!session.capturing || session.epoch !== this.generation) return;
    const video = session.video as VideoFrameCallbackVideo;
    if (typeof video.requestVideoFrameCallback === 'function') {
      session.callbackId = video.requestVideoFrameCallback((now) => {
        session.callbackId = undefined;
        this.scheduleHandFrame(session);
        void this.captureHandFrame(session, now);
      });
      return;
    }
    session.rafId = requestAnimationFrame(() => {
      session.rafId = undefined;
      this.scheduleHandFrame(session);
      if (session.video.currentTime !== session.lastVideoTime) {
        session.lastVideoTime = session.video.currentTime;
        void this.captureHandFrame(session, performance.now());
      }
    });
  }

  private async captureHandFrame(session: HandCaptureSession, now: number): Promise<void> {
    if (
      !session.capturing ||
      session.epoch !== this.generation ||
      this.handCapture !== session ||
      session.busy ||
      session.video.readyState < HAVE_CURRENT_DATA
    ) {
      return;
    }
    session.busy = true;
    const timestampMs = Math.max(now, session.lastTimestamp + 0.01);
    session.lastTimestamp = timestampMs;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(session.video, { resizeWidth: 640, resizeQuality: 'low' });
      if (!this.isCurrentHandSession(session)) return;
      const processing = session.client.processFrame(bitmap, timestampMs);
      bitmap = undefined;
      const snapshot = await processing;
      if (snapshot && this.isCurrentHandSession(session)) {
        this.callbacks.onObservation({ source: 'hand', snapshot });
      }
    } catch (error) {
      if (this.isCurrentHandSession(session)) {
        this.callbacks.onStatus('hand', 'error', error instanceof Error ? error.message : String(error));
      }
    } finally {
      bitmap?.close();
      session.busy = false;
    }
  }

  private isCurrentHandSession(session: HandCaptureSession): boolean {
    return session.capturing && session.epoch === this.generation && this.handCapture === session;
  }

  private disposeActive(): void {
    this.stopHandCapture();
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    if (active.context === 'pose') {
      active.client.pauseCapture();
      active.client.dispose();
    } else {
      active.client.dispose();
    }
  }

  private stopHandCapture(): void {
    const session = this.handCapture;
    this.handCapture = undefined;
    if (!session) return;
    session.capturing = false;
    const video = session.video as VideoFrameCallbackVideo;
    if (session.callbackId !== undefined) video.cancelVideoFrameCallback?.(session.callbackId);
    if (session.rafId !== undefined) cancelAnimationFrame(session.rafId);
  }
}
