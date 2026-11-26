import { PoseClient as CorePoseClient } from '@wii/spatial-core';
import type { PoseClientAssets } from '@wii/spatial-core';
import { MEDIAPIPE_WASM_VERSION, POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from './mediapipeAssets';

export type { PoseClientCallbacks } from '@wii/spatial-core';

function defaultPoseAssets(): PoseClientAssets {
  const base = `${import.meta.env.BASE_URL}mediapipe`;
  const wasmBaseUrl = new URL(`${base}/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href;
  return {
    wasmBaseUrl,
    modelUrl: new URL(`${base}/models/pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`, location.origin).href,
    cpuModelUrl: new URL(`${base}/models/pose_landmarker_lite.${POSE_MODEL_SHA8}.task`, location.origin).href,
  };
}

export class PoseClient extends CorePoseClient {
  constructor(assets: PoseClientAssets = defaultPoseAssets()) {
    super(assets);
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
