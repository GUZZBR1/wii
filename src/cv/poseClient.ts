import { PoseClient as CorePoseClient } from '@wii/spatial-core';
import type { Delegate, PoseClientAssets, PoseClientCallbacks as CoreCallbacks } from '@wii/spatial-core';
import { preferredDelegate } from './delegate';
import { MEDIAPIPE_WASM_VERSION, POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from './mediapipeAssets';

export type { PoseClientCallbacks } from '@wii/spatial-core';

/** Production accuracy is calibrated on the lite model, so lite is the default on both
 *  delegates — GPU+lite is also the fastest path on machines whose CPU starves inference.
 *  `?modelo=full` opts into the heavier model on either delegate. */
export function preferredModelUrls(base: string, search: string = globalThis.location?.search ?? ''): { modelUrl: string; cpuModelUrl: string } {
  const lite = new URL(`${base}/models/pose_landmarker_lite.${POSE_MODEL_SHA8}.task`, location.origin).href;
  const full = new URL(`${base}/models/pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`, location.origin).href;
  const useFull = new URLSearchParams(search).get('modelo') === 'full';
  return useFull ? { modelUrl: full, cpuModelUrl: full } : { modelUrl: lite, cpuModelUrl: lite };
}

function defaultPoseAssets(): PoseClientAssets {
  const base = `${import.meta.env.BASE_URL}mediapipe`;
  const wasmBaseUrl = new URL(`${base}/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href;
  return {
    wasmBaseUrl,
    ...preferredModelUrls(base),
  };
}

export class PoseClient extends CorePoseClient {
  constructor(assets: PoseClientAssets = defaultPoseAssets()) {
    super(assets);
  }

  override init(callbacks: CoreCallbacks, preferred: Delegate = preferredDelegate()): Promise<void> {
    return super.init(callbacks, preferred);
  }

  static warmVisionAssets(): void {
    const { wasmBaseUrl, modelUrl } = defaultPoseAssets();
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
}
