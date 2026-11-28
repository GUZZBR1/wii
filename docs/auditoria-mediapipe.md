# Deep Audit — MediaPipe / `@mediapipe/tasks-vision` Usage

Date: November 25, 2026 · Audited state: `main` after merge (`fc3e6a4`, PR #1) · Package: `@mediapipe/tasks-vision@1.2.3` (`package.json:18`)

This audit was conducted against **primary sources**: repository code, the `.d.ts` files and compiled bundle under `node_modules/@mediapipe/tasks-vision/`, the `.wasm` binary (memory/code sections inspected), the npm registry (`npm view`), official docs (ai.google.dev), C++/proto/TS source on GitHub (`google-ai-edge/mediapipe`), and MDN. It complements `docs/analise-de-gargalos.md` (the November bottleneck analysis) — findings already fixed in the merge are marked.

---

## 1. Executive summary

**Overall verdict: MediaPipe usage is correct and up to date.** Pin `1.2.3` is exactly the latest stable release (`dist-tags.latest = "1.2.3"`; only `1.2.4-rc.*` and `1.3.0-rc.*` exist beyond it in the nightly channel — `npm view @mediapipe/tasks-vision dist-tags`). There is no newer stable version to upgrade to. The core decisions (module worker + `useModule: true`, `runningMode: 'VIDEO'`, `numPoses: 1`, `outputSegmentationMasks: false`, one frame in flight, transferred `ImageBitmap`) match the official recommended pattern for livestream.

Material findings, ranked by impact:

| # | Finding | Impact | Type |
|---|---------|--------|------|
| 1 | **The model already returns landmarks smoothed by an internal 1-Euro filter** (`VIDEO` + `numPoses: 1` automatically enables `smooth_landmarks` in the C++ graph). The app's `OneEuroFilter` instances operate on pre-smoothed data — double filtering adds latency that has never been calibrated. | Medium–High (latency/tuning of all detectors) | API not understood |
| 2 | **CPU fallback is not a GPU-free path**: every frame's input goes up to the graph through WebGL `texImage2D` on `OffscreenCanvas` — even for the CPU delegate (per-frame upload + internal readback). A browser with no WebGL fails on both delegates — on the first *frame*, not at initialization. | Medium–High (compatibility + real cost of CPU mode) | API footgun |
| 3 | **Safari < 17 fails during worker initialization on both delegates** — GraphRunner requires `OffscreenCanvas` for Safari ≥ 17 and falls back to `document.createElement` (unavailable in a worker) below that. iOS < 17 has no CV and no compatibility message. | Medium–High (iOS share) | Compatibility |
| 4 | **Strictly serial pipeline**: `busy` blocks until the `ImageBitmap` is *created*; creating the bitmap for frame N+1 during inference of N could recover ~2–6 ms/frame of latency. | Medium–Low (throughput/latency) | Opportunity |
| 5 | **GPU→CPU fallback instantiates a second full WASM module** (second heap of ~15–20 MB, refetches the loader and model through the HTTP cache). `setOptions({baseOptions: {delegate: 'CPU'}})` would rebuild the graph on the same heap — a cheaper path, but undocumented and requiring validation. | Low–Medium | Opportunity |
| 6 | **`new VideoFrame(video)` may replace per-frame `createImageBitmap`** — accepted by `detectForVideo` (`TexImageSource`), GPU→GPU copy, transferable, baseline September 2024. | Low–Medium | Opportunity (benchmark) |
| 7 | **No warmup frame**: the first `detectForVideo` pays lazy TFLite allocation cost; a dummy frame after `READY` would remove the first-user-gesture spike. | Low | Opportunity |
| 8 | Options never tuned (all confidence thresholds stay at default 0.5), rVFC's `metadata.captureTime` is unused for latency telemetry, `worldLandmarks`/`presence` are underused by the gate. | Low | Opportunity |
| 9 | Bundle telemetry (`odml.pa.googleapis.com/v1/log`, flush every 60 s) runs per frame in the worker — disclosed in `THIRD_PARTY_NOTICES`; if a CSP is added, `connect-src` needs to allow it. | Informational | OK with caveat |

Things that **are not problems** (verified): `detectForVideo` has no async web variant (synchronous operation is required — one frame in flight is the right design); `LIVE_STREAM` does not exist in web mode (`VIDEO` + latest-frame is the official pattern); the JS API has no `smoothLandmarks`/`smoothSegmentation` — and would not need them because internal smoothing is already enabled (finding #1); `ImageBitmap`/`VideoFrame`/`OffscreenCanvas`/`ImageData` are the only valid types in a worker and `ImageBitmap` is a solid choice; the `.wasm` is SIMD128 and single-threaded; `forVisionTasks` only builds paths (the loader/model fetch happens later, when the task is created).

---

## 2. How the code uses MediaPipe today — file-by-file map

### `src/cv/pose.worker.ts` (module worker, model side)

| Line | Usage | Verified |
|------|-------|----------|
| `12` | `FilesetResolver.forVisionTasks(wasmBaseUrl, true)` | `useModule` is the second argument (signature `vision.d.ts:819`). In the compiled bundle, `forVisionTasks → nh("vision", base, useModule)` → paths `{wasmLoaderPath, wasmBinaryPath}` to `vision_wasm_module_internal.{js,wasm}` — **no fetch**, only URL construction (`vision_bundle.mjs`, `nh` function, offset ~49305) |
| `13-15` | Manual `fetch(modelUrl)` → `Uint8Array` → `modelAssetBuffer` | Alternative: `modelAssetPath` (the library fetches it internally — `ru.l()` in bundle, offset ~68400: `fetch(e.modelAssetPath.toString())`). Equivalent; manual fetch provides an explicit status check |
| `16-24` | `PoseLandmarker.createFromOptions(vision, { baseOptions: {modelAssetBuffer, delegate}, runningMode:'VIDEO', numPoses:1, outputSegmentationMasks:false, minPoseDetectionConfidence:.5, minPosePresenceConfidence:.5, minTrackingConfidence:.5 })` | The only fields accepted by the JS pose API — `PoseLandmarkerOptions` (`vision.d.ts:2745-2768`). All three thresholds are defaults (0.5) written out — no effect, but explicit |
| `28-30` | `simplify()` → `{x,y,z,visibility?,presence?}` × 2 arrays | `Qa`/`th` in the bundle emit exactly these fields from the proto; `presence` is set only when present in the proto — the model emits it (split tensor 2 = presence scores) |
| `32-46` | `fallback()`: `landmarker?.close()` → `createTask('CPU')` → `FALLBACK` message | `close()` exists (`vision.d.ts:2880`) and calls `closeGraph()` + releases mask textures (`ea.close()`). A **second** `ModuleFactory` is created → second WASM heap (~15–20 MB) — see finding #5 |
| `48-98` | `onmessage`: `INIT` → `createTask` (+fallback) → `READY`; `DISPOSE` → `close()`; `FRAME` → `detectForVideo(bitmap, timestampMs)` → `POSE`; detect error → `fallback()`; `finally` → `bitmap.close()` | `detectForVideo` is **synchronous** (`vision.d.ts:2717`; internally `finishProcessing → _waitUntilIdle()`, offset ~89005). `bitmap.close()` in `finally` is mandatory and correct — ownership transferred to the worker |
| `81` | `detectForVideo(bitmap, timestampMs)` | No timestamp validation in JS — `timestamp` becomes the packet timestamp on the `image_in` stream (`Da` → `_addBoundTextureAsImageToStream`, offset ~87692). The client guarantees the monotonicity required by the C++ framework |

### `src/cv/poseClient.ts` (main thread, lifecycle + transport)

| Line | Usage | Verified |
|------|-------|----------|
| `37-40` | `warmVisionAssets()`: `fetch()` + `arrayBuffer()` for `.js`, `.wasm`, and `.task` | Warms the **HTTP cache**; the worker then uses `import()` for the loader (`Mh`, offset ~56115 — module uses `await import` after `importScripts` throws `TypeError`), Emscripten `instantiateStreaming(fetch(.wasm))`, and `fetch(modelUrl)`. All hit the cache — effective |
| `50-55` | `init()` with deduplication through `initPromise` | One spawn at a time; `ready` short-circuits reinitialization |
| `57-83` | `beginCapture`: rVFC when available (fires for each new video frame — baseline Oct. 2024, MDN), otherwise rAF + `video.currentTime !== lastVideoTime` | rAF fallback follows the official docs pattern (ai.google.dev: "VIDEO + rAF — each paint inspects only the latest camera frame"). rVFC is strictly better: it aligns scheduling with the frame, not the vsync |
| `85-92` | `pauseCapture()`: `cancelVideoFrameCallback`/`cancelAnimationFrame` | Late `POSE` discarded by `if (!this.capturing) return` (line 130) — no side effect |
| `94-106` | `dispose()`: `pauseCapture` + `DISPOSE` + `terminate()` | `DISPOSE` almost certainly loses the race with `terminate()` — harmless: worker teardown releases the WASM heap + GL context either way |
| `108-150` | `spawn()`: `new Worker(url, {type:'module'})` → `INIT` → `READY/ERROR/FALLBACK/POSE` + 30 s timeout | `{type:'module'}` is Vite's default and the reason `useModule: true` is required (bug already fixed in the merge — `9c76399`) |
| `152-165` | `capture()`: `busy` (one frame in flight) → `createImageBitmap(video, {resizeWidth:640, resizeQuality:'low'})` → `postMessage(FRAME, [bitmap])` | Transfer = zero-copy across the boundary (MDN Transferable). `resizeWidth`/`resizeQuality` supported in Chrome 54+/FF 98+/Safari 15+ (caniuse); ignored where absent — graceful degradation |
| `155-156` | `Math.max(now, lastTimestamp + 0.01)` | Ensures **strictly increasing** timestamps — required by the MediaPipe framework (streams do not accept decreasing timestamps; violations surface as a graph error through `attachErrorListener → Jh`). Correct and necessary |
| `167-170` | `confidence()`: `min(visibility)` across `[11,12,15,16,23,24,25,26]` | `visibility` is the only guaranteed field; the gate uses `min(vis, presence)` (`math.ts:16`) — consistent composition |

### `src/cv/protocol.ts`, `calibrator.ts`, `oneEuroFilter.ts`, `src/kinematics/*`

- `PoseSnapshot` carries `landmarks` (33 normalized) + `worldLandmarks` (33 in meters, origin at hip) + `timestampMs` = timestamp of the submitted frame.
- Actual field usage: `landmarks` → gate/cadence/jump/lean/overlay; `worldLandmarks` → `SwingDetector` (3D wrist velocity — good choice, metric coordinates independent of framing) and `Calibrator` (`shoulderWidth`, `readyWristLocal`); `visibility`/`presence` → confidence.
- `OneEuroFilter` (minCutoff 1, beta 0.5, dCutoff 1) adds a **second smoothing layer** — the graph's output is already smoothed (finding #1).
- The model's auxiliary landmarks (indices 33–38 of 39; `ConfigureSplitNormalizedLandmarkListCalculator` cuts `[0,33)` + `[33,35)` in `pose_landmarks_detector_graph.cc`) are **not exposed** by the JS API — nothing is lost.

### `src/App.tsx`, `scripts/copy-mediapipe-wasm.mjs`, `vercel.json`

- `init()` (worker + WASM + model) starts in parallel with `getUserMedia` (`App.tsx:117-121`) — the largest part of cold-start latency now runs while the permission prompt is open.
- `warmVisionAssets()` only runs if `permissions.query({name:'camera'}) === 'granted'` (`App.tsx:38-39`) — it does not download ~20 MB for someone who never granted camera permission. `.catch` covers Firefox/Safari without this query.
- Build script: exact version pin (build fails unless `!== '1.2.3'`), copies **only** the module variant to `wasm-1.2.3/`, verifies model SHA-256 and requires the hash in its filename (`59929e1d`). Versioned URLs + `Cache-Control: immutable` on `/mediapipe/*` (`vercel.json:5-14`) — correct.
- Local model `pose_landmarker_lite.59929e1d.task` (5 777 746 B) matches the upstream copy (`mediapipe-models/.../pose_landmarker_lite/float16/1/`); provenance is in `THIRD_PARTY_NOTICES.md`.

---

## 3. Findings ranked by impact

### #1 — Landmarks arrive pre-smoothed: the graph applies an internal 1-Euro filter (`VIDEO` + `numPoses=1`)

**What it is.** The JS `PoseLandmarker` API does not expose `smoothLandmarks` (`PoseLandmarkerOptions`, `vision.d.ts:2745-2768`, has only 5 fields). But smoothing exists and is **enabled** in the current configuration:

1. `runningMode: 'VIDEO'` causes JS to set `base_options.use_stream_mode = true` — proto field 2 (`base_options.proto`: `optional bool use_stream_mode = 2`); in the bundle, `ec.l()`: `if("runningMode"in t){var i=this.K=!!t.runningMode&&"IMAGE"!==t.runningMode;sr(this.baseOptions,2,…) }` (offset ~89400).
2. In C++, `PoseLandmarkerGraph` decides: `if (pose_detector_options.num_poses() == 1) { pose_landmarks_detector_graph_options.set_smooth_landmarks(tasks_options.base_options().use_stream_mode()); }` — `mediapipe/tasks/cc/vision/pose_landmarker/pose_landmarker_graph.cc` (~L307).
3. With `smooth_landmarks()` true, the subgraph applies, per frame (`pose_landmarks_detector_graph.cc` ~L774-816): `SmoothLandmarksVisibility(α=0.1)` to `visibility`/`presence` and **`SmoothLandmarks` = `OneEuroFilter`** with `min_cutoff=0.05, beta=80, derivate_cutoff=1` on normalized landmarks and `min_cutoff=0.1, beta=40, derivate_cutoff=1` on world landmarks (code comments confirm the velocity-filter EMA parameterization).

**Consequence.** `SwingDetector`, `CadenceTracker`, `JumpDetector`, and `LaneLeanDetector` apply `OneEuroFilter(minCutoff=1, beta=0.5)` to data that has already been EMA-filtered. This is not a bug — but it is double smoothing whose effect has never been measured: the internal filter is much more aggressive at rest (α≈0.01–0.02) and almost transparent during fast motion (α≈0.8–0.94). The net effect on perceived latency and detector thresholds (presumably calibrated against this output, without knowing it) needs a benchmark — and this information changes the ideal tuning of the app's own filters (they can probably be lighter, or removed where they only smooth).

**Evidence:** `pose_landmarker_graph.cc` (`google-ai-edge/mediapipe`), `pose_landmarks_detector_graph.cc` ~L774-816, `pose_landmarks_detector_graph_options.proto` (`smooth_landmarks` field — not exposed in JS), `vision_bundle.mjs` `ec.l()` (offset ~89400), `base_options.proto` field 2.

### #2 — The "CPU" delegate still requires WebGL: all input goes through `texImage2D`

**What it is.** This API has no GPU-free input path. The GraphRunner's `Da` (`Yu`, offset ~87638) always does: `$h()` → `canvas.getContext('webgl2') || getContext('webgl')` → `texImage2D(...)` → `_addBoundTextureAsImageToStream` (offset ~56905). The delegate only changes where TFLite runs; frame input is always a WebGL texture. With the CPU delegate, GPU→CPU download occurs inside WASM (graph converters) — so CPU mode pays for **texture upload + internal readback** per frame, not "pure CPU".

**Practical consequences.**

- `getContext` is called only on the first *frame* (lazy in `$h`), not during initialization. In a browser with no WebGL (GPU blocklist, `--disable-webgl`, some corporate-policy environments), `createFromOptions` **succeeds** and the first `detectForVideo` throws `"Failed to obtain WebGL context…"` → `fallback()` → CPU → same error → `ERROR fatal`. The final message ("GPU failed; CPU fallback also failed") is accurate, but the premise that "CPU works without GPU" does not hold for this API.
- CPU fallback cost per frame includes internal GPU→CPU readback, in addition to XNNPACK inference. That is how it works; just do not assume CPU mode bypasses the graphics pipeline.

**Evidence:** `vision_bundle.mjs` `Yu.Da`/`$h`/`_addBoundTextureAsImageToStream` (offsets ~56905, ~87638); `Dh` (dimensions from `videoWidth`/`naturalWidth`/`displayWidth`/`width`, ~56536); no other `Da` path in the bundle (`drawImage` + `getImageData` at ~144300 belongs to `InteractiveSegmenter`, a different native engine).

### #3 — Safari < 17: the entire worker fails during initialization (GPU and CPU)

**What it is.** Bundle function `Oh()` (offset ~55876) uses `OffscreenCanvas` **only** if it exists *and* (the browser is not Safari *or* version `≥ 17` according to the user agent). Below that, the `GraphRunner` constructor calls `document.createElement("canvas")` (offset ~58325) — `document` does not exist in a worker → `ReferenceError` → `createTask` fails → `fallback('CPU')` → same constructor (`qu()` eagerly evaluates `r.canvas ?? (Oh() ? void 0 : document.createElement("canvas"))`, offset ~87965) → fails again → `ERROR fatal` → camera never starts. And not only the canvas: `Mh`/`qu` use `document` with the same predicate. This gate exists because WebGL in `OffscreenCanvas` only arrived in Safari 17 (Safari 16.4 has `OffscreenCanvas` but is excluded by the gate).

**Impact.** iOS/iPadOS < 17 (a meaningful share of the installed base) gets `ERROR fatal` → `stopCamera` + a technical message. There is no main-thread fallback or requirement message. The deliberate choice would be to detect `OffscreenCanvas`/user agent before spawning and either (a) run the landmarker on the main thread in these cases (the API supports it — `document.createElement` exists there), or (b) show a clear compatibility message.

**Evidence:** `vision_bundle.mjs` `Oh` (~55876), `Gh` constructor (~58325), `qu` (~87965); also documented in `docs/analise-de-gargalos.md` item 4 — **still open after the merge**.

### #4 — `busy` serializes bitmap creation + inference (throughput ceiling by design)

**What it is.** `capture()` sets `busy=true` **before** `await createImageBitmap` (`poseClient.ts:153-158`), and only clears it after the `POSE`/`ERROR` response. The per-frame round trip is strictly serial: `bitmap(2-6 ms) → postMessage → detectForVideo(5-25 ms) → response`. Because `schedule()` registers rVFC again before capturing, new frames are discarded while `busy` — correct for freshness, but bitmap creation could overlap with inference of the previous frame (the bitmap is only a snapshot of the `<video>`), recovering a few milliseconds of end-to-end latency without changing the "one frame in flight in the worker" semantics.

**Impact.** Small: on a healthy GPU the pipeline already finishes in <33 ms. On CPU fallback (~20–25 ms inference on weak hardware), ~3–6 ms of overlap could mean 30 vs. ~24 effective poses/s. Trade-off: a "speculative" bitmap ages by one inference — acceptable.

**Evidence:** `poseClient.ts:152-165`; no pipelining API exists — the `PoseLandmarker` `.d.ts` exposes only synchronous `detect`/`detectForVideo` (lines 2631-2733); `detectForVideoAsync` is absent from the entire `.d.ts` (web tasks are synchronous by design; `LIVE_STREAM`/`detectAsync` exist only on Android/iOS — `ai.google.dev/.../pose_landmarker`).

### #5 — GPU→CPU fallback creates a second complete WASM module

**What it is.** `fallback()` calls `landmarker?.close()` (closes the *graph*, not the module) and `createTask('CPU')` → `createFromOptions` → `ModuleFactory(module)` again (`Wh`, offset ~66905). Each `ModuleFactory` creates a new WASM heap (~19 MB initially + growth); the failed delegate's heap stays allocated until the worker exits. It also repeats the loader `import()` (cheap — module cached) and `fetch(modelUrl)` (HTTP cache).

**Alternative (requires validation).** `PoseLandmarker.setOptions` (`vision.d.ts:2618`) → `A(t)` → `l(t)` remaps `delegate` in the acceleration proto and `u()` regenerates + `setGraph` recreates the graph **in the same module** — changing delegate without a second heap. It is not documented whether `setOptions` supports delegate changes after a failure (`l()` has an explicit `"delegate"in e` path), so this is a plausible hypothesis to verify, not a recommendation.

**Evidence:** `pose.worker.ts:32-46`; `vision_bundle.mjs` `Wh`/`ModuleFactory` (~66905), `ru.l` delegate→proto (~68400+); `vision.d.ts:2618`.

### #6 — `new VideoFrame(video)` as an alternative to `createImageBitmap`

**What it is.** `detectForVideo` accepts `TexImageSource` (`vision.d.ts:1862` — `ImageSource = TexImageSource`, a DOM union that includes `VideoFrame`). In the bundle, `Dh` reads `displayWidth`/`displayHeight` (`VideoFrame` branch, offset ~56536), and `texImage2D` accepts `VideoFrame` in all three engines. `new VideoFrame(video)` copies GPU→GPU without decode/resize (`VideoFrame` "is tied to data on graphics memory", MDN WebCodecs) and is `Transferable` — it could reach the worker with less main-thread work than `createImageBitmap` (which rasterizes YUV→RGB + scales).

**Impact.** Potentially removes ~1–4 ms/frame from the main thread and gives `texImage2D` a more direct path. Caveats: baseline September 2024 (Chrome 94/FF 130/Safari 16.4) — within our Safari ≥17 floor; it loses `resizeWidth` (but the camera already requests 640, and the model resizes to 224²/256² internally anyway — extra resolution only costs upload); it requires `frame.close()` in the worker, as `bitmap.close()` does today.

**Evidence:** `vision.d.ts:1862,2717`; `vision_bundle.mjs` `Dh` (~56536); MDN `VideoFrame` (baseline, transferable, GPU→GPU copy in image-source constructors).

### #7 — No warmup: the first `detectForVideo` pays lazy cost

**What it is — now measured** (`pesquisa-pipeline-cv.md` §7.5, Chromium 159): the first `detectForVideo` after `READY` cost **≈142 ms on the CPU delegate** and **≈2 016 ms on the GPU** (SwiftShader — GL program compilation + lazy allocation), compared with ~16/~96 ms in steady state. With a person in frame at startup, the pose already appeared on this first frame (`firstPoseIndex = 0`) — "warmup" is pure wall-clock cost, not lost frames.

**Coverage caveat** (from review): a 1×1/empty dummy frame warms graph allocation and the **person detector**, but provides no ROI to the landmarker stage — the landmarker tracking acquisition is warmed only by a frame containing a person. If the intent is to hide that cost too, warmup needs a bitmap with a human figure (or accept that only allocation/detection are covered).

**Impact.** A `detectForVideo` call on an `OffscreenCanvas` just after `READY`, with an increasing timestamp, would absorb the allocation portion before the user's first gesture — trivial inside `createTask`; acquisition cost can only be removed with a frame containing a person.

### #8 — Minor findings

- **`presence` underused**: `poseClient.confidence()` uses only `visibility` (lines 167-170); the gate uses `min(vis, presence)` — consistent, but the snapshot's `bodyConfidence` could already combine `presence`. Cosmetic.
- **rVFC `metadata.captureTime`/`presentedFrames` unused** — callback already receives `(now, metadata)` but only uses `now` (line 68). `captureTime` would measure real photon-to-action latency; `presentedFrames` would detect skipped frames. Useful telemetry if restored.
- **`worldLandmarks` are always included** — the `WORLD_LANDMARKS` stream is unconditional in the graph (no flag to disable); using it (as swing detection does) is "free".
- **ODML telemetry**: bundle `Nh`/`xh` (~52447) accumulates per-frame latency histograms (`za`/`ya`) and flushes every 60 s / on `close` to `https://odml.pa.googleapis.com/v1/log` with an embedded API key — tiny traffic inside the worker, already disclosed in `THIRD_PARTY_NOTICES.md`. If a CSP is added, `connect-src` needs to allow it.
- **`getContext` per frame in `$h`** — returns a cached context, ~ns. Irrelevant.
- **Duplicate `INIT`** would leak the old landmarker (it is not closed before `createTask` reassigns it) — unreachable with the current protocol (`initPromise`/`ready` deduplicate). Noted.

---

## 4. Configuration/API opportunities not used

| Feature | Status | Worth it? |
|---------|--------|-----------|
| `outputSegmentationMasks` (body mask) | `false` — correct | Only if we want a visual effect (silhouette in the PiP) or hitbox; costs an extra stream + `MPMask` conversion per frame (`vision.d.ts:2766-2767`; subgraph emits `SEGMENTATION_MASK` only with the flag — `pose_landmarks_detector_graph.cc` ~L758). Correctly disabled for now |
| `numPoses > 1` | `1` | **Keep 1** — in addition to saving detection cost, it is the condition that enables internal smoothing (`pose_landmarker_graph.cc` ~L307); multiplayer does not exist |
| `minPoseDetectionConfidence` / `minPosePresenceConfidence` / `minTrackingConfidence` | 0.5 = defaults | `detection` governs the full-frame detector (runs when tracking is lost); `presence` decides whether a pose is emitted; `tracking` is the `min_similarity_threshold` of `AssociationNormRectCalculator` (`pose_landmarker_graph.cc` ~L361-368). Lowering `presence` to ~0.3 would produce "degraded" frames instead of `[]` — possible micro-tuning, questionable gain |
| `ImageProcessingOptions` (`regionOfInterest`, `rotationDegrees`) | unused | Fixed ROI does not help a moving full body; rotation does not apply to a front-facing webcam |
| `smooth_landmarks` proto | **already active** through VIDEO + `numPoses 1` | Not configurable through JS — see finding #1 |
| `canvas` (`VisionTaskOptions`) | not passed | Runner creates its own `OffscreenCanvas(1,1)` in the worker (offset ~58325) — passing one would change nothing |
| `setOptions` | unused | Candidate for delegate fallback without a second WASM module (finding #5) — validate |
| `LIVE_STREAM` + async callback | **does not exist on web** | JS `RunningMode` only has `IMAGE`/`VIDEO` (`vision.d.ts:2852`); "latest frame + busy" is the documented livestream pattern — already implemented |
| `detectForVideoAsync` / `detectAsync` | **does not exist** | Synchronous operation is the only option — serialization is required, already implemented |
| `POSE_CONNECTIONS` / `DrawingUtils` | unused | Own `BONES` + manual `drawPose` — fine; unused exports are removed from the bundle by tree-shaking |
| `enableLogging` | unused | Debug only |
| **Full** model (~9.4 MB) / **Heavy** (~30.7 MB) | Lite (5.8 MB) | Model card: PDJ 87.0% (lite) / 91.8% (full) / 94.2% (heavy); Pixel 3 CPU/GPU: lite 44/49 FPS, full 18/40, heavy 4/19. Lite is the right choice for a 30 fps arcade game; **full** is the only plausible upgrade if racket-swing/jump detection proves weak in benchmarks — heavy is not viable for gameplay |
| `VideoFrame` / `OffscreenCanvas→transferToImageBitmap` / `MediaStreamTrackProcessor` | current: `ImageBitmap` | `VideoFrame`: viable, benchmark it (finding #6). `transferToImageBitmap`: `drawImage` to 2D + zero-copy transfer — alternative to measure. `MediaStreamTrackProcessor` (frames directly from track): Chrome 94 window-only / Safari 18 workers / **no Firefox** — not baseline, discard |
| Dummy warmup frame | unused | Finding #7 |

---

## 5. What is correct/well implemented (verified)

- **`useModule: true` + module worker + copy only the module variant** — the three pieces fit: `forVisionTasks(base, true)` → `vision_wasm_module_internal.js` (which defines `globalThis.ModuleFactory` + `export default`); in a module worker, `importScripts` throws `TypeError` → the loader's `catch` falls back to `await import` of the **same** file — works because the module variant is what gets imported (merge fix `9c76399`; chain verified in `Mh`/`Wh`, offsets ~56115/66905).
- **Pin = latest stable**: `1.2.3` is `dist-tags.latest`; history `0.10.x → 1.0.0 → 1.2.0 → 1.2.2 → 1.2.3` (`1.2.1` and `1.2.4/1.3.0` exist only as RCs) — `npm view`.
- **WASM SIMD128, single-threaded**: 152 109 `0xFD` opcodes in the `.wasm` code section (~13 MB); memory section flag `0x01` (not shared — no `SharedArrayBuffer`, no COOP/COEP needed). No `_nosimd` in package 1.2.3 — SIMD is an absolute requirement (baseline since 2021).
- **`runningMode: 'VIDEO'`**: maintains tracking state and enables `use_stream_mode` (which enables smoothing); `IMAGE` would rerun detection + reset every frame — correct choice.
- **Timestamp monotonicity**: `Math.max(now, lastTimestamp + 0.01)` is exactly what the framework requires (JS does not validate; the C++ graph fails on decreasing timestamps).
- **`numPoses: 1` + default confidences + `outputSegmentationMasks: false`**: correct minimal configuration; the bundle's `A(t)` mapping (offset ~153000) confirms these are the only 5 effective fields.
- **One frame in flight + fresh frame**: implements the official livestream pattern ("process only the latest frame, discard intermediates when busy" — ai.google.dev), improved with rVFC over rAF.
- **Transferred `ImageBitmap` + `close()` in `finally`**: ownership and release are correct; transfer is zero-copy.
- **GPU→CPU fallback** on both failure points (init and detect) with `attemptedFallback` preventing an infinite loop; non-fatal `FALLBACK`/`ERROR` preserves the session and tracks the effective delegate (`f5611ca`).
- **Choice of consumed fields**: `worldLandmarks` (meters) for swing velocity; `landmarks` (normalized) for cadence/jump/lean; `min(visibility, presence)` in the gate.
- **No `result.close()`**: only releases masks (`Bc.prototype.close` → `segmentationMasks.close()`); there are none here — correct.
- **Warm worker + `init` parallel to `getUserMedia` + conditional `warmVisionAssets`**: resolves bottlenecks #2/#5 from the earlier analysis while saving bandwidth.
- **Build-time verification**: package version + model SHA-256 checked in `prebuild`; version/hash URLs support `immutable` safely.

---

## 6. Questions that require real benchmarks

1. **`new VideoFrame(video)` vs. `createImageBitmap(video, {resizeWidth:640})`** — ms/frame on the main thread and total latency to `POSE`, in Chrome/Firefox/Safari 17+. (VideoFrame baseline September 2024 — also measure `texImage2D` cost with each type.)
2. **Bitmap↔inference overlap** — create bitmap for frame N+1 while the worker processes N: how much does this reduce the average interval between replies on CPU fallback?
3. ~~Cost of first `detectForVideo`~~ — **measured**: ~142 ms CPU / ~2 016 ms GPU (SwiftShader) after READY vs. ~16/~96 ms steady state (`pesquisa-pipeline-cv.md` §7.5). Dummy frame covers allocation; landmarker acquisition requires a frame with a person.
4. **Does `setOptions({baseOptions:{delegate:'CPU'}})` rebuild the graph in the same module?** Measure worker memory and fallback latency vs. new `createFromOptions`.
5. **Double smoothing** (internal + own `OneEuroFilter`): measure effective marker→event latency during a fast gesture; retune `minCutoff`/`beta` knowing input is already EMA-filtered — perhaps use lighter filters or remove them in some detectors.
6. **Lite vs. Full** for real swing/jump detection rate (`F1` in real sessions) — if Full is viable (~18 FPS CPU is low, ~40 GPU is fine), its PDJ gain may justify 3.6 MB more download.
7. **`resizeWidth` 640 vs. 320 vs. disabled** for CPU-fallback throughput and landmark stability (detector runs at 224², landmarker at 256² — 320 px may suffice and cuts ~75% of upload/readback).
8. **Safari < 17**: real user share, to choose between main-thread fallback and a requirement message.
9. **`texImage2D` behavior with `ImageBitmap` when the camera returns resolution ≠ 640×480** (720p/1080p cameras): is resizing done in the bitmap or deferred to the texture?

---

## Sources

**Repository code** (`path:line`): `src/cv/pose.worker.ts`, `src/cv/poseClient.ts`, `src/cv/protocol.ts`, `src/cv/calibrator.ts`, `src/cv/oneEuroFilter.ts`, `src/cv/mediapipeAssets.ts`, `src/kinematics/*`, `src/App.tsx`, `src/ui/{CameraPip,PoseOverlay,GameCanvas}`, `scripts/copy-mediapipe-wasm.mjs`, `vercel.json`, `package.json`, `THIRD_PARTY_NOTICES.md`, `public/mediapipe/models/SHA256SUMS`.

**Packaged bundle** (`node_modules/@mediapipe/tasks-vision/`):
- `vision.d.ts` — `forVisionTasks` :819; `PoseLandmarkerOptions` :2745-2768; `BaseOptions.delegate` :17-29; `RunningMode` :2852; `VisionTaskOptions.canvas` :2898-2912; `detectForVideo` :2717; `ImageSource=TexImageSource` :1860-1862; `Landmark`/`NormalizedLandmark` (`presence?`) :2180-2194, :2469-2483; `PoseLandmarkerResult` :2774-2810; `WasmFileset` :2941-2950.
- `vision_bundle.mjs` — `nh`/`forVisionTasks` (~49305); `Mh` loader `importScripts`→`await import` (~56115); `Wh`/`ModuleFactory` (~66905); `Oh()` `OffscreenCanvas`/Safari≥17 gate (~55876); `Gh` constructor canvas fallback (~58325); `$h`/`texImage2D`/`_addBoundTextureAsImageToStream` (~56905, ~87638); `Ju`/`Qu`/`finishProcessing→_waitUntilIdle` (~89005, ~89211); `Jh` graph error collection; `ec.l()` `runningMode`→`use_stream_mode` field 2 (~89400); `A(t)` maps the 5 pose options (~153000); `jc`/`Gc` result + `eu` `free_memory` (~152447); `Qa`/`th` landmark→JS conversion (~48461); telemetry `Nh`/`xh`/`odml.pa.googleapis.com/v1/log` flush every 60 s (~52447, ~49950+); `Dh` dimensions `videoWidth/naturalWidth/displayWidth/width` (~56536).
- `wasm/` — `vision_wasm_module_internal.js` (`ModuleFactory` + `export default` + `globalThis.ModuleFactory`); `vision_wasm_module_internal.wasm` — memory flag `0x01`, 152 109 SIMD `0xFD` prefixes in code section; package contains only 4 WASM files (no `_nosimd`).

**npm/registry** — `npm view @mediapipe/tasks-vision {versions,dist-tags,time}`: `latest=1.2.3` (published 2026-11-11), `nightly=1.3.0-rc.20261122`; stable releases: `0.10.x…0.10.35, 1.0.0, 1.0.1, 1.1.0, 1.1.1, 1.2.0, 1.2.2, 1.2.3`.

**Official docs** — `ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker{,/web_js}`: IMAGE/VIDEO modes on web (synchronous; VIDEO requires monotonic timestamps), livestream pattern = VIDEO + latest frame, detector 224² + landmarker 256² fp16.
- BlazePose GHUM 3D model card (`developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf`): Lite ~44 CPU/~49 GPU FPS Pixel 3; Full ~18/~40; Heavy ~4/~19; PDJ 87.0/91.8/94.2%.
- `aifitnessapi.com/motion/mediapipe-pose-landmarker-models`: served `.task` models — lite 5 777 746 B (== local SHA256SUMS), full ~9.4 MB, heavy ~30.7 MB; bundle contains `pose_detector.tflite` + `pose_landmarks_detector.tflite`.

**GitHub `google-ai-edge/mediapipe`** — `mediapipe/tasks/cc/vision/pose_landmarker/pose_landmarker_graph.cc` (`set_smooth_landmarks(use_stream_mode)` for `num_poses==1`; `AssociationNormRectCalculator.min_similarity_threshold = min_tracking_confidence`); `pose_landmarks_detector_graph.cc` (`smooth_landmarks` → `SmoothLandmarks` OneEuro min_cutoff/beta/derivate_cutoff + `SmoothLandmarksVisibility` α=0.1; `kLandmarksNum=39`, split [0,33)+aux); `proto/pose_landmarks_detector_graph_options.proto` (`smooth_landmarks` field); `proto/pose_landmarker_graph_options.proto`; `tasks/cc/core/proto/base_options.proto` (`use_stream_mode` field 2); `tasks/web/core/fileset_resolver.ts.template` (suffixes `wasm[_module][_nosimd]_internal`; the packaged version does not contain the `nosimd` suffix).

**MDN/WHATWG/caniuse** — `HTMLVideoElement.requestVideoFrameCallback` (baseline Oct. 2024; `now`=callback timestamp, `metadata.captureTime/presentedFrames`); `createImageBitmap` (baseline 2021; `resizeWidth` Chrome 54+/FF 98+/Safari 15+; `resizeQuality` Chrome 54+/FF 149+/Safari 15+); `VideoFrame` (baseline Sep. 2024; transferable; constructing from `HTMLVideoElement` copies GPU→GPU); `WorkerGlobalScope.importScripts` (`TypeError` in module workers); `OffscreenCanvas` (baseline Mar. 2023); transferable objects.
