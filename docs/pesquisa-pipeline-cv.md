# Deep Research — Camera → Pose → Game Pipeline and the Browser CV Landscape

Date: November 25, 2026 · Branch: `main` after merge (`fc3e6a4`)
Scope: per-frame mechanics of the pipeline (rVFC → bitmap/VideoFrame → worker → `detectForVideo` → POSE → detectors → game), actual WASM capabilities of `@mediapipe/tasks-vision@1.2.3`, and the landscape of browser CV/pose libraries. Does not repeat the bundle/cache/respawn analysis in `docs/analise-de-gargalos.md` — this focuses on what happens *inside* each frame.

Method: all claims about MediaPipe internals were verified against files in the installed package (`node_modules/@mediapipe/tasks-vision/`), not secondhand documentation. External claims cite MDN/caniuse, WICG/W3C specifications, official documentation (ai.google.dev, docs.opencv.org, blog.tensorflow.org), and project sources (GitHub releases, npm registry).

---

## 1. Executive summary

1. **The current pipeline is architecturally sound and close to the API’s optimum.** Google’s official recommendation for live web camera input is exactly `runningMode: 'VIDEO'` + processing only the latest frame (ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker, “Livestream” section). A single in-flight frame + worker + `busy` flag (`src/cv/poseClient.ts:27,152-160`) implements this.
2. **The WASM is compiled with SIMD128 and is strictly single-threaded** — measured in the binary: ~152,000 `0xFD` opcodes (`v128.*`) in the code section; a non-shared memory section (flag `0x01`, minimum 291 pages ≈ 18.2 MiB, maximum 2 GiB); the JS glue contains no `SharedArrayBuffer`/`Atomics`/worker pool. There is no “threaded” build of tasks-vision, so **COOP/COEP** (`crossOriginIsolated`) would bring no benefit for this library.
3. **Every frame — with GPU or CPU delegate — enters the graph as a WebGL texture** through `gl.texImage2D` on an `OffscreenCanvas` inside the worker (function `$h` in `vision_bundle.mjs`). Consequence: with CPU fallback, pixels are uploaded to the GPU only to be read back into CPU memory inside the graph — a forced round trip the API does not let us avoid.
4. **`detectForVideo` accepts `VideoFrame` directly** (`ImageSource = TexImageSource`, `vision.d.ts:1862`), and `new VideoFrame(video)` is synchronous, transferable, and Baseline 2024 — it removes `createImageBitmap` (~1–4 ms/frame on the main thread) without changing anything else. This is the only no-cost improvement identified in the data path.
5. **Inference itself is the dominant bottleneck** (estimated at 70–90% of round-trip time per frame): BlazePose Lite runs at ~44 fps CPU / ~49 fps GPU on a *2018 Pixel 3* (official model card). Everything else — bitmap, `postMessage`, response clone (~3 KB), detectors, game dispatch — adds only a few milliseconds.
6. **OpenCV.js is dead weight here**: 8–16 MB of WASM for a classical CV toolbox whose only relevant functions (segmentation, calibration) already exist in the current stack in a more suitable form. See the detailed verdict in Section 4.
7. **No pose alternative beats MediaPipe for this use case** (one person, webcam, gameplay): MoveNet lacks `worldLandmarks` (breaking `swingDetector`/`calibrator`, which use meters); RTMPose/ONNX costs ~15 MB of runtime + a DIY two-stage pipeline; YOLO-pose is AGPL-3.0; LiteRT.js is a bare runtime without a ready-to-use pose API. See the table in Section 5.
8. **Surprising finding:** the WASM already contains complete WebGPU machinery (`MlDriftWebGpu`, `webgpu_service.h`, Emscripten `_emwgpu*` bindings including `importJsExternalTexture`), but the vision JS bundle never accesses `navigator.gpu` — WebGPU is **dormant for vision tasks** in version 1.2.3; the `GPU` delegate runs through WebGL2.

---

## 2. Per-stage cost map of the current pipeline

Actual pipeline (code): `getUserMedia(640×480@30)` (`src/App.tsx:118-120`) → `<video>` → `requestVideoFrameCallback` (rAF fallback) (`src/cv/poseClient.ts:64-82`) → `createImageBitmap(video,{resizeWidth:640,resizeQuality:'low})` (`poseClient.ts:158`) → transferred `postMessage` (`poseClient.ts:160`) → synchronous `detectForVideo(bitmap,ts)` in the worker (`src/cv/pose.worker.ts:81`) → `POSE` with 33+33 points (`pose.worker.ts:82-86`) → `ActionPipeline`/detectors → game.

### 2.1 Scheduling: `requestVideoFrameCallback` versus rAF fallback

**Semantics (WICG video-rvfc spec, wicg.github.io/video-rvfc):**

- The callback runs during *rendering steps* when a new frame is sent to the compositor, **immediately before `requestAnimationFrame` callbacks** in the same step — changes made in either callback appear at the same vsync (spec Section 1).
- Effective rate = `min(video rate, browser paint rate)` — for a 30 fps camera on a 60/120 Hz monitor, about 30 callbacks/s (web.dev/articles/requestvideoframecallback-rvfc).
- Each registration is one-shot; code re-registers inside the callback (`poseClient.ts:68-71`) — correct according to the spec.
- **Under main-thread load, the browser can skip frames** (the spec recommends detecting this with monotonic `metadata.presentedFrames` — currently ignored).
- The first argument, `now`, is a rendering-step `DOMHighResTimeStamp`; **`metadata.captureTime` — “the time at which the frame was captured by the camera” — is a SHOULD (not MUST) for getUserMedia/WebRTC sources** (spec Section 2.2: “SHOULD be present for WebRTC or getUserMedia applications, and absent otherwise”). Code uses only `now` (`poseClient.ts:68`), so actual photon-to-pose latency is not currently measured. Because this is a SHOULD, telemetry must handle `captureTime === undefined` (browsers that do not expose it) by falling back to `now` — without this field, the callback measures presentation-to-pose, not capture-to-pose.

**Support matrix (caniuse/MDN API for `HTMLVideoElement.requestVideoFrameCallback`):** Chrome/Edge 83 (May 2020), Safari 15.4 including iOS (March 2022), **Firefox 132 (October 2024)** — Baseline since October 2024, ~96.8% global usage. The rAF fallback is exercised only in Firefox ≤131 and Safari ≤15.3.

**Problems with the rAF + `video.currentTime` path (`poseClient.ts:72-80`):**

- For `MediaStream` (`srcObject`), `currentTime` is a **real-time clock**, not a per-frame PTS: the mediacapture-main spec defines that the timeline “starts at 0 and increments linearly in real time as long as the MediaStream is playing” (w3c/mediacapture-main#615). Chrome actually increments `currentTime` *per frame* (documented interoperability bug, issuetracker.google.com/issues/413061418), while Firefox and Safari increment it per task/real time.
- **Consequence:** on older Firefox/Safari, `currentTime !== lastVideoTime` fires on practically every rAF tick (up to 60 Hz), repeatedly capturing the *same* presented frame — up to ~2× redundant bitmap + inference work (`busy` absorbs some of it). Older Chrome works by accident (one step per frame).
- MDN on `HTMLMediaElement.currentTime`: “The update frequency depends on the browser and media playback pipeline… successive reads can return the same `currentTime` even when `Date.now()` has advanced” — granularity is implementation-defined, with no guarantee of one step per frame.
- Current impact: low (the share of browsers without rVFC is small and shrinking), but this is the only pipeline point that can *waste* inference on identical frames.

### 2.2 `createImageBitmap(video, {resizeWidth:640, resizeQuality:'low'})` — its cost and behavior

- **Semantics:** each call produces a new `ImageBitmap` — a snapshot of the current frame, optionally resized. With only `resizeWidth`, height is derived to preserve aspect ratio (HTML Standard, `ImageBitmapOptions`). Since the constraint requests 640×480 (`App.tsx:120`), resizing is a no-op in the nominal case; for cameras that ignore `ideal` and deliver 1080p, this downscale protects the internal `texImage2D` from uploading 1920×1080.
- **Color conversion:** the bitmap is normalized to the default output color space (`colorSpaceConversion:'default'` implies conversion from the camera’s native format, typically I420/NV12 → RGBA). Conversion is unavoidable — the model consumes RGB; only *where* it happens is a choice.
- **Backing store:** in Chrome, an `ImageBitmap` from `<video>` is typically GPU-resident, making the later `texImage2D` upload a GPU→GPU copy (implementation detail, medium confidence — the spec does not require it).
- **Option support:** `resizeWidth` in Chrome 54 / Firefox 98 / Safari 15; `resizeQuality` arrived in Firefox only in **149** (March 2026, bug 2010125) — before that it was ignored (harmless: the spec default is already `'low'`). caniuse `mdn-api_createimagebitmap_options_*`.
- **Estimated cost:** ~1–4 ms asynchronously on the main thread per frame (decode/conversion/copy). It is the only pipeline stage that runs on the same thread as the game.

**Verified alternatives (what `detectForVideo` accepts):** `ImageSource` is a deprecated alias for `TexImageSource` (`vision.d.ts:1862`) = `ImageBitmap | ImageData | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas | VideoFrame`. The bundle’s dimension extractor (`Dh()` in `vision_bundle.mjs`) explicitly handles `displayWidth/displayHeight` — fields unique to `VideoFrame` — confirming first-class support.

| Source | How to obtain | Support (caniuse/BCD) | Cost per frame | Notes |
|---|---|---|---|---|
| `ImageBitmap` (current) | `createImageBitmap(video,{resizeWidth})` | Baseline; `resizeWidth` FF98+/S15+/C54 | ~1–4 ms (async, main) | only option with built-in downscale |
| **`VideoFrame`** | `new VideoFrame(video)` inside rVFC | C94/S16.4/FF130 — Baseline September 2024 | ~synchronous, ref-counted handle | no resize (only `visibleRect` crop); `frame.timestamp` = PTS in µs — resets when camera is reopened; keep PoseClient’s monotonic ms clock |
| `VideoFrame` via `MediaStreamTrackProcessor` | track → `ReadableStream` of frames | C94 (partial context), Safari 18+, **Firefox: no** | zero-copy from the pipeline | could feed the worker directly, but limited to Chromium/Safari 18+ |
| `ImageBitmap` via `ImageCapture.grabFrame()` | `new ImageCapture(track).grabFrame()` | C59+, **FF flag only, Safari 26+** | same or worse (full resolution, no resize) | no advantage |
| `ImageData`/raw buffer | `ctx.getImageData` | universal | GPU→CPU readback ~2–6 ms + 1.2 MB copy | strictly worse — loses GPU path |
| `OffscreenCanvas` | transfer + `drawImage` | universal | does not help: only the main thread can draw `<video>`; canvas can belong to only one context at a time | — |

> **Practical conclusion:** `new VideoFrame(video)` inside rVFC is the best available change — removes the `await createImageBitmap` from the main thread, preserves the real PTS (`frame.timestamp`, microseconds), and at the current 640 constraint delivers exactly the same resolution to `texImage2D`. Care points: call `frame.close()` in the worker’s `finally` block (as we already do with `bitmap.close()`, `pose.worker.ts:96`); for cameras wider than 640 px, keep bitmap resizing (or accept a larger upload). **PTS caveat:** `frame.timestamp` is the track’s media clock — it resets when the camera is reopened and can diverge from the PoseClient tracking clock (`poseClient.ts:154-155` keeps `lastTimestamp` monotonic via `Math.max`). Since `stopCamera` keeps the worker warm (`App.tsx:76-81`), the change must continue using a client-generated `timestampMs` (or rebase PTS with an offset) — never feed the graph `frame.timestamp` directly without the monotonicity MediaPipe requires.

### 2.3 `postMessage` / structured clone / transferables

- `ImageBitmap` and `VideoFrame` are `[Transferable]` (MDN “Transferable objects”; Firefox WebIDL: `[Serializable, Transferable]`) — `postMessage(msg,[bitmap])` **moves the object**, with no pixel copy across the worker boundary (cost: tens of microseconds, metadata only).
- The `POSE` response clones 66 points `{x,y,z,visibility,presence}` — ~2–3 KB of structured clone per frame, negligible.
- Semantics to respect: transferred objects are neutered at the source — the worker’s `bitmap.close()` (`pose.worker.ts:96`) releases its associated GL resource; likewise, forgetting to close a `VideoFrame` leaks its resource (`frame.close()`).

### 2.4 Inside the worker: what `detectForVideo` actually does per frame

Evidence from `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` (minified bundle; identifiers are the names observed):

1. `$h(t, e, r)` — *the only image input path for vision tasks*: requires `t.j.canvas` (an `OffscreenCanvas` in the worker — `Oh()` allows OffscreenCanvas except Safari <17, where it would fall back to nonexistent `document.createElement` in a worker); calls `t.j._bindTextureToCanvas()` (WASM-exported function, `vision.d.ts:2967`), gets `canvas.getContext("webgl2") || getContext("webgl")`, executes **`gl.texImage2D(TEXTURE_2D, 0, RGBA, RGBA, UNSIGNED_BYTE, source)`** and sets `canvas.width/height` to `Dh(source)`. Thus **every `TexImageSource` becomes a GL texture** — including for the CPU delegate.
2. `Yu.prototype.Da` → `this.oa._addBoundTextureAsImageToStream(stream, w, h, timestamp)` — passes the texture into the graph with its timestamp.
3. `finishProcessing()` → `this.j._waitUntilIdle()` (`vision.d.ts:2975`) — **blocks** until the graph produces outputs.
4. Outputs arrive through proto listeners and are assembled into `PoseLandmarkerResult` (`landmarks`: 33 × `NormalizedLandmark`; `worldLandmarks`: 33 × `Landmark` in meters, origin at the hip midpoint — `vision.d.ts:2176-2193`).

**Internal graph behavior:**

- The `GPU` delegate keeps tensors on the GPU; landmarks are emitted as small proto packets — **there is no full-frame readback per frame**. The bundle’s `readPixels` calls exist for `MPImage/MPMask → ImageData` conversion (including a float-texture path for macOS/Safari) — they cost anything only if you request a mask as CPU data.
- With the `CPU` delegate (XNNPACK, confirmed by `xnnpack` strings in the WASM), the input texture must become a CPU `ImageFrame` — GL→CPU conversion happens **inside WASM** (there is no second input route: the bundle has exactly one image path for `detectForVideo`; the only raw-pixel route — `drawImage` + `getImageData` → heap — belongs to `InteractiveSegmenter`, not vision tasks). Thus CPU fallback pays for GL upload + internal readback + XNNPACK inference.

### 2.5 Synchronous `detectForVideo` in the worker — good or bad?

- **Good for this use case:** synchronous operation would be a problem only if it blocked the main thread — inside the worker it *is* the backpressure mechanism (along with the `busy` flag). A hypothetical async `detectForVideo` would not improve throughput: WASM is single-threaded and the graph serializes through one GL context; freeing the worker thread would provide no parallelism.
- The web API exposes no `LIVE_STREAM`/async mode — `RunningMode = "IMAGE" | "VIDEO"` only (`vision.d.ts:2852`); LIVE_STREAM exists only in Android/iOS APIs (ai.google.dev pose_landmarker, platform tabs). So “synchronous or nothing” is a platform constraint, not an app choice.
- `VIDEO` requires strictly increasing timestamps — code guarantees this with `Math.max(now, lastTimestamp+0.01)` (`poseClient.ts:155`). Official documentation describes the mode as “processes every frame in order and never drops frames” — dropping policy belongs to the `busy` flag, correctly placed *outside* the library.
- Actual stage cost: dominated by `texImage2D` (~0.5–2 ms at 640×480) + `_waitUntilIdle` = full graph inference (pose detector runs only when tracking fails, then landmarker runs every frame — BlazePose two-stage pipeline, ai.google.dev “Models”).

### 2.6 POSE → detectors → game

`worker.postMessage` returns ~66 points (clone of a few KB); `PoseClient` derives `bodyConfidence = min(visibility)` across 8 indices (`poseClient.ts:167-170`) — a conservative criterion (one occluded wrist lowers the minimum). Detectors consume normalized indices 11,12,15,16,23,24,25,26 (cadence/jump/lean/gate) and `worldLandmarks` 11,12,15,16 (`swingDetector.ts:25-28`, `calibrator.ts:29`). Cost: microseconds of pure math — irrelevant in the bottleneck map.

---

## 3. WASM capabilities — present versus absent (binary evidence)

File analyzed: `node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.{js,wasm}` (the fileset actually loaded: `pose.worker.ts:12` calls `forVisionTasks(base, true)` and the resolver builds `vision_wasm_module_internal.*` — `vision_bundle.mjs`, function `nh`).

### 3.1 SIMD128 — **present and mandatory since 1.2.2**

Count of opcodes prefixed `0xFD` (128-bit vectors) in the `.wasm` code section (offset 63297, 13,033,271 B):

| Pattern | Instruction | Occurrences |
|---|---|---:|
| `FD 0C` | `v128.const` | 29,827 |
| `FD 0B` | `v128.store` | 16,222 |
| `FD 00` | `v128.load` | 15,627 |
| `FD 0D` | `i8x16.shuffle` | 11,693 |
| `FD E6 01` | `f32x4.mul` | 7,383 |
| `FD E4 01` | `f32x4.add` | 5,378 |
| `FD AE 01` | `i32x4.add` | 4,506 |
| `FD E5 01` | `f32x4.sub` | 1,038 |

(Raw byte counts — false positives inside immediates are possible, but the order of magnitude and concentration in classic NN sub-opcodes support only one reading: the binary was compiled with `-msimd128`.)

External corroboration: **v1.2.2 release notes** — “Remove non-SIMD WebAssembly builds from the MediaPipe Tasks Web SDK” (github.com/google-ai-edge/mediapipe/releases). In other words, there is no longer even a non-SIMD variant to fall back to: **browsers without WASM SIMD cannot instantiate the module** — Safari floor **16.4** (SIMD: Chrome 91, FF 89, Safari 16.4 — caniuse wasm-simd; Baseline since March 2023). This combines with the `Oh()` gate (OffscreenCanvas + WebGL in a worker requires Safari ≥17): in practice, Safari <17 has no CV support anyway.

### 3.2 Threads / pthreads / SharedArrayBuffer — **absent**

- `.wasm` memory section (offset 23722): `01 01 a3 02 80 80 02` → 1 memory, **flags `0x01` (min+max, unshared)**, minimum 291 pages ≈ **18.2 MiB initial heap**, maximum 32,768 pages = 2 GiB. Shared memory would use flags `0x02`/`0x03`.
- `vision_wasm_module_internal.js` glue: **0 occurrences** of `SharedArrayBuffer`, `Atomics`, `wasmWorkers`, or `pthreadPool` — `pthread` appears only in 6 Emscripten runtime comments (lines 96, 377, 385, 5349, 7566, 7676).
- The `WasmModule` interface (`vision.d.ts:2956-3048`) exposes no thread-pool API.
- The `wasm/` package directory contains only `vision_wasm_internal.*` (classic) and `vision_wasm_module_internal.*` (ES module) — **there is no threaded MediaPipe Tasks build for the web**. Nothing can be enabled with `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` for this dependency (SAB requires `crossOriginIsolated`, MDN SharedArrayBuffer — a requirement that would apply to multithreaded ONNX Runtime or OpenCV `--threads`; see Sections 4 and 5).

### 3.3 WebGPU — **present in the binary, dormant for vision tasks**

- The `.wasm` contains the complete “drishti/aimatter” stack (1,687 `drishti` strings), including `MlDriftWebGpu`, `JointBilateralFilterCalculatorWebGpu`, `third_party/mediapipe/gpu/webgpu/webgpu_service.h`, and `canvas_webgpu` — and v1.0.0 release notes record “Store wgpu::Instance in WebGpuService.”
- JS glue contains Emscripten WebGPU import bindings (`vision_wasm_module_internal.js:5570-5689`): `importJsDevice`, `importJsComputePipeline`, **`importJsExternalTexture`** — bindings for *receiving* WebGPU objects already created on the JS side.
- **But** `vision_bundle.mjs` has **0 references** to `navigator.gpu`/`webgpu`/`requestAdapter`: the vision bundle never creates a device or external texture. Official setup guidance (“WebGPU-enabled browser recommended for **large generative, retrieval, and decision models**” — developers.google.com/edge/mediapipe/solutions/setup_web) confirms: WebGPU serves genAI tasks; for vision, the `GPU` delegate runs through **WebGL2** (context created in `$h` + GL calculators in WASM).

### 3.4 Other runtime facts

- `WebAssembly.instantiateStreaming` is used when possible (`vision_wasm_module_internal.js:~340`) — compilation overlaps download if the server responds with `application/wasm` (Vercel does).
- The `.wasm` is the **same fileset for all vision tasks** — strings include `PoseLandmarkerGraphOptions`, `FaceLandmarkerGraphOptions`, `HandLandmarkerGraphOptions`, `HolisticLandmarkerGraphOptions`, `HandRoiRefinementGraphOptions`, etc. Adding another task does not download more WASM — only its corresponding `.task` file (sizes in Section 6).
- Current model: `pose_landmarker_lite.59929e1d.task` = 5,777,746 B; landmarker input is 256×256×3 with a crop aligned to the hip center (BlazePose GHUM model card, developers.google.com/static/ml-kit/.../pose_model_card.pdf).

---

## 4. OpenCV.js verdict — needed or dead weight?

**What is officially offered (docs.opencv.org/4.x tutorial_js_setup):**

- There is no official production distribution: `opencv.js` served from `docs.opencv.org/{version}/opencv.js` is a **reduced tutorial build** (“size vs functionality compromise”) — an OpenCV maintainer wrote in issue opencv/opencv#25425: “there is no official OpenCV JS release. We don't recommend to use that file directly in your projects” (quoted in the `@haoking/opencvjs` README). For production, the official route is to build your own (`platforms/js/build_js.py`).
- Actual file sizes from the official `opencv-{version}-docs.zip` (published measurements, issoh.co.jp, October 2026): **4.14.0 = 11,059,007 B; 5.0.0 = 16,211,109 B** — one file with WASM base64-encoded (about 1.33× inflation). `@techstark/opencv-js` on npm: **14.7 MB unpacked**. Historical WASM-only build ≈8.1 MB; threads + SIMD ≈9.0 MB (intel/webml-polyfill#1348).
- **SIMD and threaded builds are available**: `--simd` (`-msimd128`), `--threads` (pthread pool → `SharedArrayBuffer` → **requires `crossOriginIsolated`**, i.e. headers `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`, feasible in `vercel.json`), and `--build_loader` creates a `loader.js` with feature detection selecting among `wasm`/`simd`/`threads`/`threadsSimd` (tutorial_js_setup, items 2–3). Reducing the module whitelist (`opencv_js.config.py`) is the size-control lever.
- OpenCV.js `dnn` runs in CPU WASM — no GL/WebGPU delegate; neural-network inference would be slower than the current MediaPipe pipeline.

**What it would add to this app — honestly, nothing missing:**

| Hypothetical need | Current coverage |
|---|---|
| Pose keypoints | `PoseLandmarker` (already in production) |
| Mask/silhouette | `outputSegmentationMasks` in PoseLandmarker itself (cost: one flag, Section 6) |
| Background/mask subtraction | same — `MPMask` as `WebGLTexture` without readback |
| Posture calibration | custom `src/cv/calibrator.ts` using metric landmarks |
| Filters/resize/YUV→RGB | `createImageBitmap`/`texImage2D` already handle these on the GPU |
| `cv.dnn` for another model | CPU-only, slower than current delegate; ORT/LiteRT.js would be the right tool |

**Verdict: dead weight.** It would add 8–16 MB download, a second WASM runtime to compile/initialize, manual `cv.Mat` lifecycle management (no GC — `mat.delete()`), and no capability the game lacks. OpenCV.js would make sense only for features this product does not have — ArUco fiducials, homography/camera calibration, feature matching, heavy morphology — and even then with a custom build and minimal whitelist, not the documentation build.

---

## 5. Pose alternatives — an honest comparison

| Solution | Delivered size | Output | Latency (primary-source evidence) | License | Project status |
|---|---|---|---|---|---|
| **MediaPipe tasks-vision 1.2.3 + pose_landmarker_lite (CURRENT)** | WASM 14.7 MB + `.task` 5.78 MB + JS bundle ~156 KB | 33 normalized kp + 33 world kp (meters, hip-centered) + visibility/presence + optional mask | Model card: ~44 fps CPU (XNNPACK)/~49 fps GPU on a **Pixel 3**; TF blog: MediaPipe runtime WASM+GPU 92 fps (2019 MBP) / 160 fps (i9+GTX1070) with Lite | Apache-2.0 | **Active** — 1.2.3 is latest (Nov 11, 2026); nightly 1.3.0-rc; stable releases 1.0→1.2.3 since Jul 2026 |
| TF.js MoveNet (Lightning/Thunder) via `@tensorflow-models/pose-detection` | JS ~1.5 MB + tfjs core/backend + weights 2.9–4.8 MB (L) / 7.1–12.6 MB (T) | **17 2D kp only — no z or world coordinates** | TF blog: 104 fps WebGL (MBP), 42 fps WASM+SIMD+MT; “30+ fps on most desktops” | Apache-2.0 | **Maintenance mode** — `@tensorflow/tfjs` 4.22.0 unchanged since Jan 2025; Google migrated to LiteRT.js (developers.googleblog.com LiteRT.js, Jul 2026) |
| BlazePose via TF.js runtime (`tfjs-models`) | similar to above | 33 kp (no reliable world-meter coordinates in tfjs runtime) | **Strictly dominated:** in the same blog paper, TF.js WebGL gave 44 fps on desktop vs 160 for MediaPipe runtime on the same Lite model | Apache-2.0 | maintenance (same package) |
| RTMPose (mmpose) via `onnxruntime-web` | `ort-wasm-simd-threaded.wasm` **14.8 MB** (npm 1.31.1; `.jsep` WebGPU = 29.5 MB) + RTMPose-s fp32 ~22 MB (HF/EZ-MMLA mirrors); -m = 13.6 M params | 17 COCO kp (SimCC) — **no world coordinates**, two-stage pipeline | mmpose README: per-person latency 4.5 ms (-s)/11.1 ms (-m) in native ORT on i7-11700 + RTMDet detector — native figures, web WASM will be slower; requires DIY detector→crop→infer→decode SimCC→custom tracking | Apache-2.0 | active (mmpose); no turnkey web API |
| YOLO-pose (Ultralytics v8/11/26) via ORT | model ~6 MB (n) + ORT runtime | 17 kp | comparable to nano class | **AGPL-3.0** — ultralytics.com/license requires the whole project to be AGPL or paid Enterprise licensing, including retrained weights | active, but **license blocker** for any non-AGPL use |
| **LiteRT.js** (`@litertjs/core` 2.6.0) | WASM runtime (XNNPACK) + WebGPU/WebNN | none — bare runtime | promising (official TF.js successor, announced July 2026 by Google AI Edge) | Apache-2.0 | active; **but the entire pipeline must be assembled**: `.tflite` model + pre/post-processing + tracking + world metrics — everything tasks-vision provides ready-made |
| pose_landmarker_full / heavy (same stack) | `.task` 9.4 MB / 30.7 MB | identical | model card: ~18/~40 fps and ~4/~19 fps Pixel3 (full/heavy); PDJ 91.8/94.2 versus Lite 87.0 | Apache-2.0 | config switch — **accuracy lever**, not a speed improvement |

**Conclusion:** for *one person using a webcam to control an arcade game*, no alternative simultaneously provides (a) world landmarks in meters (already consumed by `swingDetector`/`calibrator`), (b) a solved two-stage pipeline with temporal tracking, (c) a web GPU delegate, and (d) an actively maintained project. The rational evolution path is within MediaPipe (Section 6) — or, further out, reimplementing on LiteRT.js if/when it gets a ready-made pose API.

---

## 6. Underused MediaPipe capabilities that could cheaply enrich the game

Ordered by cost/benefit:

1. **rVFC `metadata` — real latency telemetry (zero cost, read-only).** Callback receives `(now, metadata)`, but code uses only `now` (`poseClient.ts:68`). `metadata.captureTime` (“time at which the frame was captured by the camera,” SHOULD for getUserMedia — WICG spec Section 2.2) enables end-to-end photon→pose measurement; monotonic `metadata.presentedFrames` counts presented frames missed between callbacks — today drops are inferred only from `busy`. Bonus: with `VideoFrame`, `frame.timestamp` gives the frame’s own PTS in µs — **but resets for each new camera session** (per-track origin), so PoseClient’s monotonic `timestampMs` must remain the official clock (see caveat in Section 2.2).
2. **Per-landmark `presence` (exposed on the web since tasks-vision 1.1.0, release notes).** Semantically distinct from `visibility` (`vision.d.ts:2187-2193`): *presence* = “the point is present in the scene (within image bounds)”; *visibility* = “it is visible (not occluded).” `math.ts:16` already uses `presence ?? visibility` as fallback; `TrackingGate`/`bodyConfidence` could distinguish “left the frame” (low presence → probably stopped playing/left) from “just occluded” (low visibility → graceful degradation) — both currently become the same `'degraded'` state.
3. **`outputSegmentationMasks` (currently `false`, `pose.worker.ts:20`).** Enables a mask output per pose (`PoseLandmarkerResult.segmentationMasks: MPMask[]`, `vision.d.ts:2786-2810`). Cost: one more graph decoder; the mask stays a `WebGLTexture` — **cheap if kept on the GPU**; expensive conversion is the issue (`getAsImageData()` performs an “expensive GPU to CPU transfer,” `vision.d.ts:2272-2279`; same for `getAsImageBitmap()`). Call `result.close()` to release it (`d.ts:2806-2810`). Uses: player “ghost” silhouette in PiP, background cutout, speed effects. Can be enabled/disabled at runtime via `setOptions` (`vision.d.ts:2618`) — no cost while off.
4. **`GestureRecognizer` / `HandLandmarker` / `FaceLandmarker` — same fileset is already downloaded.** All three classes live in the same 14.7 MB WASM (`vision.d.ts:884,1028,659`; binary strings confirm the graphs). Incremental cost is only the `.task`: `face_landmarker.task` ≈3.8 MB (478 kp + 52 blendshapes), `hand_landmarker.task` ≈7.8 MB (21 kp×2), `gesture_recognizer.task` ≈8.4 MB (named gestures — `Open_Palm`, `Thumb_Up`…), `holistic_landmarker.task` ≈13.7 MB (all in one graph). Official URLs: `storage.googleapis.com/mediapipe-models/...` (sizes measured in third-party sources and checked against the CDN). **Watch the budget:** each extra task adds one `detectForVideo` per frame on the same single-core WASM thread — decimate (e.g. gestures every N frames) or use a separate worker (then pay +14.7 MB WASM + compilation). Natural use cases: open palm → pause/recalibrate; closed fist → “hold racket”; hand cursor for menus (currently require a click — inconsistent in a body-controlled game).
5. **Tune thresholds (`pose.worker.ts:21-23`) — with corrected semantics** (review): `minTrackingConfidence` is **not** the redetection trigger — in tasks-vision it feeds `AssociationNormRectCalculator.min_similarity_threshold` (IoU deduplication + identity propagation between ROIs, `pose_landmarker_graph.cc` ~L376-379). The prior frame’s rectangle count (`has_enough_poses`/`DisallowIf` in the subgraph), supplied by poses with `presence ≥ minPosePresenceConfidence`, decides whether the detector runs again. Practical consequence: **with `numPoses: 1`, `minTrackingConfidence` is inert** — the association inputs are never both non-empty at once (verified in `docs/revisao-pr2-verificacao.md`, finding 8). The knobs that actually matter here: `minPosePresenceConfidence` (0.5→0.4 emits more poses on marginal frames — more redetections, not fewer; raising it makes emission stricter) and `minPoseDetectionConfidence` (detector acceptance when it runs). The previous wording attributed the legacy `solutions/pose` (`pose.py`) semantics, which do not apply to tasks-vision.
6. **`numPoses` (currently 1).** The option accepts >1 (`vision.d.ts:2746-2750`) — the detector finds extra ROIs and the landmarker runs once per ROI — a path to future co-op, at a cost roughly linear in the number of people.
7. **`worldLandmarks` — already consumed, but worth documenting:** `swingDetector.ts:25-28` reads wrist/shoulder coordinates in meters and then **normalizes by shoulder width** (`swingDetector.ts:29-33` — each axis / width) before deriving velocity (`:38-42`) → swing thresholds (`speed >= 2`, `softSpeed=2`, `strongSpeed=7`) are in **shoulder-widths per second**, not m/s — invariant to camera distance and player size. `calibrator.ts:29` stores `world.shoulderWidth` and `readyWristLocal` in the same normalized units. Cheap extensions: stride amplitude in meters (running), torso depth z (forward/backward lean — current lean uses only normalized xy in `postureSignals.ts`).

---

## 7. Final ranking of per-frame pipeline bottlenecks

Impact = estimated fraction of the camera→usable-pose round trip; confidence reflects strength of primary evidence.

| # | Bottleneck | Where | Estimated impact | Confidence |
|---|---|---|---|---|
| 1 | **Synchronous graph inference (detect + landmark + tracking) in single-thread WASM** | `_waitUntilIdle` inside `detectForVideo` | ~70–90% of round trip; sets ceiling `fps ≤ min(30, 1000/rt)`. Reference: ~20–23 ms/frame on Pixel 3 GPU (model card); CPU fallback is 2–4× slower and still pays GL upload + internal readback (only input route is a texture, see Section 2.4) | **High** (architecture + model card) |
| 2 | **Structural scheduling latency:** rVFC fires on frame *presentation*; bitmap is an extra async stage; `busy`-drop means returned pose describes a frame 1–2 frames old in the worst case | `poseClient.ts:64-82,152-165` | +0.5–1 frame beyond inference (~16–33 ms at 30 fps); including camera exposure/ISP (invisible without `captureTime`), typical total photon→action lag is ~50–120 ms | Medium-high (spec semantics) |
| 3 | **`createImageBitmap` per frame on main thread** | `poseClient.ts:158` | ~1–4 ms/frame and competes with the game for the main thread; removable via `new VideoFrame(video)` (Section 2.2) | High (API) / small magnitude |
| 4 | **Internal `texImage2D` in worker** | `$h` in `vision_bundle.mjs` | ~0.5–2 ms at 640×480; grows quadratically if camera delivers >640 and resize is removed — **current resize is the right protection**; do not remove without a countermeasure | High (bundle code) |
| 5 | **rAF + `currentTime` fallback processes duplicate frames** in browsers where `currentTime` is a real-time clock (older Firefox/Safari) | `poseClient.ts:73-80` | up to ~2× redundant captures of identical pixels; partially absorbed by `busy` | Medium (MediaCapture semantics + documented Chrome bug; affected browser share is small) |
| 6 | **`postMessage` + structured clone of POSE response** | both sides | <0.5 ms total; ~3 KB cloned — negligible | High |
| 7 | **GPU contention:** worker’s WebGL2 `OffscreenCanvas` and main-thread Three.js renderer compete for the same GL subsystem on weak integrated GPUs | cross-cutting | not measured — suspicion, not fact | Low |
| 8 | Detector/GameLoop/dispatch | `src/kinematics/*` | microseconds — negligible by design | High |

## 7.5 Measured local benchmark (headless Chromium 159, November 25, 2026)

Method: `scripts/pose-bench.html` spawns the **real worker from `dist/`** (`pose.worker-*.js` after build), initializes GPU and CPU, then sends 60 frames after 8 warmup frames, measuring round-trip `postMessage(FRAME) → POSE` (includes transfer and clone — the “inference” figure from rank 1 + transport). Inputs: real person photo resized to 640 px (`detected` = POSE with non-empty landmarks; source: `curl -o dist/pose.jpg https://storage.googleapis.com/mediapipe-assets/pose.jpg` — official MediaPipe demo image; without the file, the script runs only the synthetic image) and synthetic 640×480 image (never detected → person detector runs every frame = most expensive path). Browser: headless Chromium 159 **without dedicated GPU** — WebGL via SwiftShader (software GL). Full reproduction: `npm run build && cp scripts/pose-bench.html dist/bench.html && curl -o dist/pose.jpg https://storage.googleapis.com/mediapipe-assets/pose.jpg && npm run preview` → `http://localhost:4173/bench.html`.

| Input | Delegate | Init (ms) | p50 (ms/frame) | p90 | Detected | Poses/s (≈1000/p50) |
|---|---|---:|---:|---:|---:|---:|
| photo with person | GPU (SwiftShader) | 351–467 | **96.2–133.4** | 111–148 | 60/60 | ~7–10 |
| photo with person | **CPU (XNNPACK+SIMD)** | 251–301 | **16.0–20.3** | 16.8–23.9 | 60/60 | **~49–62** |
| synthetic image | CPU | 238–322 | **13.3–17.7** | 14.0–19.7 | 0/60 | ~57–75 |
| synthetic image | GPU (SwiftShader) | 252 | **168.9–196.7** | 242.7 | 0/60 | ~5–6 |

**Readings:**

1. **CPU on this machine delivers ~16–21 ms/frame (~48–62 poses/s) even on the most expensive path** — ample headroom over a 30 fps camera. Consistent with the model card (~44 fps on a 2018 Pixel 3), scaled to a modern desktop core (WASM is single-threaded; `hwc=16` is irrelevant).
2. **“GPU” on software GL is 6–12× worse than CPU** (~96–243 ms/frame ≈5–10 fps). The GPU delegate is fast only with real acceleration — on SwiftShader/llvmpipe/VMs/RDP it is *dramatically* worse, and **the app never falls back to CPU in this case**: `fallback()` triggers only on exceptions, not slowness. Derived action: detect a software renderer using `WEBGL_debug_renderer_info` (`gl.getParameter` — strings such as “WebKit WebGL”/“SwiftShader”/“llvmpipe”) and prefer CPU, or measure the first `detectForVideo` and fall back based on latency. Today a user with GPU blocklisted gets ~7 fps instead of ~50.
3. **Real warmup — measured:** with a person in the input, the **first** pose arrived on frame 0 (`firstPoseIndex`, recorded by the script — previously the count existed only after warmup), but the cost is elapsed time, not frame count: first frame ≈ **142 ms on CPU** and ≈ **2,016 ms on GPU** (versus p50 ~16/~96 for later frames). In other words, “first pose” latency is a spike on the first inference (lazy allocation + GL program compilation in the graph), not ~8 lost frames as the earlier version of this section reported — corrected after adding `firstPoseIndex` to the harness. A dummy frame at init would cover detector/allocation work; tracking acquisition in the landmarker stage warms only with a frame containing a person.
4. **`createImageBitmap` costs ~0.05 ms** from a canvas (a little more from `<video>`) — confirms this step is not a bottleneck; inference accounts for ~95%+ of measured round trip.
5. Detector-every-frame (stick figure, 0/60) is *cheaper* than tracked input (photo): ~13–18 vs ~16–20 ms on CPU — detection does not dominate for the Lite model at 640 px.

**Caveats:** the “GPU” result measures **only** software rendering (SwiftShader) — it **does not establish a range or bound** for latency with real browser GPU acceleration: neither the floor (a real GPU is probably much faster) nor the ceiling. The result establishes only the actionable observation in item 2 — software GL makes the GPU delegate perform very poorly *without triggering fallback*. End-to-end photon→pose latency is also not measured (needs `metadata.captureTime` — SHOULD in the spec and may be absent — plus a real camera).

---

**Improvement directions ordered by ROI:**

1. **Detect software GL (SwiftShader/llvmpipe/“Software”) and prefer CPU or latency-based fallback** — new finding from Section 7.5: GPU delegate on unaccelerated GL gives ~7 fps versus ~50 on CPU, without exception fallback.
2. `new VideoFrame(video)` in rVFC (removes stage 3; requires `frame.close()` in worker — Section 2.2). If `videoWidth > 640`, keep `createImageBitmap` with resizing (1080p upload would cost more than bitmap creation).
3. Read `metadata.captureTime`/`presentedFrames` for real latency telemetry and drop counts (Section 6.1).
4. With CPU fallback, reduce `resizeWidth` to ~320 (landmarker consumes 256² — extra resolution only pays for upload + readback).
5. Free features: `outputSegmentationMasks` for PiP silhouette; `GestureRecognizer` for menu gestures (Sections 6.3–6.4).
6. Do not pursue: threaded build (does not exist), WebGPU for vision tasks (dormant in 1.2.3), OpenCV.js (Section 4 verdict), pose-model switch (Section 5 table).

---

## Main sources

**Repository / node_modules (primary implementation evidence):**

- `src/cv/poseClient.ts:57-83` (rVFC + fallback), `:152-165` (busy/bitmap/transfer), `:167-170` (confidence)
- `src/cv/pose.worker.ts:12` (`forVisionTasks(_,true)`), `:16-24` (options), `:81-97` (`detectForVideo`/`close`)
- `src/App.tsx:118-120` (640×480@30 constraints)
- `node_modules/@mediapipe/tasks-vision/vision.d.ts:1862` (`ImageSource=TexImageSource`), `:2717` (`detectForVideo`), `:2852` (`RunningMode`), `:2176-2193` and `:2462-2483` (visibility/presence semantics), `:2766-2810` (masks + close), `:2956-3048` (`WasmModule`: `_bindTextureToCanvas`, `_addBoundTextureAsImageToStream` … `_waitUntilIdle`)
- `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` (minified): `$h` (texImage2D + GL context), `Yu.prototype.Da` (`_addBoundTextureAsImageToStream`), `finishProcessing`→`_waitUntilIdle`, `Dh` (`displayWidth` = VideoFrame), `Oh` (OffscreenCanvas/Safari ≥17), `Mh` (loader), `eb` in InteractiveSegmenter (only `getImageData` path)
- `node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm` — manually parsed sections (offset/flag), SIMD opcode counts, strings (`xnnpack`, `drishti`, `MlDriftWebGpu`, `webgpu_service.h`)
- `node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js:5570-5689` (WebGPU `_emwgpu*`/import bindings), `:96,377,385,5349,7566,7676` (`pthread` only in comments), ~`:340` (`instantiateStreaming`)

**Browser specs and docs:**

- wicg.github.io/video-rvfc (metadata, `captureTime` SHOULD for gUM, callbacks before rAF, `presentedFrames`)
- MDN/caniuse: `requestVideoFrameCallback` (C83/S15.4/FF132), `VideoFrame` constructor (C94/S16.4/FF130), `MediaStreamTrackProcessor` (C94 partial/S18/FF no), `ImageCapture.grabFrame` (C59/FF flag/S26), `createImageBitmap` options (`resizeWidth` FF98+/S15+/C54; `resizeQuality` FF149), `wasm-simd` (C91/FF89/S16.4), OffscreenCanvas
- web.dev/articles/requestvideoframecallback-rvfc (rate = min(video/browser))
- MDN `HTMLMediaElement.currentTime` (implementation-defined update rate); w3c/mediacapture-main#615 (MediaStream timeline = real time); issuetracker.google.com/issues/413061418 (Chrome per-frame interop bug)
- MDN `SharedArrayBuffer` (`crossOriginIsolated` required)

**Project docs and releases:**

- ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker (modes, world landmarks in meters/hip origin, detector + landmarker stages, livestream guidance)
- developers.google.com/edge/mediapipe/solutions/setup_web (WebGPU recommended for genAI; vision tasks share fileset)
- BlazePose GHUM model card (developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf): Lite 44 fps CPU/49 GPU on Pixel 3, 256² input, output 33×5 + 33×3 world
- github.com/google-ai-edge/mediapipe/releases: v1.2.2 “Remove non-SIMD WebAssembly builds”; v1.0.0 “Store wgpu::Instance in WebGpuService”; v1.1.0 “Expose per-landmark presence scores on the Web Tasks API”
- npm registry (`npm view`): tasks-vision latest=1.2.3 (Nov 11, 2026), nightly 1.3.0-rc.20261122; onnxruntime-web 1.31.1 (`ort-wasm-simd-threaded.wasm`=14.8 MB, `.jsep`=29.5 MB, unpacked 150.6 MB); `@tensorflow/tfjs` 4.22.0 (Jan 2025); `@tensorflow-models/pose-detection` 2.1.3; `@techstark/opencv-js` 5.0.0-release.1 (14.7 MB)
- docs.opencv.org/4.12.0 tutorial_js_setup (`--threads`, `--simd`, `--build_loader`, `--disable_single_file`); official sizes 4.14.0/5.0.0 via issoh.co.jp (Oct 2026); opencv/opencv#25425 (no official JS release) via `@haoking/opencvjs` README; intel/webml-polyfill#1348 (historical 8.1/9.0 MB)
- blog.tensorflow.org (May 2021): MoveNet 104 fps WebGL on MBP, BlazePose MediaPipe runtime 160 fps desktop vs 44 TF.js WebGL Lite
- github.com/open-mmlab/mmpose RTMPose README (i7-11700 latencies, AP, RTMDet two-stage); ultralytics.com/license (AGPL-3.0 covers code + models + weights)
- developers.googleblog.com LiteRT.js (Jul 2026) + developers.google.com/edge/litert/web (WebGPU/WebNN/XNNPACK WASM; TF.js successor)
- `.task` sizes (face 3.8 MB / hand 7.8 MB / gesture 8.4 MB / holistic 13.7 MB / pose_full 9.4 MB / pose_heavy 30.7 MB): catalog sources checked against `storage.googleapis.com/mediapipe-models` (sanderdesnaijer.com, Nov 15, 2026; issoh.co.jp, Oct 2026; LocalMode-AI `models.ts` with `sizeBytes`)
