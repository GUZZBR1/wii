import { type Delegate, HandClient as CoreHandClient, type HandClientAssets, type HandClientCallbacks, type HandSnapshot } from '@wii/spatial-core';
import { preferredDelegate } from './delegate';
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
  private rafId = 0;
  private captureInFlight = false;
  private lastVideoTime = -1;

  constructor(assets: HandClientAssets = defaultHandAssets()) {
    super(assets);
  }

  override init(callbacks: HandClientCallbacks, preferred: Delegate = preferredDelegate()): Promise<void> {
    return super.init(callbacks, preferred);
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
    this.lastVideoTime = -1;

    const tick = () => {
      if (this.captureSession !== session) return;
      this.rafId = window.requestAnimationFrame(tick);

      if (this.captureInFlight || !this.isReady) return;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      if (video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;

      const aspectY = video.videoHeight / video.videoWidth;
      const timestampMs = performance.now();
      this.captureInFlight = true;
      void createImageBitmap(video)
        .then((bitmap) => {
          if (this.captureSession !== session) {
            bitmap.close();
            return undefined;
          }
          return this.processFrame(bitmap, timestampMs);
        })
        .then((snapshot) => {
          if (this.captureSession === session && snapshot) onHand(snapshot, aspectY);
        })
        .catch((error: unknown) => {
          if (this.captureSession === session) {
            onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        })
        .finally(() => {
          if (this.captureSession === session) this.captureInFlight = false;
        });
    };

    this.rafId = window.requestAnimationFrame(tick);
  }

  pauseCapture(): void {
    this.captureSession += 1;
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.captureInFlight = false;
  }

  override dispose(): void {
    this.pauseCapture();
    super.dispose();
  }
}
