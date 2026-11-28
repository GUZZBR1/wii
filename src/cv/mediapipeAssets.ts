import type { PoseClientAssets } from '@nevergear/spatial-core';
import { FACE_MODEL_SHA8, HAND_MODEL_SHA8, MEDIAPIPE_WASM_VERSION, POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from '../lib/mediapipe';
import { preferredDelegate } from './delegate';

// The pinned runtime and model hashes stay in one place; this module turns them into URLs.
export { FACE_MODEL_SHA8, HAND_MODEL_SHA8, MEDIAPIPE_WASM_VERSION, POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 };

/** Off the page (tests, replays) there is no origin; relative paths still need a base to resolve. */
const origin = () => globalThis.location?.origin ?? 'http://localhost';

/** Version-addressed WASM directory, so the cache headers in `vercel.json` can be immutable. */
export function visionWasmUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}mediapipe/wasm-${MEDIAPIPE_WASM_VERSION}`, origin()).href;
}

/** Model filenames carry their content hash, so a new model is a new URL and never a stale cache hit. */
export function visionModelUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}mediapipe/models/${file}`, origin()).href;
}

export const poseAssets = (): PoseClientAssets => ({
  wasmBaseUrl: visionWasmUrl(),
  modelUrl: visionModelUrl(`pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`),
  cpuModelUrl: visionModelUrl(`pose_landmarker_lite.${POSE_MODEL_SHA8}.task`),
});

export const handModelUrl = () => visionModelUrl(`hand_landmarker.${HAND_MODEL_SHA8}.task`);
export const faceModelUrl = () => visionModelUrl(`face_landmarker.${FACE_MODEL_SHA8}.task`);

/** Fetches an asset into the HTTP cache without touching the network twice; failures are silent. */
function warm(url: string): void {
  void fetch(url).then((response) => (response.ok ? response.arrayBuffer() : undefined)).catch(() => undefined);
}

/**
 * Starts the downloads a task will need once the camera permission is already granted, so the first
 * frame does not wait for them: the module loader pair plus the model this delegate will actually
 * load (the CPU pose path uses the lite model). Safe to repeat — the fetches join the HTTP cache.
 */
export function warmVisionAssets(kind: 'pose' | 'hand'): void {
  const wasm = visionWasmUrl();
  const pose = poseAssets();
  const model = kind === 'hand' ? handModelUrl() : preferredDelegate() === 'CPU' && pose.cpuModelUrl ? pose.cpuModelUrl : pose.modelUrl;
  for (const url of [`${wasm}/vision_wasm_module_internal.js`, `${wasm}/vision_wasm_module_internal.wasm`, model]) warm(url);
}
