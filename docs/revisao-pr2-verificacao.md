# Verification of code review findings — PR #2 (`docs/mediapipe-cv-research`)

Date: November 25, 2026 · Repo: `santleme/wii` · Branch reviewed: `docs/mediapipe-cv-research` (`fd69a8d`)
Method: each finding was checked against **primary sources** — the repository code, files in the installed package (`node_modules/@mediapipe/tasks-vision/`), upstream source code (`google-ai-edge/mediapipe` on GitHub, master branch), WICG/W3C specifications, and MDN/BCD. No claim was validated through a secondary source.

Legend: **confirmed** / **partially confirmed** / **refuted**.

> **Concurrency note (Nov. 25, 2026):** during this verification, **uncommitted** edits appeared in the working tree (`git status` was clean at the start of the session; at the end, `scripts/pose-bench.html` and `docs/pesquisa-pipeline-cv.md` were modified but uncommitted). The verdicts below describe the **committed state `fd69a8d`** — the state under review. The diff in progress already partially implements this report's corrections: `firstPoseIndex`/`firstPoseMsAfterReady` + `readyAt` (Finding 1), `resolve({type:'FELL_BACK'})` + `out.invalid` + a break on mid-run fallback (Finding 3), the photo URL in the script header (Finding 2), "SHOULD (not MUST)" for `captureTime` (Finding 7), and "shoulder widths per second" in the `worldLandmarks` item (Finding 6). The following remain **pending** in the observed diff: Finding 4 (GPU range caveat), 5 (`VideoFrame` PTS), 8 (`minTrackingConfidence` semantics — the old text remains), and 9 (audit warmup).

---

## Finding 1 — The benchmark does not record when the first pose appears

**Verdict: confirmed.**

**Evidence (code mechanics):**
- `scripts/pose-bench.html:57` — the `out` object has `times: [], bitmapMs: [], detected: 0, empty: 0, errors: []`; it has no field for the index of the first detection.
- `scripts/pose-bench.html:88-94` — `out.detected` is incremented only when `i >= WARMUP` (=8): `if (res.type === 'POSE') { out.times.push(dt); if (res.landmarks?.length) out.detected++; else out.empty++; }`. For warmup frames (`i < 8`), the only check is `res.type !== 'POSE'` → error; `res.landmarks?.length` is never inspected. In other words, a POSE with landmarks during warmup is silently consumed and never recorded.
- Documentation consequence: the claim in `docs/pesquisa-pipeline-cv.md:223` ("the first non-empty pose appeared about 8 frames after READY") **cannot be reproduced from `window.BENCH`** — the number exactly matches `WARMUP = 8` (`pose-bench.html:28`), raising the possibility that "about 8" is an artifact of the warmup cutoff rather than a measurement.

**Required fix (trivial and mechanically feasible):** add a field such as `firstPoseIndex` to `out`, captured inside the loop before the warmup branch, e.g. `if (out.firstPoseIndex === undefined && res.type === 'POSE' && res.landmarks?.length) out.firstPoseIndex = i;` — two lines are enough to support the claim in §7.5.

---

## Finding 2 — The reproduction command omits the photo (only the synthetic figure runs)

**Verdict: partially confirmed.**

**Evidence:**
- `docs/pesquisa-pipeline-cv.md:210` — the methodology **names** the source ("a real person photo resized to 640 px (`mediapipe-assets/pose.jpg`...)"), but the reproduction command on the same line is only `` `npm run build && cp scripts/pose-bench.html dist/bench.html && npm run preview` `` — **with no full URL and no download/copy step**.
- `scripts/pose-bench.html:2-5` — the script header only says "Optional: copy a photo with a person to `dist/pose.jpg`", also without a URL.
- `scripts/pose-bench.html:104-111` — confirmed mechanics: without `/pose.jpg`, `img.decode()` fails → `catch` → `console.log('No /pose.jpg — running only the synthetic figure.')` → `photo` remains `null` → the `if (photo)` block at `:118-121` is skipped, and the "photo with a person" rows in the §7.5 table **cannot be reproduced** from a clean build (where `dist/pose.jpg` does not exist).
- The primary URL exists and responds: `https://storage.googleapis.com/mediapipe-assets/pose.jpg` → HTTP 200, 44,100 bytes (HEAD checked on Nov. 25, 2026). It is the sample image used in MediaPipe demos/docs.

**Required fix:** add an explicit step to §7.5 (and ideally to the script comment), e.g. `curl -sL -o dist/pose.jpg https://storage.googleapis.com/mediapipe-assets/pose.jpg`, and note that the script itself resizes the photo to 640 px (`pose-bench.html:108-110`).

---

## Finding 3 — Mid-run GPU→CPU fallback mixes timings under the requested delegate label

**Verdict: confirmed** (with nuances that refine the finding's description).

**Evidence (worker):**
- `src/cv/pose.worker.ts:87-93` — when `detectForVideo` throws, the worker calls `await fallback(message)`; if successful, it posts `FALLBACK` (`:39`, inside `fallback()`) and then `ERROR` with `fatal: false` (`:91`). The `landmarker` instance is reassigned to `createTask('CPU')` (`:16`, called at `:38`) — **subsequent frames go through a real CPU landmarker on the same worker thread**.
- Confirmed: a `FRAME` after fallback reaches a real landmarker (`:74-86` — the path is unchanged; only the referenced object changed).

**Evidence (bench):**
- `scripts/pose-bench.html:83` — the per-frame promise resolves on `POSE` **or** `ERROR`. On the fallback frame, `FALLBACK` arrives (sets `out.fellBack = true`, `:84`) and then `ERROR` → the frame is counted in `out.errors`, not `out.times`.
- **Nuance A (not mentioned in the finding):** if fallback occurs during warmup (`i < 8`), the branch `else if (res.type !== 'POSE') { out.errors.push('warmup: ' + …); break; }` (`:94`) **aborts the entire run** — it does not mix timings; the run stops (`perFrame` ends up `{n: 0}`).
- **Nuance B:** if fallback occurs at `i ≥ 8`, the loop continues (`:93` only breaks when `errors > 3`), and subsequent frames — now inferred on CPU — have their `dt` values added to the same `out.times` as earlier GPU frames. `out.perFrame` (`:96`) aggregates this mixed population.
- `out.delegate` is set once, on the `READY` message (`:63`), and `out.requested` stores the requested delegate (`:57`). The `FALLBACK` message carries `to: 'CPU'` (`protocol.ts:59`), but the bench **does not update `out.delegate`** — it only sets `fellBack`. Therefore, the mixed summary is mislabeled — confirmed.

**Required fix:** the `fellBack` flag already exists (`:64`, `:84`) — it just needs to be used: (a) separate `times` by effective delegate (e.g., `times` → `timesByDelegate` or tag each frame with the current delegate, updating `out.delegate = m.to` in the `FALLBACK` handler), and/or (b) invalidate `perFrame` when `fellBack` is true (the mixed population does not represent any single delegate). This finding also supports recording `initMs` for the second module — mid-run fallback pays the full `createTask('CPU')` cost (~250–350 ms measured) within a single frame.

---

## Finding 4 — "the real-GPU range falls between measured CPU and the model card" (§7.5 caveat)

**Verdict: partially confirmed** — the caveat points in the right direction (SwiftShader ≠ real GPU), but presenting it as a bounded interval overclaims what was measured.

**Evidence:**
- What the benchmark actually establishes (`docs/pesquisa-pipeline-cv.md:210-217` + `pose-bench.html`): (a) CPU/XNNPACK on this machine ≈ 13–21 ms/frame; (b) the `GPU` delegate **under software GL** (SwiftShader) ≈ 96–243 ms/frame. Nothing else was measured.
- The statement in `docs/pesquisa-pipeline-cv.md:227` proposes a `[measured CPU, model card]` interval for a real GPU. There are two problems:
  1. **The model card is not an upper bound**: the document's own cited data contradicts this bound — `docs/pesquisa-pipeline-cv.md:167` cites the TF blog measuring MediaPipe WASM+GPU runtime at **92 fps (2019 MBP) and 160 fps (i9+GTX1070)** on the Lite model, both *faster* than the model card (~49 fps on a 2018 Pixel 3). A real desktop GPU can be **below** (faster than) the model-card number — it is a floor from an older phone, not an upper boundary.
  2. **Measured CPU is not a guaranteed lower bound**: nothing in the benchmark prevents a weak real GPU (a contended iGPU, poor driver) from being *slower* than the CPU delegate. That is unlikely compared with SwiftShader, but "unlikely" is not "measured".
- An honest statement of what the benchmark supports: real-GPU performance **was not measured**; external anchors (the model card + desktop figures cited in §5) suggest it may be far faster than SwiftShader and plausibly comparable to or faster than the measured CPU — but this is an inference, not a result.

**Required fix:** rewrite the caveat so it does not present a bounded interval, e.g.: "the benchmark does not measure a real GPU — external sources (model card at ~49 fps on a Pixel 3; up to 92–160 fps on desktops cited in §5) suggest performance comparable to or faster than the measured CPU, but this is not a result of this benchmark."

---

## Finding 5 — `frame.timestamp` as `timestampMs`: real PTS, but with a source-specific origin (resets between sessions)

**Verdict: confirmed** — the document's suggestion needs a caveat/correction; keeping `PoseClient`'s own millisecond clock (or rebasing PTS per session) is correct.

**Evidence (specifications):**
- WebCodecs, `VideoFrame(image, init)`, `HTMLVideoElement` branch: "Let currentPlaybackFrame be the `VideoFrame` at the current playback position" → `Initialize Frame From Other Frame` (https://w3c.github.io/webcodecs/#dom-videoframe-videoframe-image-init). At algorithm step 13: "If `timestamp` exists in init, assign it…; Otherwise, assign otherFrame's `[[timestamp]]` to frame's `[[timestamp]]`" — that is, `new VideoFrame(video)` inherits the PTS of the element's internal frame. The attribute is "the presentation timestamp, given in microseconds" — **with no defined epoch**.
- mediacapture-extensions, "Video timestamp concepts" section (https://w3c.github.io/mediacapture-extensions/#video-timestamp-concepts, merged from PR w3c/mediacapture-extensions#156): "**Each video frame must have a presentation timestamp which is relative to a source specific origin.** A source of frames can define how this timestamp is set." And under "Local video capture timestamps": "Local capture tracks have a **fixed offset between presentation timestamp and capture timestamp**. The user agent may let this be zero…" — that is, a camera frame's PTS is **relative to a per-track/source origin**, with an arbitrary offset defined by the user agent. A new `getUserMedia` call means a new track and a new origin → PTS can (and typically will) restart near 0.
- Corroboration: the rVFC spec itself says `mediaTime` "MAY have a zero value for live-streams or WebRTC applications" (wicg.github.io/video-rvfc §2.2) — per-stream relative clocks are normal for live sources.

**Evidence (code):**
- `src/cv/poseClient.ts:29` — `private lastTimestamp = 0` is client state, **never reset** in `beginCapture` (only `lastVideoTime` is reset, `:62`) or in `pauseCapture` (`:85-92`).
- `src/App.tsx:76-90` — `stopCamera()` calls `clientRef.current?.pauseCapture()` and stops the tracks, but **does not call `dispose()`**; `startCamera` reuses the same instance via `clientRef.current ??= new PoseClient()` (`:115`). That is, the worker and `lastTimestamp` survive the stop→restart camera cycle (`dispose` only runs in the unmount cleanup, `:43`).
- `src/cv/poseClient.ts:155-156` — `Math.max(now, lastTimestamp + 0.01)`: if `now` starts coming from a PTS that reset to ~0 in the new session, the clamp prevents regression (preserving VIDEO mode's "strictly increasing" requirement), but **all subsequent frames are timestamped in +0.01 ms increments** — temporal deltas become synthetic. The concrete consequence: the graph's internal OneEuro smoothing (which depends on `dt`) and app detectors using `snapshot.timestampMs` over real intervals (`cadenceTracker.ts:26-34` — 450 ms windows; `jumpDetector.ts:19,28` — 400/160 ms; `postureSignals.ts:19` — 350 ms; `swingDetector.ts:38,47` — `dt` floor of 1/120 s and 400 ms cooldown) start operating on 0.01 ms deltas → cooldowns effectively never expire and velocities become inflated/unrealistic.
- rVFC's `now` and `performance.now()` share the document's monotonic clock — neither resets between camera sessions. That is why the current clamp is robust: its base is monotonic *per page*, not per track.

**Required fix in `docs/pesquisa-pipeline-cv.md:63`:** qualify the claim "`frame.timestamp` = real PTS in µs — better than `performance.now()` for `timestampMs`": the PTS is real, but has a **source-specific origin** (mediacapture-extensions) and resets between tracks/sessions — which, combined with the warm worker and persistent `lastTimestamp`, would corrupt the deltas used by detectors and internal smoothing. Recommendation: keep `PoseClient`'s millisecond clock (rVFC `now`/`performance.now()`) for `timestampMs`, and use `frame.timestamp` only after rebasing it per session (subtracting the PTS of the first frame in the current capture) or as telemetry metadata.

---

## Finding 6 — Swing speed is measured in shoulder widths/s, not m/s

**Verdict: confirmed.**

**Evidence (full code path):**
- `src/kinematics/swingDetector.ts:25-26` — wrist/shoulder `worldLandmarks` inputs, measured in meters (confirmed: ai.google.dev pose_landmarker, "Task output" table — `worldLandmarks` in "meters… midpoint of the hips"; `PoseLandmarkerResult` in `vision.d.ts`).
- `src/kinematics/swingDetector.ts:29-30` — `lateral` = shoulder-to-shoulder vector in meters; `width` = `|lateral|` (meters), falling back to `calibration.world.shoulderWidth` (meters, `calibrator.ts:45,69`).
- `src/kinematics/swingDetector.ts:32-34` — component-wise `current` = `(wrist − shoulder) / width` → **dimensionless, in "shoulder widths"** — normalized *before* differentiation.
- `src/kinematics/swingDetector.ts:38-42` — `v = Δcurrent/dt`, `speed = |v|` → **shoulder widths per second**, not m/s.
- Thresholds in these units: trigger `speed >= 2` (`:47`), `softSpeed = 2`/`strongSpeed = 7` (`:15-16`, adjustable through `setPowerAnchors`), `lateralSpeed` also in widths/s (`:43` — projection of `v` onto the normalized shoulder-to-shoulder axis), `readyDistance < 0.35` (`:62`), and `aimValue` ±0.2 (`:52`) in shoulder widths — consistent with `calibration.world.readyWristLocal`, which the calibrator stores already normalized by `worldShoulderWidth` (`calibrator.ts:48` — same denominator).
- Scale reference: with shoulders ~0.4 m wide, "speed 2" ≈ 0.8 m/s and "speed 7" ≈ 2.8 m/s — plausible for a racket swing, but the unit stored in the code is dimensionless.

**Required fix in `docs/pesquisa-pipeline-cv.md:189`:** the phrase "uses wrist/shoulder positions in **meters** (racket swing speed in real m/s)" is partly correct — the *inputs* are in meters, but *speed* is in shoulder widths/s. Suggested wording: "uses wrist/shoulder positions in meters, but normalizes displacement by shoulder width **before** differentiation — speed and thresholds (`speed ≥ 2`, soft/strong 2/7) are in shoulder widths/s, dimensionless — this makes the detector invariant to camera distance, together with `readyWristLocal` in the same unit (`calibrator.ts:48`)." The same correction applies to `docs/auditoria-mediapipe.md:62` ("3D wrist speed — metric coordinates"), which also implies speed is in m/s.

---

## Finding 7 — `captureTime` is SHOULD in the specification, not "MUST"

**Verdict: confirmed** — and the document is internally inconsistent.

**Evidence:**
- WICG video-rvfc specification §2.2 (https://wicg.github.io/video-rvfc/#dom-videoframecallbackmetadata-capturetime), exact normative text for `captureTime`: "**SHOULD be present for WebRTC or getUserMedia applications, and absent otherwise.**" In WebIDL, the member appears without `required` (`[DOMHighResTimeStamp] captureTime;`) — in other words, it is an **optional** field that is `undefined` when absent.
- `docs/pesquisa-pipeline-cv.md:34` — says "`metadata.captureTime` — 'the time at which the frame was captured by the camera' — **MUST be present for getUserMedia sources** (spec §2.2)." "MUST" **overstates the normative requirement**.
- Internal inconsistency: the same document correctly states this in two other places — `docs/pesquisa-pipeline-cv.md:183` ("SHOULD for getUserMedia — WICG spec §2.2") and `:253` ("`captureTime` SHOULD for gUM").
- Actual support when present (primary sources): Chromium populates `captureTime` for gUM/WebRTC sources through `VideoFrame` capture metadata; Firefox implemented `captureTime`/`receiveTime`/`rtpTimestamp`/`processingDuration` in rVFC in **Firefox 132** (bug 1908245, bugzilla.mozilla.org — "for WebRTC related elements", including cameras — `PCameras.ipdl`, `MediaEngineRemoteVideoSource.cpp` files in the patch). When the field is absent (non-gUM source, browser without support), its value is `undefined` — telemetry needs a guard; this is not an error.

**Required fix:** in `pesquisa-pipeline-cv.md:34`, replace "MUST" with "should (SHOULD) be present — optional field; it is `undefined` when the source/user agent does not provide it". This aligns line 34 with lines 183/253.

---

## Finding 8 — `minTrackingConfidence` semantics: the audit is right, the research is not

**Verdict: confirmed** — for the Tasks API used by the app, the audit's description (`min_similarity_threshold` on `AssociationNormRectCalculator`) is mechanically correct; the research document's description (tracking confidence that triggers the detector again) describes the **legacy** `solutions/pose` API.

**Evidence (upstream, `google-ai-edge/mediapipe` master):**
1. JS → proto mapping (`mediapipe/tasks/web/vision/pose_landmarker/pose_landmarker.ts`, `setOptions`): `minTrackingConfidence` → `PoseLandmarkerGraphOptions.min_tracking_confidence`; `minPosePresenceConfidence` → `PoseLandmarksDetectorGraphOptions.min_detection_confidence`; `minPoseDetectionConfidence` → `PoseDetectorGraphOptions.min_detection_confidence`; `numPoses` → `PoseDetectorGraphOptions.num_poses`.
2. The only use in the Tasks graph (`mediapipe/tasks/cc/vision/pose_landmarker/pose_landmarker_graph.cc:376-379`): `pose_association.GetOptions<AssociationCalculatorOptions>().set_min_similarity_threshold(tasks_options.min_tracking_confidence())` — matching `docs/auditoria-mediapipe.md:155`. The local `.d.ts` (`vision.d.ts:2762-2765`) and official documentation (ai.google.dev pose_landmarker, "Configuration options") only say "minimum confidence score for the pose tracking to be considered successful" — vague and inconclusive.
3. What controls whether the person detector runs again (`pose_landmarker_graph.cc:353-371`): `prev_pose_rects` (loopback from the previous frame) → `NormalizedRectVectorHasMinSizeCalculator` with `min_size = num_poses` → `has_enough_poses` → `DisallowIf(image_in/norm_rect_in, has_enough_poses)` **skips `PoseDetectorGraph`** when there are enough rects. In other words, the trigger is the **count** of rects from the previous frame, not a score against `minTrackingConfidence`.
4. What empties `prev_pose_rects` (`pose_landmarks_detector_graph.cc`): inside `SinglePoseLandmarksDetectorGraph`, `pose_presence = presence_score > min_detection_confidence` (`:393-398`, where the subgraph's `min_detection_confidence` = **JS `minPosePresenceConfidence`**) → `GateCalculator` with `ALLOW=pose_presence` (`:401-406`) blocks the tensors → no landmarks → `POSE_RECT_NEXT_FRAME` is not emitted (`:560-586`) → the vector is empty → the detector runs on the next frame. **The threshold that governs redetection is `minPosePresenceConfidence`, not `minTrackingConfidence`.**
5. What the threshold actually does (`mediapipe/calculators/util/association_calculator.h`): IoU > `min_similarity_threshold` between rects from distinct streams → deduplication (the later stream's element replaces the earlier one) and `id` propagation — spatial association between rects from the previous frame and new detections, not "tracker confidence".
6. Additional point for the app configuration: with `numPoses=1` (`pose.worker.ts:19`), `has_enough_poses = (prev.size ≥ 1)` — the detector runs only when `prev` is **empty**, so the two association inputs are never non-empty at the same time → **`minTrackingConfidence` is effectively inert in this configuration** (it only acts with `numPoses ≥ 2` and partial tracking). The suggestion "0.5→0.4 reduces redetections" (`pesquisa-pipeline-cv.md:187`) is wrong in two ways: wrong threshold and an inert option.
7. Source of the confusion: in the legacy API (`mediapipe/python/solutions/pose.py`, v0.10.14), `min_tracking_confidence` mapped to `…ThresholdingCalculator.threshold` — a threshold on the landmark's own score, whose failure produced an empty frame → detection on the next frame. The "weak tracking → redetect" semantics existed there; the Tasks API reused the field name for association IoU.

**Required fix:**
- `pesquisa-pipeline-cv.md:187` — rewrite the item: "`minTrackingConfidence` is the minimum IoU (`min_similarity_threshold`) used by `AssociationNormRectCalculator` to match new detections with rects from the previous frame (deduplication/track ID inheritance — `pose_landmarker_graph.cc:376-379`); **the count** of previous-frame rects (`DisallowIf`/`has_enough_poses`), fed by presence, controls redetection — the effective threshold for 'lost tracking' is `minPosePresenceConfidence` (presence score inside the landmarker). With `numPoses=1`, `minTrackingConfidence` is effectively inert." The actual lever for "fewer redetections" is lowering `minPosePresenceConfidence`, with the trade-off of accepting poses with marginal presence scores.
- `auditoria-mediapipe.md:155` — the description is correct; optionally add the note that the setting is inert for `numPoses=1`.

---

## Finding 9 — Warmup with an empty frame does not cover the landmarker stage

**Verdict: partially confirmed** — the described mechanism is correct, but the audit document already partially mitigates it with the alternative "(or on the first bitmap)"; attributing "~8 frames" to the first detection remains an unmeasured hypothesis (connected to Finding 1).

**Evidence:**
- The upstream two-stage pipeline is confirmed (`pose_landmarker_graph.cc`): `PoseDetectorGraph` → rects → `MultiplePoseLandmarksDetectorGraph` (ROI loop through `BeginLoopNormalizedRectCalculator`, `pose_landmarks_detector_graph.cc:697`). With `pose_rects` **empty**, the begin-loop iterates zero times → `SinglePoseLandmarksDetectorGraph` is **never invoked** — the 256² warp/crop path, landmarker interpreter, `TensorsToLandmarks`, `RefineLandmarksFromHeatmap`, presence `ThresholdingCalculator`, `LandmarksToDetection` → `AlignmentPointsRects` → `RectTransformation` (emitter of `POSE_RECT_NEXT_FRAME`), and smoothing nodes never run.
- Consequence: `detectForVideo` on a 1×1 `OffscreenCanvas` (suggested in `docs/auditoria-mediapipe.md:134`) warms the graph, input conversion, and **detector interpreter** — but leaves the landmarker stage's lazy costs *untouched*. Those costs would occur on the first frame **with a person**. In other words, an empty frame does not cover first-detection latency — confirmed.
- Mitigation already present: the same line suggests "(or on the first bitmap)" — the camera's first real bitmap contains a person and covers both stages (with the caveat that the spike still occurs; it is only moved into the initialization window).
- Consistency with the measurement: the first pose at about frame 8 (`pesquisa-pipeline-cv.md:223`) is *plausibly* a combination of first-detector + first-landmarker + tracking acquisition — but, as Finding 1 notes, the harness does not record `firstPoseIndex`, and the value matches `WARMUP = 8`; the hypothesis that "some of the ~8 frames are first-detection latency" cannot be confirmed or refuted without instrumenting the bench.

**Required fix in `auditoria-mediapipe.md:134`:** qualify the suggestion — an **empty** frame warms only the detector stage; to also cover the landmarker stage's lazy costs (crop/warp + interpreter + presence + next-frame rect), warmup must use a frame **with a person** (the first bitmap itself, as already suggested in parentheses, or a synthetic image that passes the detector). Connect this observation to the instrumentation in Finding 1: `firstPoseIndex` in the bench would actually measure the frame cost of first detection.

---

## Requested low-cost checks (supporting facts)

| Fact | Verified in | Result |
|---|---|---|
| `FRAME` after fallback reaches real landmarker | `pose.worker.ts:32-46,74-86` | Yes — `landmarker` reassigned through `createTask('CPU')`; same `detectForVideo` path |
| `FALLBACK` precedes non-fatal `ERROR`; bench resolves on `ERROR` | `pose.worker.ts:39,89-91`; `pose-bench.html:64,83-84` | Yes — `out.fellBack` is already set; `delegate`/`requested` remain 'GPU' |
| `PoseClient` monotonic millisecond clock | `poseClient.ts:29,155-156` | `Math.max(now, lastTimestamp+0.01)`; `lastTimestamp` is never reset except at construction/dispose |
| `stopCamera` preserves worker/client | `App.tsx:76-90,115` | Yes — only `pauseCapture()` + `track.stop()`; `clientRef.current ??=` reuses it; `dispose` only on unmount (`:43`) |
| `captureTime` = SHOULD, optional field | wicg.github.io/video-rvfc §2.2 | Literally confirmed; doc lines :183 and :253 already say SHOULD — only :34 says "MUST" |
| `frame.timestamp` = inherited PTS, source-specific origin | webcodecs §9.4.2/9.4.6; mediacapture-extensions "Video timestamp concepts" | Confirmed — `source specific` origin, fixed offset per track |
| `mediapipe-assets/pose.jpg` URL | HEAD `storage.googleapis.com/mediapipe-assets/pose.jpg` | HTTP 200, 44,100 B — exists |
| `min_tracking_confidence` → `min_similarity_threshold` | upstream `pose_landmarker_graph.cc:376-379` | Confirmed — audit line :155 is correct |
| Redetection gate = count of prior rects | upstream `pose_landmarker_graph.cc:353-371` (`DisallowIf`/`has_enough_poses`) | Confirmed — not a score against tracking confidence |
| Swing: divide by shoulder width before differentiation | `swingDetector.ts:30-42`; `calibrator.ts:48` | Confirmed — units = shoulder widths/s and shoulder widths |

---

## Summary table

| # | Location | Verdict | Required fix |
|---|---|---|---|
| 1 | `pesquisa-pipeline-cv.md:223` / `pose-bench.html` | Confirmed | Script: record `firstPoseIndex` in `out` (2 lines) |
| 2 | `pesquisa-pipeline-cv.md:210` / `pose-bench.html:2-5` | Partially confirmed | Doc (and script header): full URL + `curl -o dist/pose.jpg` step |
| 3 | `pose-bench.html:81` (worker `pose.worker.ts:87-93`) | Confirmed | Script: use `fellBack` to separate `times` by delegate (update `out.delegate` on FALLBACK) and/or invalidate `perFrame`; warmup already aborts the run — document this |
| 4 | `pesquisa-pipeline-cv.md:227` | Partially confirmed | Rewrite caveat: real GPU not measured; external expectation has no strict bound (cited desktop figures exceed the model card) |
| 5 | `pesquisa-pipeline-cv.md:63` | Confirmed | Qualify: `frame.timestamp` is a real PTS in µs, but has a source-specific origin (resets between tracks); keep the client's ms clock for `timestampMs` or rebase per session |
| 6 | `pesquisa-pipeline-cv.md:189` (`swingDetector.ts:30-42` code) | Confirmed | Replace "real m/s" with "shoulder widths/s (dimensionless)"; likewise in `auditoria-mediapipe.md:62` |
| 7 | `pesquisa-pipeline-cv.md:34` | Confirmed | Replace "MUST" with "SHOULD/should; absent = `undefined`" (aligns with :183/:253) |
| 8 | `pesquisa-pipeline-cv.md:187` vs `auditoria-mediapipe.md:155` | Confirmed | Research: rewrite with Tasks semantics (association IoU; redetection governed by `minPosePresenceConfidence`/rect count; inert with `numPoses=1`). Audit: correct; optional note about being inert |
| 9 | `auditoria-mediapipe.md:134` | Partially confirmed | Qualify: an empty frame warms only the detector stage; full warmup requires a frame with a person (the "first bitmap" already covers this); connect to Finding 1 instrumentation |

---

## Concrete list of fixes

### `docs/pesquisa-pipeline-cv.md`
1. **L34**: `MUST be present` → `should (SHOULD) be present … optional field; is \`undefined\` when absent` (video-rvfc spec §2.2; aligns with L183/L253).
2. **L63** (§2.2 conclusion): qualify `frame.timestamp` — real PTS in µs, **source/track-specific origin** (mediacapture-extensions): resets for each new `getUserMedia`; with a warm worker and persistent `lastTimestamp` (`poseClient.ts:29,155`), using the raw value would flatten deltas after restarting the camera. Keep `PoseClient`'s ms clock for `timestampMs`; use `frame.timestamp` only after per-session rebasing or as telemetry.
3. **L187** (§6 item 5): correct the semantics of `minTrackingConfidence` — it is `min_similarity_threshold` (IoU) in `AssociationNormRectCalculator` (`pose_landmarker_graph.cc:376-379`), inert with `numPoses=1`; the actual redetection control is `minPosePresenceConfidence` (presence → `POSE_RECT_NEXT_FRAME` → `has_enough_poses` → detector `DisallowIf`).
4. **L189** (§6 item 7): replace "real m/s" with speed in **shoulder widths/s** (`swingDetector.ts:30-42`), consistent with `readyWristLocal`/`world.shoulderWidth`.
5. **L210** (§7.5 methodology): add the photo retrieval step — `curl -sL -o dist/pose.jpg https://storage.googleapis.com/mediapipe-assets/pose.jpg` — before `npm run preview`.
6. **L223** (reading 3): make the "~8 frames" claim conditional on instrumentation (`firstPoseIndex`) or label it as an observation; note that it matches `WARMUP=8`.
7. **L227** (caveats): remove the "between measured CPU and model card" bound — real GPU was not measured; external anchors (Pixel 3 model card; 92–160 fps desktop figures in §5) suggest performance comparable to or faster than CPU, without a benchmark bound.

### `docs/auditoria-mediapipe.md`
8. **L62**: "3D wrist speed — metric coordinates" → clarify that speed is measured in shoulder widths/s after normalization (`swingDetector.ts:30-34`).
9. **L134**: specify that `OffscreenCanvas 1×1` warms only the detector stage (the landmarker never runs without an ROI — `BeginLoopNormalizedRectCalculator` iterates zero times); for full warmup, use a frame with a person (the already-mentioned "first bitmap").
10. **L155** (optional): add that with `numPoses=1`, `min_tracking_confidence` is effectively inert (association matches rects only when detector output and previous rects coexist — only with `numPoses>1`/partial tracking).

### `scripts/pose-bench.html`
11. Record the first pose: add `if (out.firstPoseIndex === undefined && res.type === 'POSE' && res.landmarks?.length) out.firstPoseIndex = i;` inside the loop (`:72-95`), and document it in the header/`out`.
12. Mid-run fallback: in the `FALLBACK` handler (`:64`, `:84`), in addition to `out.fellBack = true`, update `out.delegate = m.to` and separate/invalidate timings — e.g., timings by effective delegate or mark `perFrame` with `mixed: true`/`invalid`. Note: fallback during warmup already aborts the run (`:94`) — mixed results only occur after warmup.
13. Header (`:2-5`): include the concrete sample photo URL (`https://storage.googleapis.com/mediapipe-assets/pose.jpg`) for reproduction matching §7.5.
