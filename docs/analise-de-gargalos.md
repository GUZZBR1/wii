# Bottleneck Analysis — Nevergear Web Sports Arena

Date: November 25, 2026 · Commit analyzed: `d455ebc` ("Make the game the whole site")

---

## What this project is

**Nevergear Web Sports Arena** is a browser arcade ("your body is the controller") with two mini-games — **Hurdle Rush** (three-lane obstacle running) and **Baseline Rally** (arcade tennis) — controlled by body pose captured through a webcam, with no video sent to a server. Stack: Vite 8 + React 19 + strict TypeScript + Three.js 0.187 + `@mediapipe/tasks-vision` 1.2.3 (`package.json`), deployed as a static site on Vercel (`vercel.json`).

The end-to-end pipeline, as implemented in the code:

1. **Camera** — `startCamera()` (`src/App.tsx:79-117`) requests `getUserMedia` at 640×480 @ 30 fps (`src/App.tsx:82-85`), connects the PiP's `<video>` (`src/ui/CameraPip.tsx:23`), and waits for `loadeddata`.
2. **Capture client** — `PoseClient.start()` (`src/cv/poseClient.ts:20-89`) creates a **module worker** (`new Worker(..., { type: 'module' })`, `poseClient.ts:28`), sends `INIT` with the local WASM URLs and the Lite model hosted under `public/mediapipe/` (`poseClient.ts:56-60`), and schedules capture through `requestVideoFrameCallback` (rVFC), falling back to `requestAnimationFrame` plus a comparison of `video.currentTime` (`poseClient.ts:70-88`). The policy allows **one frame in flight**: while `busy`, new frames are silently dropped (`poseClient.ts:94-96`).
3. **Vision worker** — `pose.worker.ts` calls `FilesetResolver.forVisionTasks(wasmBaseUrl)` + `PoseLandmarker.createFromOptions` with `delegate: 'GPU'`, `runningMode: 'VIDEO'`, `numPoses: 1` (`src/cv/pose.worker.ts:11-24`), with automatic fallback to CPU (`pose.worker.ts:32-46`). Each `FRAME` message carries an `ImageBitmap` transferred through `postMessage` (`poseClient.ts:101-104`); the worker calls `detectForVideo(bitmap, timestampMs)`, measures `inferenceMs`, returns 33+33 simplified landmarks (`pose.worker.ts:80-88`), and closes the bitmap in `finally` (`pose.worker.ts:98`).
4. **Kinematics** — on the main thread, `ActionPipeline.update()` (`src/kinematics/actionPipeline.ts:17-37`) applies `TrackingGate` (3 good frames → `tracked`, 4 bad frames → `lost`, `trackingGate.ts:13-24`), then pure detectors: `CadenceTracker` (steps/cadence → runner speed, `cadenceTracker.ts`), `JumpDetector` (jump from hip rise, `jumpDetector.ts`), `LaneLeanDetector` (lane change from torso lean, `postureSignals.ts:11-28`), and `SwingDetector` (racket swing from wrist velocity in world coordinates, `swingDetector.ts`). All use a 1-Euro filter (`src/cv/oneEuroFilter.ts`) and hysteresis (`schmittTrigger.ts`) — inexpensive math with no Three.js dependency.
5. **Games** — `GameCanvas` code-splits by sport through dynamic `import()` (`src/ui/GameCanvas.tsx:31-33`) and instantiates `TrackGame`/`TennisGame`, which run in a fixed-step 1/60 `GameLoop` with a capped accumulator and `renderer.setAnimationLoop` (`src/games/core/GameLoop.ts:43-56`). CV events become `onAction` callbacks in the games; the HUD is published at 5 Hz with change detection (`TrackGame.ts:125-131`, `TennisGame.ts:73-79`).
6. **UI** — full screen: game canvas, sport selector + mute control (`hud-dock`), and camera PiP with a skeleton over the video (`drawPose`, `src/ui/PoseOverlay.ts`) and calibration buttons. Calibration records 3 s of neutral pose and requires ≥12 `tracked` samples, a span of ≥2.8 s, and ≥65% valid frames (`src/cv/calibrator.ts:22-51`).

Tests: `tests/kinematics.test.ts` covers the detectors with synthetic fixtures (7 tests, all passing during this analysis).

---

## Executive summary

| # | Bottleneck | Severity | Confidence |
|---|-----------|----------|------------|
| 1 | **The camera never initializes**: `forVisionTasks` is called without `useModule` inside a module worker → `importScripts` throws `TypeError` → the classic loader's `await import` does not define `self.ModuleFactory` → INIT fails on both GPU and CPU. Reproduced live in a production build in real Chromium. | **Critical (feature is dead)** | Certain (reproduced) |
| 2 | **~20 MB of CV assets + a serial startup chain** (click → permission → play → worker → fetch+compile 14.7 MB WASM → fetch 5.8 MB model → graph initialization → 3 s calibration). | High | Certain (measured in `dist/`) |
| 3 | **Weak Vercel caching for `/mediapipe/*`**: files have no hashes in their names → default `max-age=0, must-revalidate`; `.task` is outside the compression list → ~5.8 MB without gzip. | High (return visits) | High (official docs) |
| 4 | **Safari < 17 still has no CV after the fix**: MediaPipe's GraphRunner requires `OffscreenCanvas` in a worker on Safari ≥ 17; below that it falls back to a path that uses `document`, which does not exist in a worker. | High (iOS < 17) | High (bundle code) |
| 5 | **Worker respawn on each camera toggle**: `stop()` terminates the worker; each `start()` fetches the WASM again, recompiles 14.7 MB, and initializes the graph again. | Medium | Certain (code) |
| 6 | **Dead weight in the deployment**: the second WASM variant (`vision_wasm_module_internal.*`, ~15 MB) is copied and published without ever being loaded in the current configuration (and the classic variant becomes dead weight after the fix). | Medium (deployment) | Certain |
| 7 | **CV throughput ceiling by design**: one frame in flight + synchronous `detectForVideo` → effective fps ≈ min(30, 1000/round-trip); on CPU fallback or weak GPU, the game receives ~10–25 poses/s. | Medium | High |
| 8 | **`createImageBitmap` per frame** on the main thread before sending — a 640×480 copy per frame; currently mostly a no-op resize. | Low | Certain |

> Note on accuracy: finding #1 is a **correctness bug**, not merely a performance issue — but it is by far the product's biggest "bottleneck": 0% of the CV pipeline works today.

---

## Bottlenecks

### 1. (TOTAL BLOCKER) `forVisionTasks` without `useModule` inside a module worker — the camera never starts

**What it is.** `poseClient.ts:28` creates the worker with `{ type: 'module' }`. The worker calls `FilesetResolver.forVisionTasks(wasmBaseUrl)` with one argument (`src/cv/pose.worker.ts:12`). In `node_modules/@mediapipe/tasks-vision/vision.d.ts:819`, the signature is `forVisionTasks(basePath?, useModule?)`. With `useModule` omitted (`false`), the resolver points to `vision_wasm_internal.js` — the **classic** loader variant.

**Failure chain (verified in the `vision_bundle.mjs` code and the `dist/` build):**

1. The loader calls `importScripts(url)` to load `vision_wasm_internal.js`. `importScripts` exists on every `WorkerGlobalScope`, but **throws `TypeError` in module workers** — MDN: "TypeError — Thrown if the current WorkerGlobalScope is a module"; HTML Standard: "the `importScripts()` method will automatically fail inside module workers".
2. MediaPipe's `catch` handles `TypeError` as a "module environment" and falls back to `await import(url)` of the **same file**.
3. `vision_wasm_internal.js` declares `var ModuleFactory = (() => { ... })()` + UMD exports (`module.exports`/`define`), with **no** ESM `export`. Imported as a module, `var` is scoped to the module and the returned namespace is empty — `self.ModuleFactory` is never defined (verified in Node 24: `await import(...)` → `globalThis.ModuleFactory === undefined`, namespace `{}`).
4. The resolver then throws `Error("ModuleFactory not set.")` → `createTask('GPU')` fails → `fallback()` tries `createTask('CPU')` → the same failure point → `ERROR fatal init`.

**Empirical evidence (real headless Chromium through Playwright, with `dist/` served over HTTP):** when the compiled `pose.worker` is instantiated with the exact `INIT` message used by the app, the response is:

```json
{ "type": "ERROR", "stage": "init", "fatal": true,
  "message": "GPU failed (ModuleFactory not set.); CPU fallback also failed (ModuleFactory not set.)." }
```

and the probe confirms that `importScripts` throws `TypeError: Module scripts don't support importScripts()` in the module worker. In the UI, `onStatus('error')` → `stopCamera()` (`src/App.tsx:102`) — the user sees an error message and the camera remains off. The bug has existed since the first commit (`git log`), in development and production — the camera path has probably never been exercised end to end.

**Proof of the fix:** in the same harness, a module worker running `FilesetResolver.forVisionTasks(wasmBaseUrl, /* useModule */ true)` + `PoseLandmarker.createFromOptions` with `delegate: 'GPU'` initialized successfully ("Graph successfully started running", ~228 ms after the model fetch, WebGL2/SwiftShader). The `vision_wasm_module_internal.js` variant exists for exactly this purpose: `async function ModuleFactory(...)`, `globalThis.ModuleFactory = ModuleFactory`, and `export default` — verified in `node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js` (file header and footer).

**Impact:** 100% of the flagship feature (body control) is unavailable; only the keyboard works.

**Fix direction:** pass `true` as the second argument to `forVisionTasks` — one parameter fixes it. Alternative: instantiate the worker as classic, but `{ type: 'module' }` is the pattern recommended by Vite and keeps the bundle's `import` statements (vite.dev/guide/features → "Web Workers"). A smoke test that sends `INIT` to the compiled worker would also prevent regression.

### 2. Serial startup chain + ~20 MB of CV assets on a cold visit

**What it is.** The path to the first pose is strictly serial (`src/App.tsx:81-99`, `src/cv/poseClient.ts:20-70`):

click → `audio.unlock()` → `getUserMedia` (permission + device probe) → `video.play()` → wait for `loadeddata` → `new Worker` (parse 156 KB) → `importScripts`/import the WASM loader (337 KB) → **fetch `.wasm` (14 665 716 B)** → compile → **`fetch(modelUrl)` (5 777 746 B)** → `createFromOptions` → `READY` → 3-frame gate → 3 s calibration.

**Measurements from `dist/` and `public/`:**

| Asset | Raw size | gzip -9 |
|---|---|---|
| `mediapipe/wasm/vision_wasm_internal.wasm` | 14 665 716 B (14.0 MiB) | 4 147 452 B |
| `mediapipe/wasm/vision_wasm_internal.js` | 336 624 B | 80 992 B |
| `mediapipe/models/pose_landmarker_lite.task` | 5 777 746 B (5.5 MiB) | 4 969 689 B (~14% smaller) |
| `assets/pose.worker-*.js` | 155 905 B | ~45.4 KB |
| `mediapipe/wasm/vision_wasm_module_internal.{js,wasm}` | 15 002 362 B | published, unused |

Total fetched to activate the camera on a cold visit: ~9.3 MB compressed / ~20.7 MB raw — and only after the user grants camera access. On a typical mobile connection (~10 Mb/s), that is ~7–8 s of network time + ~0.5–2 s of WASM compilation + graph initialization + 3 s of calibration. None of this is parallelized with waiting for camera permission, which is usually the slowest part and does not depend on the files.

**Why this is a bottleneck:** time to the first playable input easily exceeds 5–10 s; every extra second of waiting in the "activate camera" flow is pure abandonment in a hackathon demo.

**Fix direction:**
- Start the worker (fetch + compile WASM + fetch the model) **in parallel with `getUserMedia`** — MediaPipe initialization does not need camera frames.
- Warm the cache with `<link rel="preload" as="fetch">` or an idle `fetch()` after first paint for `vision_wasm_internal.wasm` and the `.task` model — streaming WASM compilation (`compileStreaming`) depends on the `application/wasm` MIME type (Vercel serves it correctly).
- The model can be fetched by MediaPipe itself through `modelAssetPath` (the bundle already implements an internal `fetch`, `vision_bundle.mjs`) — this lets us discard the manual copy to `Uint8Array` + `FS_createDataFile` (~5.8 MB memcpy), or retain `modelAssetBuffer` for control — either way, the cost is low.

### 3. Vercel caching and compression for `/mediapipe/*`

**What it is.** `vercel.json` (`vercel.json:1-5`) defines only the framework/build/output — no `headers`. CV assets live in `public/mediapipe/` and are copied to `dist/` without hashes in their names.

**External evidence (official Vercel docs read during this analysis):**

- `vercel.com/docs/caching/cache-control-headers`: **"The default value is `cache-control: public, max-age=0, must-revalidate`"** — browsers and the CDN do not retain the resource; each visit revalidates it (a 304 if lucky, a cold download otherwise).
- `vercel.com/docs/edge-network/caching` (canonical `/docs/caching/cdn-cache`): static files are cached on the CDN "for the lifetime of the deployment after the first request" — in other words, the first user at each POP pays the full origin cost.
- `vercel.com/docs/how-vercel-cdn-works/compression`: the compressible MIME list includes **`application/wasm`** → the 14.7 MB `.wasm` travels at ~4.1 MB (gzip measured locally; Brotli tends to be smaller). `.task` files are not on the list → `pose_landmarker_lite.task` probably travels **uncompressed** at its 5.78 MB raw size (marked as probable, not verified on a real deployment — see open questions).

**Impact:** each visit pays at least one revalidation for ~20 MB of binaries, and the model travels ~16% larger than it could.

**Fix direction:**
- Add `headers` to `vercel.json`: `Cache-Control: public, max-age=31536000, immutable` for `/mediapipe/(.*)` — safe because the content is effectively versioned: `prebuild` pins the package version and validates the model SHA-256 (`scripts/copy-mediapipe-wasm.mjs`), so a content change implies a deployment change.
- Alternative/robustness: name the model with its hash (`pose_landmarker_lite.59929e1d.task`) — content-address it like Vite assets.
- `.task` compresses little (~14%); if optimization is needed, evaluate serving `.task.br`/`gzip` with `Content-Encoding` headers — probably not worth the effort.

### 4. Safari < 17 still has no CV after the `useModule` fix

**What it is.** MediaPipe's `GraphRunner` (inside `vision_bundle.mjs`, function `Oh()` + constructor `Gh`) selects a GL canvas as follows: if `OffscreenCanvas` exists **and** (the browser is not Safari **or** the version is ≥ 17) → `new OffscreenCanvas(1,1)`; otherwise → `document.createElement("canvas")`. Inside a worker, `document` does not exist → `ReferenceError` → `createFromOptions` fails → CPU fallback goes through the **same** constructor → it also fails.

**Evidence:** bundle code in `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` (`Oh` function = explicit Safari ≥ 17 gate; `Gh` constructor with fallback to `document`). `OffscreenCanvas` has been baseline since March 2023 (MDN), but WebGL inside `OffscreenCanvas` only arrived in Safari 17 — hence their gate. Combined with finding #1, the current matrix is: Chrome/Edge/Firefox → fail (the `useModule` bug); Safari ≥ 17 → fail (same bug); Safari < 17 → double failure (bug + no `OffscreenCanvas`).

**Impact:** iPhones with iOS < 17 (a meaningful share of the installed base) have no parameter-only fix path — they would need a fallback that runs the landmarker on the main thread (where `document` exists) or a compatibility warning.

**Fix direction:** after fix #1, detect `OffscreenCanvas`/version before spawning the worker; if unavailable, run `PoseLandmarker` on the main thread (the API supports this — `document.createElement("canvas")` works there) or show a requirements message (Safari 17+/Chromium). The WASM itself is single-threaded and does not require `SharedArrayBuffer`/COOP-COEP — verified: the `.wasm` memory section has flag `0x01` (not shared), and the loader JS has no pthread path.

### 5. Worker recreated from scratch on every camera toggle

**What it is.** `PoseClient.stop()` (`src/cv/poseClient.ts:111-118`) sends `DISPOSE` and calls `worker.terminate()` in the same tick — `DISPOSE` is almost certainly never processed (irrelevant: worker teardown releases everything). The real cost is the return path: `startCamera` → `new Worker` → full `INIT` — refetch the loader and 14.7 MB `.wasm` (HTTP cache, but still revalidated/parsed), **recompile WASM**, refetch + recopy the model (5.8 MB), and recreate the graph — a few seconds on every toggle and a noticeable UI pause.

**Impact:** a user who turns off the camera (battery/privacy) and turns it back on pays the entire startup cost again; that is bad during a live demo.

**Fix direction:** keep the worker warm — separate the "landmarker lifecycle" from the "capture lifecycle": `stop()` cancels rVFC/rAF and pauses the camera, while the worker (and graph) stays ready; turning it back on then costs ~0. Also consider shutting down the landmarker only after a long idle period (e.g. > 2 min).

### 6. CV throughput ceiling: one frame in flight + synchronous inference

**What it is.** The "one frame in flight" design (`busy`, `poseClient.ts:10,94-96`) + synchronous `detectForVideo` in the worker (`pose.worker.ts:82`) imposes this ceiling:

````
fps_effective ≤ min(30 (camera), 1000 / (t_bitmap + t_postMessage + t_inference + t_return))
````

Each `FRAME` runs `createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'low' })` (`poseClient.ts:101`) — a copy of the frame — and MediaPipe uploads the bitmap to the GPU through `texImage2D` on the GPU path (verified in the bundle: `addGpuBufferToStream` → `texImage2D` → `_addBoundTextureAsImageToStream`); on the CPU path, it uses `drawImage` + `getImageData` + a copy to the WASM heap (~1.2 MB per frame at 640×480).

**Reference figures (primary sources):** the official model card for `litert-community/MediaPipe-PoseLandmarker-Lite` (Hugging Face, SHA-256 identical to the repo's `SHA256SUMS` — `59929e1d…574a`) cites the BlazePose model card: **≈44 FPS on CPU (XNNPACK) and ≈49 FPS on GPU on a Pixel 3** — ~20–23 ms/frame on a 2018 phone. The package WASM uses SIMD (~150,000 `0xFD` instructions counted in the code section) and is single-threaded (non-shared memory). Official docs (`ai.google.dev/mediapipe/solutions/vision/pose_landmarker`) describe `VIDEO` mode as "processes every frame in order and never drops frames" and recommend exactly the pattern used here for livestream (process only the latest frame).

**Impact:** 30 fps CV is achievable on modern desktop discrete/integrated GPUs; on CPU fallback or a weak integrated GPU, the effective cadence drops to ~10–25 poses/s — still playable (running cadence ~120–180 spm = 2–3 Hz needs only ~6+ fps by the Nyquist criterion), but fast jumps/swings become coarser. **This is the right intentional trade-off** — a fresh frame arriving late is better than a growing queue — but it is the product's structural bottleneck.

**Fix direction (if more throughput/less latency is needed):**
- Reduce `resizeWidth` in CPU mode (e.g. 320 px) — the model receives 224²/256² internally either way; this reduces per-frame upload/readback.
- Use `VideoFrame` (WebCodecs) instead of `ImageBitmap` — it is also transferable and cheaper to produce — but `detectForVideo` accepts both; the gain is small.
- Use rVFC's `metadata.captureTime` as the timestamp to measure true end-to-end latency (today `capturedAtMs` uses the rVFC `now` = the compositor submission time, which **underestimates** photon-to-action latency; MDN lists `captureTime` for local sources).
- Allowing 2 frames in flight would trade latency for throughput — not recommended: freshness matters more in this game.

### 7. Per-frame `createImageBitmap` copy on the main thread

**What it is.** `poseClient.ts:101` creates a new `ImageBitmap` for every captured frame. `createImageBitmap` is baseline (MDN, September 2021) and `ImageBitmap` is transferable — `postMessage(..., [bitmap])` is zero-copy across the worker boundary (MDN, "Transferable objects"). The cost is creating the bitmap itself (conversion/copy, a few asynchronous milliseconds), plus MediaPipe's internal `texImage2D`.

**Impact:** ~1–4 ms per frame in practice — small, but on the critical round-trip path. `resizeWidth: 640` is almost always a no-op today (the `ideal: 640` constraint tends to be met); if the camera delivers 1080p, resizing on the GPU is the right thing to do.

**Fix direction:** nothing urgent. If optimizing: use `VideoFrame` directly or send the bitmap without resizing when `videoWidth === 640`. Keep `bitmap.close()` — already done in the worker (`pose.worker.ts:98`) and in the discard path (`poseClient.ts:76,102`).

---

## Ruled out or minor

- **Game loop** — fixed 1/60 step with an accumulator capped at 0.1 s and a maximum of 5 substeps (`GameLoop.ts:46-55`), `setAnimationLoop` (XR-compatible loop), `setPixelRatio ≤ 1.5` (`GameLoop.ts:35`), resize through `ResizeObserver`. Correct and no per-frame churn — ruled out as a bottleneck.
- **Three.js allocations** — scenes are built once; hurdles are recycled with `disposeObjectTree` on despawn (`TrackGame.ts:114-117`), materials are shared with deduplication via `Set` (`GameLoop.ts:4-18`); `TennisGame` reuses `Vector3` (`addScaledVector`, `TennisGame.ts:62`). The Three.js docs confirm explicit disposal is the correct practice — done. Ruled out.
- **React at ~30 Hz** — `setTracking` and `setCameraStatus` are called per pose frame (`App.tsx:107`), but React skips re-rendering when the value is `Object.is`-identical (react.dev/reference/react/useState). Other `setState` calls are ≤5 Hz (calibration 200 ms, HUD 200 ms with string comparison). Ruled out — no re-render at 60 Hz.
- **Pose overlay (2D canvas)** — ~26 lines/circles per frame at 640×480 (`PoseOverlay.ts:18-27`); `getContext('2d')` per call returns a cached context. CSS mirroring (`scaleX(-1)`) is free. Ruled out.
- **Code splitting** — Three.js is isolated in the lazy `GameLoop-*.js` chunk (538 KB / ~132 KB gz), loaded only through `GameCanvas`'s `import()`; the worker is isolated (156 KB) and loaded only on "Activate camera"; main bundle 243 KB / ~77 KB gz (React + app). Healthy — ruled out. Cosmetic opportunity: `modulepreload` the game chunk in `index.html`.
- **Structured clone of results** — 66 small objects per frame (`simplify`, `pose.worker.ts:28-30`) — negligible. Ruled out.
- **Single-threaded WASM, no COOP/COEP** — verified in the `.wasm` memory section (non-shared flag) and the loader has no pthreads → no isolation headers needed. Ruled out.
- **SIMD** — ~150,000 `0xFD` opcodes in the code section: SIMD build confirmed; good for CPU fallback. Browsers before 2021 cannot run it, but the gate in item #4 already excludes them.
- **`DISPOSE` + immediate `terminate`** (`poseClient.ts:115-116`) — `landmarker.close()` probably does not run, but killing the worker releases memory/GL either way. Cosmetic.
- **Dead code after telemetry** — `inferenceMs`/`receivedAtMs`/`bodyConfidence`/`capturedAtById`/`frameId` are still computed and transported with no consumer (`poseClient.ts:17,44-48`, `pose.worker.ts:83`); `CalibrationProfile.swing` is never populated (`protocol.ts:37`) and `SwingDetector.setPowerAnchors` is only called in tests — power anchors are always the defaults 2/7 (`swingDetector.ts:15-16`). Minor cleanup pending.
- **Score quirk** — `this.score += Math.round(dt * (5 + speed01 * 45))` (`TrackGame.ts:95`): with dt = 1/60 s, the term is 0.08–0.83 → rounds to 0 on most frames; the score almost only changes through hurdle bonuses (+100/−35). Probably a gameplay bug (fractional accumulation), not a performance issue.
- **MediaPipe beacon** — the bundle sends metrics to `https://odml.pa.googleapis.com/v1/log` (string found in `vision_bundle.mjs`), consistent with the README privacy notice — tiny traffic, but this is an external request that CSP headers (if added) need to allow.
- **`GameCanvas` remount by sport** (`key={sport}`, `App.tsx:140`) — destroys and recreates the WebGL context on every switch; disposal is correct, cost is tens of milliseconds — acceptable.
- **StrictMode** (`main.tsx:5`) — double mount only in development; the `disposed` flag in `GameCanvas` correctly handles the asynchronous `import()` race (`GameCanvas.tsx:23,35-38`).
- **`frameRate: { max: 30 }`** — intentionally caps the camera at 30 fps (CV cannot keep up beyond that); `ideal` rather than `exact` tolerates cameras that deliver another resolution. Ruled out.
- **Pause in a hidden tab** — rAF/rVFC pause naturally; the accumulator's 0.1 s clamp prevents a simulation jump on return. Ruled out.

---

## Open questions / unverified

- **MIME and compression of `.task` on Vercel** — the official compression allowlist does not mention `application/octet-stream` or `.task`; it probably travels uncompressed (5.78 MB raw). Not measured on a real deployment — check with `curl -H 'Accept-Encoding: br' -I` against the production URL.
- **Effective `Cache-Control` for `/assets/*-hash.js` in a Vite deployment** — docs cover `_next/static`/`/_vercel/immutable` and the `max-age=0` default; Vite hashed assets persist on the CDN, but the browser header depends on the preset — confirm on a real deployment.
- **Actual camera photon-to-screen latency** — `getUserMedia` delivers frames with ~30–80 ms of pipeline delay (sensor/ISP/compositor), not measured here; rVFC's `metadata.captureTime` is the correct instrument (MDN) if telemetry returns.
- **Inference ms/frame on real GPU** — only initialization was exercised (228 ms, SwiftShader); `detectForVideo` latency on real hardware was not measured. External reference: ≈20–23 ms/frame on Pixel 3 (model card).
- **`resizeWidth`/`resizeQuality` of `createImageBitmap` in Safari** — MDN marks support for these options as variable; if ignored, the bitmap remains at full resolution (more upload, still functional).
- **Whether `worker.terminate()` before `DISPOSE` leaks WASM resources** — worker teardown should release everything; not instrumented.

---

## Sources

Code (citations in this repo use `path:line`): `src/App.tsx`, `src/cv/{poseClient,pose.worker,protocol,calibrator,oneEuroFilter}.ts`, `src/kinematics/*`, `src/games/{core/GameLoop,track/TrackGame,tennis/TennisGame,audio}.ts`, `src/ui/{CameraPip,GameCanvas,PoseOverlay}.{tsx,ts}`, `scripts/copy-mediapipe-wasm.mjs`, `vite.config.ts`, `vercel.json`, `index.html`, `package.json`, `tests/kinematics.test.ts`, `public/mediapipe/models/SHA256SUMS`. Third-party source read under `node_modules/@mediapipe/tasks-vision/`: `vision.d.ts:819` (`useModule` signature), `vision_bundle.mjs` (`importScripts` + `await import` fallback, Safari ≥ 17 gate in `Oh()`, GPU `texImage2D` path, CPU `getImageData` path, telemetry endpoint), `wasm/vision_wasm_{internal,module_internal}.{js,wasm}` (headers/footers, memory section, SIMD count). Build measured in `dist/` after `npm run build`. Reproduced in headless Chromium (Playwright) using the compiled worker and the app's actual `INIT`.

Documents (all read during this analysis):

- https://ai.google.dev/mediapipe/solutions/vision/pose_landmarker — running modes, monotonic timestamps, livestream "latest frame" pattern, 224×224/256×256 fp16 inputs.
- https://ai.google.dev/mediapipe/solutions/vision/pose_landmarker/web_js — official `VIDEO` livestream + rAF example.
- https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite — `.task` size/SHA-256 (matches the repo), ≈44 FPS CPU / ≈49 FPS GPU on Pixel 3, 224² detector / 256² landmarker submodels.
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback — fires per frame at min(video fps, refresh), may arrive one vsync late, `captureTime`/`mediaTime` metadata.
- https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts — `TypeError` in module workers.
- https://html.spec.whatwg.org/multipage/workers.html — "importScripts() will automatically fail inside module workers".
- https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap — baseline 2021, `resizeWidth`/`resizeQuality` options.
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects — `ImageBitmap`/`VideoFrame` are transferable, zero-copy transfer.
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas — baseline March 2023.
- https://react.dev/reference/react/useState — `Object.is` bail-out.
- https://vite.dev/guide/features — Web Workers, `type: 'module'` as the recommended default.
- https://vercel.com/docs/caching/cache-control-headers — default `public, max-age=0, must-revalidate`.
- https://vercel.com/docs/edge-network/caching — static asset CDN cache for the lifetime of a deployment.
- https://vercel.com/docs/how-vercel-cdn-works/compression — `application/wasm` on the compressible list.
- https://threejs.org/manual/pages/how-to-dispose-of-objects.html — explicit disposal of geometry/material/texture is the application's responsibility.
