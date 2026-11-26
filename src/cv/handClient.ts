import { HandClient as CoreHandClient, type HandClientAssets, type HandSnapshot } from '@wii/spatial-core';
import { HAND_MODEL_SHA8, MEDIAPIPE_WASM_VERSION } from './mediapipeAssets';

export type { HandClientCallbacks } from '@wii/spatial-core';

function defaultHandAssets(): HandClientAssets {
  const base = `${import.meta.env.BASE_URL}mediapipe`;
  const wasmBaseUrl = new URL(`${base}/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href;
  return {
    wasmBaseUrl,
    modelUrl: new URL(`${base}/models/hand_landmarker.${HAND_MODEL_SHA8}.task`, location.origin).href,
  };
}

export class HandClient extends CoreHandClient {
  private captureSession = 0;
  private rafId?: number;
  private callbackId?: number;
  private captureInFlight?: object;
  private lastVideoTime = -1;
  private video?: HTMLVideoElement;

  constructor(assets: HandClientAssets = defaultHandAssets()) {
    super(assets);
  }

  static warmVisionAssets(): void {
    const { wasmBaseUrl, modelUrl } = defaultHandAssets();
    const urls = [
      `${wasmBaseUrl}/vision_wasm_module_internal.js`,
      `${wasmBaseUrl}/vision_wasm_module_internal.wasm`,
      modelUrl,
    ];
    for (const url of urls) {
      void fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : undefined))
        .catch(() => undefined);
    }
  }

  beginCapture(
    video: HTMLVideoElement,
    onHand: (snapshot: HandSnapshot, aspectY?: number) => void,
    onError?: (error: Error) => void,
  ): void {
    this.pauseCapture();
    const session = this.captureSession;
    this.video = video;
    this.lastVideoTime = -1;

    const capture = async (now: number): Promise<void> => {
      if (this.captureSession !== session) return;
      if (this.captureInFlight || !this.isReady) return;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0)
        return;

      const aspectY = video.videoHeight / video.videoWidth;
      const flight = {};
      this.captureInFlight = flight;
      let bitmap: ImageBitmap | undefined;
      try {
        bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'low' });
        if (this.captureSession !== session) {
          bitmap.close();
          return;
        }
        const frame = bitmap;
        bitmap = undefined;
        const snapshot = await this.processFrame(frame, now);
        if (this.captureSession === session && snapshot) onHand(snapshot, aspectY);
      } catch (error) {
        bitmap?.close();
        if (this.captureSession === session) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (this.captureInFlight === flight) this.captureInFlight = undefined;
      }
    };

    const schedule = () => {
      if (this.captureSession !== session) return;
      const supportsVideoFrameCallback =
        typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback ===
        'function';
      if (supportsVideoFrameCallback) {
        this.callbackId = video.requestVideoFrameCallback((now) => {
          schedule();
          void capture(now);
        });
      } else {
        this.rafId = window.requestAnimationFrame(() => {
          schedule();
          if (video.currentTime !== this.lastVideoTime) {
            this.lastVideoTime = video.currentTime;
            void capture(performance.now());
          }
        });
      }
    };
    schedule();
  }

  pauseCapture(): void {
    this.captureSession += 1;
    if (this.callbackId !== undefined) this.video?.cancelVideoFrameCallback?.(this.callbackId);
    this.callbackId = undefined;
    if (this.rafId !== undefined) window.cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
    this.video = undefined;
  }

  override dispose(): void {
    this.pauseCapture();
    super.dispose();
  }
}
