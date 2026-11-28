/**
 * Pinned MediaPipe runtime, models and their content hashes. `scripts/copy-mediapipe-wasm.mjs`
 * copies exactly this WASM version and verifies every model against `public/mediapipe/SHA256SUMS`,
 * so no browser code touches the CDN and versioned URLs stay safe to cache forever.
 */
export const MEDIAPIPE_WASM_VERSION = '1.2.3';
export const POSE_MODEL_SHA8 = '59929e1d';
export const POSE_FULL_MODEL_SHA8 = '5134a3aa';
export const HAND_MODEL_SHA8 = 'fbc2a300';
export const FACE_MODEL_SHA8 = '64184e22';
