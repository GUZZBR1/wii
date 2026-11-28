# Technical feasibility and benchmark — photo/webcam-based Mii generation vs. manual creation

Date: November 28, 2026 · CV package analyzed: `@mediapipe/tasks-vision@1.2.3`

## 1. Context and technical question

The request was to replace the old drawing-canvas prototype on the home page with a complete **Mii Channel**-style creator (face, hair, eyebrows, eyes, nose, mouth, beard/mustache, glasses, height, build, colors, and name), including a real-time 3D preview. Before implementing it, we objectively assessed whether initial Mii generation from a photo or webcam should be included.

Production criteria evaluated:

1. **Initial bundle size (`dist/assets/index-*.js`)**: the website home page is static with Three.js; it must not load ML runtimes or models during initial page load.
2. **Frame rate (FPS) during continuous operation**: dozens of 3D Miis will move through the viewport; continuous per-frame face detection would compete for CPU/WebGL and reduce FPS.
3. **Memory and resource cleanup**: WebGL contexts, `ImageBitmap` objects, WASM heaps, and webcam `MediaStream` tracks must not leak after use.
4. **Compatibility and fallback**: Safari `< 17` (`OffscreenCanvas` without WebGL in a worker), machines without WebGL or using software GL (SwiftShader), poor lighting, and partial occlusion.
5. **Privacy**: processing must remain 100% on-device, with no photos sent to servers.

---

## 2. Measured inventory in the repository and build

Sizes measured from repository files and `npm run build`. Three.js and Mii code are placed in on-demand chunks.

| Artifact | Raw (bytes) | Gzip (bytes) | Role and notes |
| --- | --- | --- | --- |
| `dist/assets/index-*.js` | `525.63 kB` | `174.16 kB` | Main entry. Does not include `FaceLandmarker`. |
| `dist/assets/faceSuggestClient-*.js` | `14.17 kB` | `6.33 kB` | Loaded only when a photo/webcam suggestion is requested. |
| `dist/assets/face.worker-*.js` | `156.94 kB` | n/a | Ephemeral suggestion worker. |
| `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` | `155,990` B | `44,958` B | Library JavaScript runtime; loaded only on demand (in `face.worker.ts` or through the dynamic fallback). |
| `public/mediapipe/wasm-1.2.3/vision_wasm_module_internal.js` | `336,662` B | `81,289` B | Emscripten ES-module loader (**already shared** by the project; `immutable` cache). |
| `public/mediapipe/wasm-1.2.3/vision_wasm_module_internal.wasm` | `14,665,738` B (`14.67 MB`) | `4,165,889` B (`4.17 MB`) | Single WASM SIMD128 binary for all vision tasks (**already contains** `FaceLandmarkerGraphOptions`; no additional WASM for users who have already used `/app`). |
| `dist/mediapipe/models/face_landmarker.64184e22.task` | `3,758,596` B (`3.76 MB`) | `3,332,902` B (`3.33 MB`) | Official `float16` model verified against `SHA256SUMS` (`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`). Downloaded **only** when the user requests a photo/webcam suggestion. |

---

## 3. Comparison of five browser-based approaches

Latency and memory below are **estimates**, not `FaceLandmarker` measurements. They are based on the `@mediapipe/tasks-vision@1.2.3` runtime and local benchmarks measured in this repository (`docs/pesquisa-pipeline-cv.md` §7.5 and `docs/auditoria-mediapipe.md`), using the `face_landmarker.64184e22.task` model size (`3.76 MB` vs. `5.78 MB` for `pose_landmarker_lite.59929e1d.task`).

| Criterion | 1. Pure manual Mii Channel | 2. Lazy single-shot `FaceLandmarker` (`tasks-vision`) | 3. Lazy `FaceDetector` (`tasks-vision`) | 4. Canvas heuristics / `window.FaceDetector` | 5. Heavy ML (`face-api.js` / `@tensorflow/tfjs` / 3D reconstruction) |
| --- | --- | --- | --- | --- | --- |
| **Initial JavaScript bundle** | `+2–4 kB` gzip (schema/UI) | **`0 kB`** (ephemeral worker + dynamic `import()`) | **`0 kB`** (ephemeral worker) | `0–3 kB` | `+400 kB – 1.5 MB` JavaScript (or `+500 kB` when lazy-loaded) |
| **On-demand WASM** | `0 MB` | `14.67 MB` raw / `4.17 MB` gzip (**shared** with `/app`) | `14.67 MB` raw / `4.17 MB` gzip (shared) | `0 MB` | TF.js WebGL/WASM (`1.5–4 MB`) + backends |
| **On-demand model** | `0 MB` | `3.76 MB` (`3.33 MB` gzip, `face_landmarker.64184e22.task`) | `~230 kB` (BlazeFace short-range) | `0 MB` | `6.5–25 MB` (multiple `face-api` / FLAME/DECA shards) |
| **Cold initialization latency** | `0 ms` | `~250–350 ms` (CPU XNNPACK + WASM compilation in cache) | `~200–300 ms` | `< 5 ms` | `800–3,000 ms` (shard downloads + TF.js shaders) |
| **Inference latency** | `0 ms` | **Single-shot**: `~140 ms` on the first CPU call (`~20 ms` when warmed); **`0 FPS` after closing** | `~15–40 ms` (box + 6 points only) | `< 10 ms` (heuristic) / variable (Shape Detection API) | `250–1,500+ ms` per photo (or expensive continuous inference) |
| **Memory (RAM/VRAM)** | `< 1 MB` | Ephemeral peak of `~25–45 MB` during the shot; **released by calling `close()` + `worker.terminate()`** | Ephemeral peak of `~22–35 MB` | `< 5 MB` | `80–250+ MB` in WebGL/CPU tensors |
| **Mii quality** | **Exact control (100%)** | **High**: 478 landmarks (face oval, eye EAR, canthal tilt, eyebrows, nose, mouth, irises) + CIE Lab color sampling | **Insufficient**: only 6 keypoints (no jaw contour, eyelids, eyebrows, or irises) | **Not viable**: `window.FaceDetector` exists only behind a flag or in partial macOS/Android support (no stable Firefox/Safari support) and does not provide eye, mouth, or nose shape | High for generic 3D, but Nevergear styling is subtle (Mii enums) — severe overengineering |
| **Compatibility** | 100% of browsers | Chrome 91+, Firefox 89+, Safari 16.4+ (WASM SIMD128); **WebGL required** for `texImage2D`; Safari `< 17` uses a main-thread fallback | Same as #2 | `window.FaceDetector` has no standard cross-browser support | Requires WebGL2 or heavy WASM; often fails on entry-level mobile devices |
| **Privacy** | 100% local | **On-device** (the photo never leaves the device; MediaPipe’s ODML performance telemetry is documented in `THIRD_PARTY_NOTICES.md`) | Same as #2 | 100% local | On-device (but its weight discourages web use) |

---

## 4. Adopted architectural decision: manual-first hybrid + ephemeral single-shot worker

We adopted a **manual-first hybrid architecture with an on-demand single-shot `FaceLandmarker`**:

1. **The complete manual creator is the primary flow**: no camera, model, or WebGL dependency is needed to create, customize, randomize, and save the player’s Mii (`nevergear-mii-face-v1` for the face and `nevergear-player-mii-v1` for name, clothing, and build).
2. **Photo/webcam suggestions are fully lazy and ephemeral (`src/miis/faceSuggestClient.ts` + `src/miis/face.worker.ts`)**:
   - **0 KB in the initial bundle**: `@mediapipe/tasks-vision` is imported dynamically (`await import('@mediapipe/tasks-vision')`) only inside `face.worker.ts` (or in the dynamic main-thread fallback), never in `index-*.js`.
   - **0 FPS impact during continuous operation**: it uses `runningMode: 'IMAGE'` and `numFaces: 1`. Immediately after a single `detect(bitmap)` call, it runs `landmarker.close()`, `bitmap.close()`, `worker.terminate()`, and (in the webcam flow) `track.stop()`.
   - **Reuses repository infrastructure**: reuses `public/mediapipe/wasm-1.2.3/`, already cached with `Cache-Control: immutable` in `vercel.json`, and adds mandatory SHA-256 verification of `face_landmarker.64184e22.task` in `scripts/copy-mediapipe-wasm.mjs`.

### 4.1 Rationale for the default `CPU` delegate

As measured in `docs/pesquisa-pipeline-cv.md` §7.5 (Chromium 159) and `src/cv/delegate.ts`:

- On systems with software GL (SwiftShader/llvmpipe/VMs) or blocked drivers, MediaPipe’s `GPU` delegate spends **`~2,016 ms`** just compiling shaders on the first frame and then runs at `~96–197 ms/frame`.
- The `CPU` delegate (XNNPACK + SIMD128) initializes in **`~250–300 ms`** with a first frame in **`~142 ms`**, without compiling inference shaders and **without competing for the integrated GPU with Three.js’s `WebGLRenderer`**, which animates Miis on the home page.
- Therefore, `faceSuggestClient.ts` uses `preferredDelegate()` (`'CPU'` by default; `?delegate=gpu` is optional and falls back automatically to `'CPU'` in the worker).

### 4.2 WebGL requirement and fallback for Safari `< 17`

As verified in `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` (findings #2 and #3 in `docs/auditoria-mediapipe.md`):

- **WebGL is required even with the `CPU` delegate**: every input image goes through `$h()` → `gl.texImage2D` on an internal WebGL canvas before reaching the XNNPACK graph. For that reason, `face.worker.ts` and the fallback check `getContext('webgl2') ?? getContext('webgl')` before downloading the `3.76 MB` `.task` file, failing cleanly with `FaceSuggestError('WEBGL_UNAVAILABLE', ...)`.
- **Safari `< 17` (`Oh()` in `vision_bundle.mjs`)**: the internal `Oh()` function rejects `OffscreenCanvas` when the User-Agent is Safari `< 17` (including Safari 16.4, which exposes `OffscreenCanvas` without WebGL), causing the `GraphRunner` to call `document.createElement('canvas')` — which throws a `ReferenceError` inside Web Workers. `canUseFaceWorker()` in `faceSuggestClient.ts` mirrors `Oh()` exactly and routes Safari `< 17` (or environments without `OffscreenCanvas`/`Worker`) to a single-shot main-thread fallback via `import('@mediapipe/tasks-vision')`, closing `landmarker.close()` in `finally`.

### 4.3 Pure geometric and colorimetric mapping (`src/miis/photoToMii.ts`)

To ensure deterministic testability in Vitest (`environment: 'node'`) and complete decoupling from DOM/Three.js/MediaPipe:

- `faceSuggestClient.ts` resizes the photo/frame to at most `512 px` on a 2D `<canvas>`, reads `ImageData` on the main thread, and transfers the `ImageBitmap` to the worker without copying.
- `photoToMii.ts` applies:
  1. **Isotropic aspect-ratio correction** (`x * aspectRatio`) to prevent distortion of `cheekW / faceH` in `16:9` webcams or `3:4` portraits.
  2. **Roll de-rotation** by aligning the interocular line (`33` → `263`) before classifying `headShape`, `eyeStyle`, `eyebrowStyle`, `noseStyle`, and `mouthStyle`.
  3. **CIE Lab perceptual quantization (`ΔE76`)** to map skin, hair, iris, and clothing samples to the official palettes in `src/miis/miiTypes.ts`.
  4. **Graceful degradation**:
     - `< 468` landmarks or a tiny face (`faceH < 0.08`) → `FaceSuggestError('NO_FACE_DETECTED', ...)` without corrupting the current draft.
     - Forehead cut off at the top (`L[10].y < 0.08`) → preserve `baseProfile.hairStyle` and show a warning instead of incorrectly classifying the player as bald.
     - Severe side tilt (`yawBalance < 0.6`) → lower `confidence` and emit a warning.
     - Closed/blinking eye (`wink`) or dark glasses (`sunglasses`) → preserve `baseProfile.eyeColor`.

---

## 5. Conclusion and criteria for reevaluation

The **manual-first hybrid + lazy single-shot `FaceLandmarker`** approach meets the request:

- **Zero cost** during initial home-page load (`0 kB` of `@mediapipe/tasks-vision` in `index-*.js`) and **zero continuous FPS cost** while 3D Miis move around.
- **Real photo/webcam suggestions** with an editable draft in the Mii Channel creator when the user opts in, while the **complete manual creator** remains available if WebGL is missing, the model fails, or no face is detected.
- If the website adopts a restrictive CSP in the future, `connect-src` must include MediaPipe’s embedded ODML telemetry endpoint (`odml.pa.googleapis.com/v1/log`, already documented in `THIRD_PARTY_NOTICES.md`).
