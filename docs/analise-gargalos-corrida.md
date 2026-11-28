# Bottleneck Analysis for the Running Game — Nevergear Web Sports Arena

Date: November 25, 2026 · Commit analyzed: `17b6fed` ("resolve merge: main worker protocol + kinematics profile shape") — a **draft merge** on local branch `analysis/merged-prs`, representing `main` as if three changes were already merged: PR #5 `cv/kinematics-engine`, `feat/camera-auto-calibration` (`eedb6c0`), and PR #6 `feat/running-pace` (`266e042`). Conflicts were resolved in favor of PR #5's format.

> **Historical note (2026-11-25):** The mechanism descriptions throughout this note — cadence from a Schmitt trigger on knee lift, jumping against calibrated `hipY0`, calibration requiring knees/ankles — document the **earlier** implementation analyzed in the cited commit. On the `feat/torso-detection` branch, all of these mechanisms have been replaced: cadence uses torso vertical oscillation, jumping uses an adaptive baseline without calibration, and calibration is torso-only. This note is now useful for its physical bottleneck analysis (which motivated the redesign) and history of alternatives — not as a reference for the current system. For the current system, see `docs/pesquisa-deteccao-pelo-torso.md` and the code under `src/kinematics/`.

This note analyzes **only the running game** (Hurdle Rush) end to end. Generic CV pipeline bottlenecks — WASM, startup chain, caching, one-frame-in-flight throughput ceiling, Safari — have already been audited in `docs/analise-de-gargalos.md` and `docs/pesquisa-pipeline-cv.md`; they appear here only where they affect running. Tests in the merged state: **79 passing** (`npm test`, 4 files).

---

## What this project state looks like

The merged Hurdle Rush works as follows (code citations use `path:line` in the working tree):

1. **Capture** — `PoseClient.beginCapture` schedules frames through `requestVideoFrameCallback` with an rAF fallback (`src/cv/poseClient.ts:67-85`), allows one frame in flight (`poseClient.ts:168`), uses a 640px `createImageBitmap` (`poseClient.ts:177`), a module worker + `useModule: true` (`src/cv/pose.worker.ts:12`), and synchronous `detectForVideo` (`pose.worker.ts:81`). MediaPipe initialization runs **in parallel** with `getUserMedia` (`src/App.tsx:102-105`), and assets are warmed once permission has been granted (`App.tsx:31-34`, `poseClient.ts:39-42`). Assets are immutable and hash-named (`vercel.json`, `src/cv/mediapipeAssets.ts`).
2. **Automatic calibration** — `AutoCalibrator` requires shoulders + wrists + hips + knees at confidence ≥0.55, 1 s standing still + 3 s of collection (`src/cv/autoCalibrator.ts:5-10,22-48`); `Calibrator.finish` requires ≥12 samples, a span ≥2.8 s, and ≥65% valid frames (`src/cv/calibrator.ts:23-57`). It produces a `CalibrationProfile` with `dominantHand`, `image.{torsoHeight,hipY0,kneeToHipY0,shoulderWidth}`, and `world.{shoulderWidth,torsoUp0,torsoLeanRad0,readyWristLocal}` (`src/cv/protocol.ts:22-45`).
3. **Feature-specific kinematics** — independent gates: body `[11,12,23,24]` in image space, cadence `[23,24,25,26]` in image space, jump `[23,24]` in image space, lane `[11,12,23,24]` in world space, swing `[11,12,23,24,wrist]` in world space (`src/kinematics/actionPipeline.ts:9-13`). Gate: 3 good frames → `tracked`, 4 bad frames → `lost` (`trackingGate.ts:26-36`). Events carry `trackingState` and confidence from their own landmark set (`protocol.ts:95-114`).
4. **Cadence → speed (PR #6)** — Schmitt trigger per leg over the filtered knee-lift signal (thresholds 0.1/0.05, 220 ms cooldown), median-3 step intervals, `cadenceSpm = 60_000/max(period, elapsed)`, stop after `min(1.6·period, 1600 ms)`, `SPEED_BY_CADENCE` mapping anchored at 40→0.1 / 100→0.3 / 137.5→0.55 / 200→1 (`cadenceTracker.ts:8-19,59-71`); gait idle/walk/run with 0.55/0.5 hysteresis (`gait.ts:4-9`).
5. **Game** — `TrackGame.onAction` applies `sprint`/`jump`/`lane` events to state (`TrackGame.ts:86-90`); simulation runs at a fixed 1/60 step (`GameLoop.ts:43-56`); displayed speed is smoothed with τ≈167 ms (`TrackGame.ts:104`); jumps always use a fixed 0.72 s / 1.35 u arc (`TrackGame.ts:95,120-123`); an obstacle crosses the check at `z>0.2` and is cleared if it is in another lane OR a jump was recent (`jumpTime>0.15`) OR height >0.45 (`TrackGame.ts:128-132`); obstacles spawn every ~26 u traveled at `z=-48-rand5` (`TrackGame.ts:139-142`); score is `dt·speed·50` +100/−35 per obstacle (`trackScore.ts:4-15`); HUD updates at 5 Hz (`TrackGame.ts:39`).
6. **Dispatch** — `App.tsx:82-95` runs `pipeline.update` for each POSE and dispatches `result.events` to `engineRef.current?.onAction` in the same task. **`result.controls` and `result.kinematicsMs` have no consumer** — they are an unused surface returned by PR #5 (the PR author noted this in the PR description).

What the merges fix from the previous report: the `useModule` bug (#1), caching/compression (#3), worker respawn (#5), dead WASM in the deployment (#6), and serial initialization (#2, partially — WASM + model now warm in parallel with permission). **Still relevant to running**: the one-frame-in-flight throughput ceiling (#7 in the audit) and unmeasured photon-to-screen latency.

---

## Executive summary

| # | Bottleneck | Severity | Confidence |
|---|-----------|----------|------------|
| 1 | **Pose/s ceiling becomes the cadence ceiling**: the pacing mechanic needs ~2–3 samples per knee lift; at ~15 poses/s, the author measures undercounting at 170 spm and missed steps at 190; at ~5–10 poses/s (GPU delegate on software GL, **which never falls back to CPU** — measured at 96–243 ms/frame in `docs/pesquisa-pipeline-cv.md` §7.5), even ~138 spm walking pace cannot reach "run". The UI reveals no degradation. | **High–Critical (on weak hardware)** | Mechanism is certain; rates measured locally; frequency among real users unknown |
| 2 | **Jump × running bounce use the same hip signal**: arming/releasing requires `rise ≤ 0.03` for 160 ms and triggering requires `rise ≥ 0.08` at ≥0.5 torso/s for 30 ms (`jumpDetector.ts:5-7,24-55`). Real vertical running oscillation (~7–9 cm peak-to-peak ≈ 0.07–0.18 torso) falls exactly in the marginal range: it may trigger false jumps (~2.5/s given the 400 ms refractory period) or lock `airborne` so no real jump is detected — even though jumping is required to clear obstacles. | High | Mechanism verified in code; outcome **not verified on real hardware** — only the 0.05 bob test exists |
| 3 | **A one-frame hitch**: one `degraded` frame at the cadence gate immediately emits `sprint` with speed 0 (`actionPipeline.ts:47-50`) — this is the written contract (`protocol.ts:89-90`), but at ~30 poses/s each knee-confidence dip (the landmark most blurred during a fast stride) drops `speed01` for ~100–500 ms; at ~7 poses/s the dip lasts ~0.4–0.9 s (3 good frames to recover). | Medium–High | Verified in code and test (`kinematics.test.ts:407-420`); real-world frequency depends on hardware |
| 4 | **Stopping latency is 2–3× above the cited target**: stopping takes `min(1.6·period, 1600 ms)` ≈ 0.5–1.6 s in the playable range; the GUD WIP cited in PR #6 for "latency goals" stops ~500 ms after the last step. Starting is similar: requires 2 step events (~1 period) + pipeline ≈ 0.7–1.3 s until first movement. | Medium | Verified (calculation); continuous decay between steps softens the perception |
| 5 | **Jump window × end-to-end latency**: the event must arrive ≤~642 ms before an obstacle crossing (union of `jumpTime>0.15` and `y>0.45`); typical physical-to-application latency ≈ 60–150 ms → physical takeoff must happen ~0.5–0.6 s before the obstacle arrives; jumping "early" fails (fixed arc) and keyboard input is instant — parity is broken. | Medium | Calculation verified; real photon-to-action latency never measured |
| 6 | **Lane noise during walking**: `legsVertical` estimates vertical from the midpoint of the knees, which oscillates laterally with each step → reference swings ~±7–12° per step, near the 0.15 rad trigger threshold. The fixture never moves world-space knees → this path is untested. | Medium–Low | Mechanism plausible; not verified on real poses |
| 7 | **Calibration gate requires the whole body still for 4 s** (shoulders + wrists + hips + knees ≥0.55): running only needs hips + knees — a player whose knees are out of frame cannot calibrate or play; a quality failure silently restarts the cycle. | Medium (onboarding) | Verified in code |
| 8 | **Operational blindness**: no `inferenceMs` in the new protocol, no poses/s in the UI, no `presentedFrames`, and `controls`/`kinematicsMs` have no consumer — CV degradation is indistinguishable from "the player stopped" when debugging. | Low–Medium | Verified |

> Note on accuracy: **nothing in this state has been exercised with a real camera and real person** — the PR #6 author states "Not yet verified with a real person walking or running in front of a webcam" and documents the 15 fps limit in the PR body under "Known limit". All human signal amplitude figures below are literature estimates, explicitly marked as such.

---

## Bottlenecks

### 1. The poses/s ceiling is the cadence ceiling — and the worst case never triggers fallback

**What it is.** Counting steps requires each knee lift to produce enough samples above the 0.1 threshold through the 1€ filter (`cadenceTracker.ts:32-46`, `oneEuroFilter.ts`, `schmittTrigger.ts:9-16`). The above-threshold knee pulse occupies ~40–50% of the step period (gait estimate; not measured in a person). Samples per pulse ≈ 0.45·(60 000/spm)/frame interval:

| Effective poses/s | Frame | Pulse at 138 spm (~200 ms) | Pulse at 190 spm (~140 ms) | Consequence for running |
|---|---|---|---|---|
| 30 (healthy) | 33 ms | ~6 samples | ~4 | recordable ceiling = `MIN_STEP_INTERVAL` 220 ms ≈ **272 spm** — ample headroom over the map ceiling (200 spm → speed 1) |
| 15 | 66 ms | ~3 | ~2 | author's measured limit: 170 undercounted, 190 missed |
| ~10 (weak CPU) | 100 ms | ~2 | ~1.4 | run gait (~138 spm) becomes a coin toss — `speed01` cannot stably exceed ~0.5 |
| ~5–7 (GPU delegate on software GL) | 143–200 ms | ~1–1.4 | <1 | even proper walking fails: missed steps halve `cadenceSpm` on every miss (`60_000/max(period, elapsed)`, `cadenceTracker.ts:70`) |

The structural ceiling comes from one frame in flight + synchronous `detectForVideo` (general audit, item #7): `poses/s ≈ min(30, 1000/round-trip)`. Local measurements (same machine, `pesquisa-pipeline-cv.md` §7.5): **CPU ~16–21 ms → ~48–62 poses/s; "GPU" through SwiftShader ~96–243 ms → ~5–10 poses/s — and fallback only triggers on an exception** (`pose.worker.ts:32-46,87-94`), not slowness. In other words, a user with a blacklisted GPU, VM/RDP, or software GL gets ~7 poses/s **silently** — the worst possible regime for this mechanic, with no warning.

**Specific impact on running.** Runner speed is derived from measured cadence: below ~15 poses/s, the game cannot distinguish a "slow player" from a "slow pipeline" — someone running in place at 180 spm sees the avatar walk (~speed 0.5), obstacles move in slow motion, and the animation is out of sync. This is the game's structural bottleneck: its central mechanic (pace = speed) is the most sampling-rate-sensitive mechanic in the product.

**Fix direction:**
- Detect software GL (`WEBGL_debug_renderer_info` → "SwiftShader"/"llvmpipe"/"Software") and prefer CPU, or measure the first `detectForVideo` and fall back **based on latency** — already recommended in research §7.5 and the highest-ROI action for this game.
- Expose effective poses/s (or at least `presentedFrames` discontinuities + round-trip ms) — today `inferenceMs` is not even carried in the new protocol and `kinematicsMs` (`actionPipeline.ts:23,76`) has no consumer.
- Use `VideoFrame` directly in rVFC to remove the bitmap stage (research §2.2); use `resizeWidth` ~320 in CPU fallback.
- If low effective frame rate is a target use case, consider adapting the lift threshold to measured frame rate — risky; mark as untested.

### 2. Jump and running compete for the same hip signal — the game's required combination is the least tested

**What it is.** `JumpDetector` measures `rise = (hipY0 − hip.y)/torsoHeight` in **image space** (`jumpDetector.ts:20-21`). State machine:

- `armed` (once armed, never disarms until `reset`): requires `rise ≤ 0.03` continuously for 160 ms (`:24-31`);
- trigger: `rise ≥ 0.08` **and** velocity ≥0.5 torso/s sustained for 30 ms (`:5-7,37-47`), with a 400 ms refractory period (`:41`);
- `airborne` is released only after another 160 ms of `rise ≤ 0.03` (`:48-54`).

**The physical problem.** The vertical oscillation of the center of mass while running is ~7–9 cm peak-to-peak (6.5–13.1 cm; MSSE abstract, doi 10.1249/01.mss.0001061236.55291.a0 — measured on a treadmill; the sacral point follows the CoM within ±1.5 mm, PubMed 19356933). In torso units (~0.5–0.55 m), this is an amplitude of ~0.07–0.18 per cycle, at ~2.3–3.3 Hz at running cadence — **exactly the marginal range between the 0.03 and 0.08 thresholds**.

> **Correction (2026-11-25):** The original version of this note said "~1.4–1.6 Hz" — an error by a factor of two. Vertical oscillation in running happens **once per step**, not once per stride: in the playable range (140–200 spm), that is 2.3–3.3 Hz, the step frequency itself. Primary sources are in `docs/pesquisa-deteccao-pelo-torso.md` §1. This correction does not change the qualitative conclusion — the amplitude × velocity conjunction is still marginal — but it worsens the picture for the old detector: at a higher oscillation rate, the 30 ms hold windows become even shorter, and the old detector's 1€ filter with fcmin 1 Hz attenuated the amplitude in this band. The actual outcome is different and better: this bottleneck was resolved on the `feat/torso-detection` branch with the "adaptive reference" direction recommended here — adaptive baseline on the torso channel, cadence measured from the vertical oscillation itself (no longer from knees), and jump thresholds re-anchored to the filtered signal chain (0.1 torso / 1.2 torso/s, initial values to validate on a real camera). For a sine wave with amplitude A and frequency f: the conjunction `rise ≥ 0.08 & velocity ≥ 0.5` holds only near the fast ascent and near the peak — with A≈0.1/f=1.5 Hz it lasts ~9 ms per cycle (< 30 ms, so it does not trigger; the existing bob test uses 0.05: `kinematics.test.ts:136-145`); with A≈0.15 it lasts ~48 ms > 30 ms → **it triggers**. Three possible outcomes depending on real amplitude/posture:

1. Moderate bounce (trough ≤0.03 for ≥160 ms): arms and works — the game detects a jump on ascent.
2. Bounce in the threshold band (peak ≥0.08 with sufficient velocity): **false jump on every cycle** (up to ~2.5/s due to the 400 ms refractory period) — the runner "jumps" on its own and clears obstacles for free.
3. High bounce at the trough (never ≤0.03 for 160 ms): if a false or real jump locks `airborne`, it **never releases** while running → subsequent jumps are dead (`!this.airborne` at `:41`).

Calibration complicates this: while running, average posture is lower (bent knees) → mean `rise` becomes negative, which helps (moves it away from the threshold); but `torsoHeight` shrinks in the same proportion → normalized `rise` grows → pushes it back. Net effect not measured. An earlier pose-kinematics analysis also identified baseline drift with changing camera distance and found no tested variant that solved it.

**Impact.** Jumping *while running* is mandatory — there is no option to walk around an obstacle. If outcome 2 or 3 occurs, the game visibly breaks (phantom jump) or silently fails (jump ignored). This is the biggest gameplay unknown in this merge.

**Fix direction:** measure the real signal first (log filtered `rise` during 10 s of walking + jumping — no published figure exists for the Lite model). Likely paths: adaptive reference (baseline = moving median of hip position), subtract the periodic component at the cadence measured by `CadenceTracker`, or require the lift of **both** knees (a real jump raises both legs). The 0.05→0.15 range merits a synthetic sweep before hardware testing.

### 3. One bad frame stops the runner — stop-on-degraded becomes chronic hitching

**What it is.** Any state other than `tracked` at the cadence gate immediately emits `sprint {speed01: 0}` once (`actionPipeline.ts:47-50`, `sprinting` latch at `:20,45,87-91`). This is the contract: `ContinuousControls.sprintSpeed01` is "Always neutral when cadence tracking is degraded or lost" (`protocol.ts:89-90`), and the test fixes this behavior (`kinematics.test.ts:415-417`). The game receives `speed01=0` and `shownSpeed` decays with τ≈167 ms (`TrackGame.ts:104`) — a 33 ms dip drops displayed speed by ~45%, and recovery takes another ~300–500 ms (3 good frames to rearm the gate + a new easing rise).

**Why it hurts this game.** Required landmarks are hips + knees (25,26) — exactly the ones most affected by motion blur during a fast stride (knee angular velocity is greatest precisely when the player runs fastest). Each confidence blink causes a micro-stop; on a slow device, the gate needs 3 frames at ~143–200 ms each to recover → stop-and-go cycles of ~0.4–0.9 s. Combined with finding #1, this is the "hitching runner" effect on the hardware that needs the game to work most.

**Fix direction:** the contract can stay; the game can absorb the effect: `TrackGame` can ignore `sprint{0}` events marked `degraded` (the event already carries `trackingState`, `protocol.ts:111`) or apply short hysteresis (e.g. only set speed to zero after ~300 ms of neutrality), while preserving a guaranteed stop on `lost`. Alternatively, emit the stop in the pipeline only on `lost` (4 consecutive bad frames ≈ ≥132 ms) and let `degraded` hold the last speed — this changes the written contract and is a product decision.

### 4. Starting and stopping are ~2–3× slower than the latency target cited by the PR itself

**What it is.** `CadenceTracker` measures frequency only **between complete step events**: it needs 2 threshold crossings (one interval) for the first `speed01>0` (`cadenceTracker.ts:59-69`); and declares a stop after `min(1.6·period, 1600 ms)` (`:13-14,69`).

- **Starting**: the first event occurs midway through the first knee lift + one period → ~0.6–1.0 s physical + ~0.1–0.2 s pipeline ≈ **0.7–1.3 s until the avatar moves**.
- **Stopping**: ~0.5 s (at 190 spm) to 1.6 s (≤60 spm — the `MAX_STOP_DELAY_MS` cap applies), plus visual easing.

**Primary reference — GUD WIP (PMC4303911, Wendt/Whitton/Brooks, IEEE VR 2010):** the system PR #6 cites for "start and stop latency goals" (a) estimates frequency **from fractions of a step** — each completed gait-cycle state updates the estimate, 3 updates per step; (b) detects a stop when a double-support state exceeds its expected duration, stopping **~500 ms after the last step** (0.8 Hz threshold); (c) identifies Foot Off using a combined position **and** velocity threshold (0.02 m + 0.5 m/s) — making it tolerant of maneuvers. The current tracker uses position + Schmitt only: equivalent to the LLCM-WIP that GUD WIP superseded, with the benefit of continuous decay through `elapsed` — which already implements half of the idea (speed fades before the binary stop → stopping is *perceived* before `1.6·period`).

**Impact:** stopping is ~2–3× slower than the cited target; starting is ~1 period slower than achievable with fractional-step estimation. Acceptable for an arcade game, but this is the difference between feeling "responsive" and "sluggish" on first impression.

**Fix direction:** adopt the GUD WIP idea without rewriting everything — use knee-lift *duration* (time between on and off crossings) to predict frequency on the first step; for stopping, reduce `STOP_AFTER_PERIODS`/`MAX_STOP_DELAY_MS` or detect "prolonged double support" (both lifts ≤0.05 for longer than ~the expected state duration) — `needsNeutral` already measures exactly that for arming.

### 5. Jump window × end-to-end latency — the gesture's physics must anticipate the pipeline

**Photon-to-game-state latency budget (components and sources):**

| Stage | Estimate | Source |
|---|---|---|
| photon→presentation (sensor/ISP/gUM) | ~30–80 ms | not measured in this project; correct instrument = `metadata.captureTime` (WICG spec: SHOULD for gUM) — currently ignored (`poseClient.ts:71` uses only `now`) |
| presentation→rVFC callback | 0–1 vsync (up to ~17 ms) | spec: "callback can occasionally be fired one v-sync late"; under load, frames may be skipped (`presentedFrames`) |
| `createImageBitmap` | ~1–4 ms | previous audit; ~0.05 ms measured from canvas (research §7.5) |
| `postMessage` round trip | ~1 ms | negligible |
| `detectForVideo` | ~16–21 ms measured on CPU / ~5–25 on real GPU / ~96–243 software GL | research §7.5 (Chromium 159 headless); model card ~20–23 ms on Pixel 3 |
| dispatch→state→render | 0–17 ms | synchronous task + next `setAnimationLoop` tick |
| **Total** | **~60–150 ms typical; ~300–500 ms in worst-case software GL** | |

Internal timestamps (`snapshot.timestampMs` = rVFC's `now`, `poseClient.ts:71-74,173`) measure **presentation** — a uniform monotonic clock (the `lastTimestamp+0.01` clamp satisfies VIDEO mode's increasing-timestamp requirement — ai.google.dev, "monotonic timestamps"). Intervals measured from it (step period, velocities) are **unbiased** — constant delay cancels out. Only *application* of an event is delayed: the game does not use `event.timestampMs` to time anything; it applies events on arrival (`TrackGame.ts:86-90`).

**Consequence for jumping.** An obstacle is cleared if `jumpTime > 0.15` **or** `y > 0.45` at crossing (`TrackGame.ts:128-132`). With the 0.72 s / 1.35 u arc, `y>0.45` covers 78–642 ms after the event; `jumpTime>0.15` covers <570 ms → **the union allows an event applied up to ~642 ms before crossing**. With Δ≈60–150 ms latency, physical takeoff must happen ~490–580 ms before the obstacle arrives — at maximum pace (22 u/s), ~11–13 u away, or "when the obstacle is halfway here". Jumping earlier than ~650 ms fails (the arc has already descended — the jump is fixed, jumping higher in real life does not extend the arc). It is playable, but requires anticipation that the on-screen feedback does not teach: the game sees the arc ~0.1–0.2 s after the player's body.

**Broken parity:** keyboard input instantly sets `jumpTime=0.72` (`TrackGame.ts:95`) — the physical window is ~640 ms plus however much earlier the player wants to jump — versus ~500 ms useful time through the camera. Same for lanes (immediate ±1 vs. crossing a threshold + 350 ms cooldown + pipeline).

**Fix direction:** measure `captureTime` when telemetry returns; if the window is too short on real hardware, widen it by design (check the crossing at `z>0.2` against a ~0.9 s jump window, or bring the obstacle forward based on current speed) — do not lengthen the arc, which is already generous.

### 6. Unstable vertical reference while walking → lane-lean noise

**What it is.** `torsoLeanRad` measures lateral tilt against vertical **estimated from the legs** — `hip_mid − knee_mid` (`bodyFrame.ts:79-89`), falling back to calibrated `torsoUp0` when knees are out of view/low confidence (<0.55 or span <0.1). Thresholds: trigger at ≥0.15 rad, rearm at ≤0.1, 350 ms cooldown (`postureSignals.ts:19-28`).

**The risk.** While walking, knees alternate upward: the knee midpoint rises and shifts laterally with each step → the "vertical" swings by approximately `atan(Δx_knee_mid/span)` ~7–12° (~0.12–0.2 rad) at step frequency — near the 0.15 rad threshold. The result may be: hysteresis cycling without triggering (fine), false triggers capped at ~3 lane changes/s by the cooldown, or no trigger — depending on real amplitudes that have not been measured. The test suite **never exercises this**: the fixture holds `world[25]/[26]` fixed (`tests/fixtures/syntheticPose.ts:44-45`) — gait tests (`pace.test.ts:19`) move *image-space* landmarks only. Lane tests use a static torso or yaw rotation (`kinematics.test.ts:292-372`).

**Fix direction:** use a short moving average of the reference (or lock it while `cadenceSpm > 0`); add a synthetic test with alternating world-space knees.

### 7. Calibration gate: whole body + 4 s standing still, for a game that only needs hips and knees

**What it is.** `AutoCalibrator` requires `[11,12,15,16,23,24,25,26]` all ≥0.55 (`autoCalibrator.ts:10,22`), ~1 s settling + 3 s collection, anchored to stationary shoulders + hips at ≤0.04 (`:8,33`). A quality failure returns to `framing` and retries without a specific message (`:46-48`). UI guidance already says "shoulders to knees, with hands visible" (`CameraPip.tsx:17`) — a **tennis** requirement (wrists) imposed on **running**.

**Impact:** a small space, tall person, or low camera that does not include the knees → endless `framing`/`settling`, and the running game — which uses only cadence (hips + knees) and jumping (hips) — becomes unplayable due to an unrelated requirement. A device at ~7 poses/s (finding #1) can still calibrate (12 samples/2.8 s is generous), but every anchor reset costs the same 4 s.

**Fix direction:** requirements by sport (running: 23–26 only); show a guided recalibration message when `finish` returns null (reason: span/sample count/quality).

### 8. Operational blindness — degradation is invisible to both players and debuggers

**What it is.** No channel remains for measuring CV health: `inferenceMs`/`receivedAtMs`/`frameId` were removed from the protocol (the previous audit listed them as dead code — they are now not even transported); `kinematicsMs` and `controls` are computed and discarded (`actionPipeline.ts:23,76`, `App.tsx:84-95`); rVFC's `metadata.presentedFrames`/`captureTime` are ignored (`poseClient.ts:71`); HUD only shows `PACE %` (`GameCanvas.tsx:55`).

**Impact:** the visible symptoms of all findings above — truncated cadence, gate dips — cannot be distinguished from "the person stopped moving". There is no local telemetry for the player ("weak signal") or developer (console/metrics).

**Fix direction:** a minimal debug panel (poses/s, delegate, ms/frame, per-feature `trackingState`) behind a flag; or a "weak signal" chip when poses/s < ~20 or gate dips are frequent.

---

## Ruled out or minor

- **GameLoop/fixed steps** — correct for asynchronous events: events write state and are applied in the next substep; the accumulator capped at 0.1 s and 5 substeps (`GameLoop.ts:46-56`) was already audited and the verdict stands. Events arriving at a variable poses/s rate do not couple poorly with the 1/60 step.
- **HUD/React** — 5 Hz with string comparison (`TrackGame.ts:145-151`); `setTracking` is called per frame but bails out through `Object.is` — same verdict as the previous audit.
- **`stridePhase` follows measured cadence** (`TrackGame.ts:114`) — each leg oscillates at spm/120 Hz, in phase with real steps — an elegant detail of PR #6, with no cost.
- **`shownSpeed` easing τ≈167 ms** — adds ~300 ms to perceived speed changes; a smoothing choice, contributing to (but not causing) finding #4's latency.
- **Obstacle in the wrong lane still awards +100** (`TrackGame.ts:130`) — ~2/3 of obstacles are free points if the player only runs straight; balancing to revisit, not a bottleneck.
- **Crossing check at `z>0.2` with runner at `z=1.4`** (`TrackGame.ts:73,128`) — the "pass" registers ~55 ms before visual alignment at 22 u/s. Cosmetic.
- **Keyboard has no sound** — `onKey` mutates state directly, without `dispatchEvent` → a key jump does not play `audio.jump()` (`App.tsx:44-49`, `TrackGame.ts:92-101`). Minor inconsistency.
- **Obstacle spawn/despawn** — new geometries/materials per spawn, released by `disposeObjectTree` on despawn (`TrackGame.ts:78-84,134-138`) — correct.
- **Presentation timestamp vs capture timestamp** — already analyzed in the latency budget for finding #5: it biases absolute latency only, not intervals.
- **First warm frame** — first-inference spike (~142 ms CPU / ~2 s software GL, research §7.5) falls within the 4 s calibration window — absorbed.
- **Score from `advance`** — rounding bug from the previous report fixed by `trackScore.ts:6` (fractional accumulation) + `trackScore.test.ts`.

---

## Where things stand — an honest assessment

**Works (verified in code/tests):** live and warm CV pipeline (persistent worker, parallel initialization, immutable assets); per-feature gates with per-event confidence; geometric lane lean in world space with yaw/tilt tests; continuous cadence with a period-proportional stop — the "runner moves at your pace" mechanic is implemented and 79 tests pass on synthetic fixtures.

**Running bottleneck #1** is finding #1: pose rate sets the physical ceiling on measured cadence, and the worst real measured case (GPU delegate on software GL, ~5–10 fps, no fallback) puts the game in a regime where even "running" cannot be detected — all without a visible indicator. The prioritized fix is cheap (detect software GL + latency-based fallback) and was already prescribed in research §7.5.

**Bottleneck #2 is verification**: jump-while-running (finding #2) and lane-while-walking (finding #6) are the interactions that define the game, and neither has been measured outside synthetic data — the suite covers a 0.05 bob but not the 0.1–0.15 range where real running oscillation lies. PR #6 states this plainly: "Not yet verified with a real person walking or running in front of a webcam".

**Practical priority:** (1) latency/software-GL fallback; (2) log signals (`rise`, `lift`, poses/s) during a real-camera session; (3) decide how `degraded` should feel for cadence (#3); (4) then tune thresholds with data, not literature.

---

## Open questions / unverified

- **Fixed `dominantHand` vs. dual-wrist detection** — the real merge divergence: original `feat/camera-auto-calibration` stored **both** wrists (`readyWristLocal: Record<Hand, Point3>`) and instantiated one `SwingDetector` per arm ("whichever arm swings is the racket hand", `git show eedb6c0:src/kinematics/actionPipeline.ts`); the merge adopted PR #5's format (one `dominantHand`) and `AutoCalibrator` ended up calling `calibrator.finish('right')` (`autoCalibrator.ts:46`) — left-handed players get the wrong swing profile and automatic hand detection was lost. Pending decision: restore `Record<Hand>` + two detectors, detect the dominant hand during calibration, or keep a manual selector.
- **Real amplitude of the knee/hip signal while walking** for the Lite model at 640 px — determines findings #2 and #6; no published value; measure it.
- **`rise` during real running** — the three outcomes in finding #2 depend on unmeasured amplitude and average posture.
- **Lane signal/threshold during real walking** — the `legsVertical` wobble (finding #6) and `delta<0 → 'left'` signal (`postureSignals.ts:23`) have only been proven on a world-space fixture; the previous report caught a historical side inversion — check on camera: leaning right should move the runner right on screen.
- **Poses/s on representative real hardware** (integrated GPU, blocklists, mobile) — only the local SwiftShader case has been measured.
- **Real photon-to-action latency** — requires `captureTime`; ~60–150 ms is an estimate, not a measurement.
- **Whether `degraded` behavior belongs in the pipeline (change the `protocol.ts:89-90` contract) or in the game (ignore degraded sprint-zero)** — product decision (finding #3).
- **Cadence in place vs. treadmill** — anchors 100/130/137.5/200 come from treadmill walking (CADENCE-Adults, WRT); for stepping in place, the closest primary reference is "moderate cadence ≈100–120 spm with the foot lifting 15–20 cm" (TV-commercial-stepping studies) — `SPEED_BY_CADENCE` likely needs its own calibration for the actual gesture.
- **`presentedFrames`** — presentation drops under load are not counted anywhere.

---

## Sources

**Code (citations use `path:line` in this merged tree):** `src/App.tsx`, `src/cv/{poseClient,pose.worker,protocol,calibrator,autoCalibrator,oneEuroFilter,mediapipeAssets}.ts`, `src/kinematics/{actionPipeline,cadenceTracker,jumpDetector,postureSignals,trackingGate,schmittTrigger,bodyFrame,swingDetector,math}.ts`, `src/games/{core/GameLoop,track/{TrackGame,gait,trackScore},audio}.ts`, `src/ui/{GameCanvas,CameraPip,PoseOverlay}.{tsx,ts}`, `tests/{pace,trackScore,kinematics,poseClient}.test.ts`, `tests/fixtures/syntheticPose.ts`, `vercel.json`. Merge history: `git show 266e042` (PR #6), `git show eedb6c0` (pre-merge auto-calibration, dual-wrist format), `git show 17b6fed` (resolution). PR #5 and #6 descriptions on GitHub (`gh pr view`) — including the author's 15 fps "Known limit" and PR #5's note that `controls` has no consumer.

**Internal documents read:** `docs/analise-de-gargalos.md` (pipeline audit; items #1–#6 fixed in this merge, #7 cited as the ceiling), `docs/pesquisa-pipeline-cv.md` (§7.5 measured benchmark: CPU ~16–21 ms ≈ 48–62 poses/s, software GL ~96–243 ms ≈ 5–10 fps with no fallback; §2.2 `VideoFrame`; §6 metadata), the pose-kinematics corrections report (jump baseline drift; historical lane-side inversion), and the Nevergear Web Sports Arena modularization notes (`pose_pipeline` and `game_architecture`).

**Primary external sources:**
- https://ai.google.dev/mediapipe/solutions/vision/pose_landmarker — synchronous VIDEO mode, monotonic timestamps, livestream "latest frame" pattern (adopted here).
- https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite — model card: ~44 FPS CPU / ~49 FPS GPU on Pixel 3; SHA-256 `59929e1d…574a` matches `public/mediapipe/models/SHA256SUMS`.
- https://wicg.github.io/video-rvfc/ — rVFC semantics: callback in rendering steps before rAF, may be "fired one v-sync late", `captureTime` SHOULD for gUM, monotonic `presentedFrames`.
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback — metadata and min(video fps, refresh) rate.
- https://pmc.ncbi.nlm.nih.gov/articles/PMC6337834/ — CADENCE-Adults (Tudor-Locke et al. 2019): 76 adults on a **treadmill**; heuristic 100 spm = 3 METs, 130 spm = 6 METs.
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10526715/ — Chase et al. 2023: walk-to-run transition by cadence, heuristic range 135–140 spm, **treadmill** (basis for 0.55/0.5 thresholds in `gait.ts` and 137.5 anchor).
- https://pmc.ncbi.nlm.nih.gov/articles/PMC4303911/ — GUD WIP (Wendt/Whitton/Brooks, IEEE VR 2010): gait-cycle-based walking in place; stops ~500 ms after last step (0.8 Hz threshold); estimates frequency at each completed state (3×/step); Foot Off uses position **+** velocity (0.02 m, 0.5 m/s).
- https://journals.lww.com/acsm-msse/Fulltext/2012/02000/Energy_Cost_of_Stepping_in_Place_while_Watching.20.aspx and https://pmc.ncbi.nlm.nih.gov/articles/PMC3487755/ — Steeves/Thompson/Bassett: stepping in place as exercise; "moderate cadence" defined as 100–120 spm with foot lifting ~15–20 cm — the closest reference to the game's actual gesture.
- https://doi.org/10.1249/01.mss.0001061236.55291.a0 — vertical running CoM oscillation: 9.0–9.3 ± ~1.5 cm, range 6.5–13.1 cm (markerless mocap, treadmill).
- https://pubmed.ncbi.nlm.nih.gov/19356933/ — a single sacral point estimates vertical CoM displacement during running (systematic discrepancy 0–1.5 mm).
- https://hal.inria.fr/hal-00670496 — Casiez, Roussel, Vogel, "1€ Filter" (CHI 2012) — the filter implemented in `src/cv/oneEuroFilter.ts`.
- `node_modules/@mediapipe/tasks-vision/vision.d.ts` (v1.2.3) — `detectForVideo(ImageSource, timestamp)`, `forVisionTasks(basePath, useModule)` (`:522,819,1308`).
