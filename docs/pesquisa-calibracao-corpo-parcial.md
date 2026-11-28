# Calibration with Partial Body Visibility and Movement — Technical Requirements versus Design Choices

Date: November 25, 2026. Code state reviewed: `main` (`7159acb`, merge of PR #23). Research based on primary sources: the BlazePose paper and model card, official ML Kit/MediaPipe documentation, an official MediaPipe issue, MediaPipe source code, validation literature against Vicon, and literature on rest detection and baselines. Complements `docs/pesquisa-deteccao-pelo-torso.md`, `docs/pesquisa-exposicao-minima-calibracao.md`, `docs/autocalibracao-tolerancia-perda.md`, and `docs/pesquisa-robustez-gestos.md`.

**Question:** Does calibration really need the whole body? Does any movement need to restart the attempt? Is there a technical way to avoid blocking the game until calibration is perfect?

## Short verdict

1. **Full-body visibility is not a technical requirement.** For BlazePose, face + shoulders + hips falls within the training envelope; the MediaPipe team itself says the full-body model now handles out-of-frame lower bodies well and recommends simply ignoring landmarks 25–32 when they are not needed. Knees, ankles, and feet are not required for running in place or jumping in the current design.
2. **The `main` branch has already implemented much of this.** PR #22 (`feat/torso-detection`) made shoulders + hips the calibration core, and current tests prove that running calibration works without knees, ankles, or wrists. The README still says “full body,” however, and the real experience remains stricter than the technical requirement.
3. **“Any movement restarts calibration” is not a technical requirement.** It is a conservative choice in `AutoCalibrator`: a stillness anchor compares landmarks in image and world coordinates, and any displacement beyond the tolerance discards collected samples. This protects the medians from mixing different postures, but it goes further than necessary.
4. **The game does not need to remain blocked while waiting for the profile.** In the current pipeline, cadence and jumping are already self-referenced and do not read `CalibrationProfile`. The block happens because `ActionPipeline.update()` returns early when `calibration` is `undefined`. Lane control and tennis have real reference dependencies, but can be enabled progressively.
5. **Tennis does not inherently need both wrists.** The pipeline already keeps one detector per wrist and selects the arm that swings. The calibrated wrist reference is only used to return to rest after a swing; swing triggering itself is based on velocity. Requiring both wrists is a calibration simplification, not a detector law.
6. **The technical solution is incremental, feature-specific, non-blocking calibration**: continuously estimate scale/shoulders, neutral vertical, and wrist rest from rolling windows; enable each control when its own evidence converges; never discard all accumulated progress because of an irrelevant landmark or a brief movement.
7. **Real-webcam validation is still missing.** There is no adequate published figure for resting jitter from Pose Landmarker Lite on an ordinary webcam, nor an in-app measurement of error when the frame cuts off the legs. The literature supports the direction, but final thresholds must be measured.

---

## 1. Current repository state — what is already solved and what still causes friction

### 1.1 The minimum core is already the torso, not the whole body

`src/cv/calibrator.ts` explicitly declares “Upper-body calibration”: a valid frame needs only the four central points — shoulders `[11,12]` and hips `[23,24]` — in image and world coordinates. Legs only improve the neutral vertical when an extended posture is observed; wrists have independent coverage. The main gates are:

- valid-frame coverage: `COVERAGE_RATIO = 0.65`;
- minimum span: `MIN_SPAN_MS = 2000`;
- accumulated valid signal: `VALID_SIGNAL_MS = 1800`;
- maximum credited temporal gap: `MAX_SIGNAL_GAP_MS = 350`.

Tests in `tests/kinematics.test.ts` already cover:

- running calibration without ever seeing knees, ankles, or wrists;
- tennis calibration with visible wrists but no knees or ankles;
- cadence, strides, and jumping with legs and wrists out of frame;
- a short tracking loss counting toward coverage instead of immediately aborting;
- convergence in about 2 seconds with the ideal continuous fixture.

So the direct answer to “don’t we have research on this?” is **yes**. `docs/pesquisa-deteccao-pelo-torso.md` already concluded that calibration can be torso-only and that running/jumping can be detected from the torso. PR #22 implemented that direction.

### 1.2 Gameplay is still blocked before calibration

Despite this, `ActionPipeline.update()` does this before running any detector:

```ts
if (!calibration) {
  this.resetDetectors();
  return { controls: { sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' }, ... };
}
```

That means **even cadence and jumping, which do not use the profile, are silenced until full calibration exists**. The comment in `src/kinematics/cadenceTracker.ts` says cadence is “self-referencing”; `src/kinematics/jumpDetector.ts` says “no calibration involved.” These two channels are blocked only because the pipeline composition still treats the profile as a global prerequisite.

Lane control is different: `LaneLeanDetector` needs `leanUp0`/`torsoLeanRad0`. Tennis is different too: `SwingDetector` currently refuses to operate without `readyWristLocal`. These dependencies are specific; they do not justify blocking running and jumping.

### 1.3 Current stillness detection is binary, global, and sensitive to landmarks that should not matter

`src/cv/autoCalibrator.ts` uses:

- `SETTLE_MS = 1000` and `COLLECT_MS = 3000`;
- image tolerance `STILL_TOLERANCE = 0.04`;
- world tolerance `max(0.08 m, 0.2 × shoulder width)`;
- required core `[11,12,23,24]`;
- and, in tennis mode, `[15,16]` as well.

The problem is in `moved()`/`createAnchor()`:

- for running, monitored points are `[11,12,23,24,25,26,27,28]` — knees and ankles participate in the movement test even though they are optional for the profile;
- tennis also includes the wrists;
- if a point was not confident at the anchor but later becomes confident, that alone counts as movement (`!anchoredPoint && point => true`);
- when `moved()` fires during the normal flow, the calibrator resets and starts a new anchor; when it fires on a poor frame, the attempt returns to `framing`.

The code documents a defensive reason: if someone moves during a tracking loss and returns, the medians should not mix different postures. The intent is sound. The granularity is the problem: **the protection applies to any translation and to joints that are not required by the channel being calibrated**, and the cost is discarding all progress.

Important nuance: ankles and knees are not irrelevant to everything. `legsVertical()` uses extended legs to estimate gravitational vertical more accurately than the torso. There is even a test that re-anchors when the ankles appear and begin defining vertical. That does not justify requiring legs; it means the vertical reference source must be selected explicitly and remain stable. Restarting everything when a better source appears is a simple implementation, not the only solution.

### 1.4 Tennis requires both wrists because of profile simplification, not because the detector needs them

`ActionPipeline` creates one `SwingDetector` per hand. Swing onset uses lateral/normalized wrist velocity. `readyWristLocal` is read mainly in the `return` state, to re-arm when the wrist comes back near its calibrated position and its velocity drops. `docs/pesquisa-robustez-gestos.md` already notes that requiring the calibrated position can deadlock if the player rests their arm elsewhere, and suggests a fallback based on sustained low velocity.

In addition, `Calibrator` produces `readyWristLocal` only when **both** wrists have enough coverage in the same frame (`leftWrist && rightWrist`). Nothing in the swing pipeline requires this symmetry: one hand may be dominant, the other may be out of frame, and accessibility may require one-handed mode. This is a design gap.

### 1.5 The public app documentation has fallen behind

`README.md` still says “Camera framing the entire body for running and jumping” and describes calibration as taking about four seconds. `CameraPip` correctly says “head and torso down to the hips.” This contradiction is part of the poor experience: users are told to frame their whole body even though the system no longer needs it.

---

## 2. Primary evidence — partial-body visibility is supported, with clear limits

### 2.1 BlazePose was trained to operate when only hips and shoulders can be annotated

In its dataset section, the BlazePose paper says:

> “We restrict our dataset to those cases where either the whole person is visible, or where hips and shoulders keypoints can be confidently annotated. To ensure the model supports heavy occlusions that are not present in the dataset, we use substantial occlusion-simulating augmentation.”

Source: [BlazePose: On-device Real-time Body Pose tracking, arXiv 2006.10204, Section 2.4](https://arxiv.org/abs/2006.10204).

In its alignment and occlusion section, the paper says that the model simulates occlusions during training and introduces a per-point visibility classifier; this enables tracking in “upper body-only or when the majority of person body is out of scene.” Source: [arXiv 2006.10204, Section 2.6](https://arxiv.org/abs/2006.10204).

**Direct reading:** shoulders + hips are not an out-of-distribution hack; they are the explicit minimum annotation/training condition.

### 2.2 The MediaPipe team retired the upper-body model because the full-body model learned to handle this case

In the official issue “Where did upper-body pose landmark go?”, maintainer `chuoling` replied:

> “We previously included an upper-body-only model because the full-body model didn't handle well the cases where the lower body is not visible. However, we've improved the full-body model (across all model complexities: lite, full, heavy) such that it now handles those cases well and a special upper-body-only model is no longer needed. [...] if desired you could simply ignore the pose landmarks that correspond to the lower body (i.e., index 25~32).”

Source: [google-ai-edge/mediapipe issue #1995](https://github.com/google-ai-edge/mediapipe/issues/1995).

**Direct reading:** for torso-based running/jumping, consuming only `[11,12,23,24]` and ignoring `[25..32]` is exactly what the team recommends.

### 2.3 The hard requirement is the face/head, not the feet

ML Kit documentation says:

> “The user's face must be present in order to detect a pose. Pose detection works best when the subject's entire body is visible in the frame, but it also detects a partial body pose.”

Source: [ML Kit Pose Detection](https://developers.google.com/ml-kit/vision/pose-detection).

The paper explains why: a fast face detector is used as a proxy for a person detector and produces the initial alignment parameters. The model card lists “head is not visible” as out of scope and also limits very distant people (about 4 m). Sources: [arXiv 2006.10204 Section 2.2](https://arxiv.org/abs/2006.10204); [BlazePose GHUM 3D Model Card](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf).

**Onboarding implication:** the honest minimum instruction is “keep your head, shoulders, and hips visible,” not “show your whole body.” For tennis, add “keep at least your racket hand visible” as a functional requirement.

### 2.4 Out-of-frame points appear in the output, but are not visual evidence

The model card describes output `(x,y,z,visibility,presence)` and defines:

- `visibility`: probability that the keypoint is inside the frame and not occluded;
- `presence`: probability that the keypoint is inside the frame, without indicating whether it is occluded.

The card also says the model was qualitatively evaluated on people with missing limbs/prostheses and “degrades gracefully by predicting average point location.” This is useful for robustness, but **does not** mean an invisible or absent limb provides a reliable measurement. It is an average-pose prediction, not an observation.

Source: [BlazePose GHUM 3D Model Card](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf).

Pose Landmarker documentation confirms that output includes normalized landmarks and world landmarks in meters centered at the midpoint of the hips, with `visibility`/`presence`. Source: [Pose Landmarker — Google AI Edge](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker).

**Consequence:** consuming predicted legs while they are outside the image is risky; ignoring those legs is safe. The correct gate is per landmark, not “whole body or nothing.”

### 2.5 Shoulders and hips are the most structural landmarks in the pipeline

In an independent multi-camera validation study against Vicon, positional errors increased markedly below visibility ≈0.5, and variance increased below ≈0.8; a threshold of 0.7 retained 90.6% of observations in that setup. The same study notes that **shoulder and hip landmarks consistently had high visibility because MediaPipe uses them to determine the ROI before estimating the remaining landmarks**.

Source: [Chen et al., multi-view MediaPipe/Vicon validation, PMC13766164](https://pmc.ncbi.nlm.nih.gov/articles/PMC13766164/).

Limitations: this was not a monocular 480p webcam or Pose Landmarker Lite in a game; it used multi-camera reconstruction and controlled exercises. Still, it is independent evidence in the same direction: the shoulder/hip core is the most reliable substrate, while elbows, wrists, and legs are more vulnerable to occlusion.

### 2.6 The model is sensitive to the environment, but that does not change the full-body requirement

The model card says poor lighting, noise, motion, and face overlap degrade quality and increase jitter. It also says the model is sensitive to face position, scale, and orientation. This explains real calibration failures in home environments, but it does not imply a need for full-body visibility. It means quality feedback (visible face, lighting, distance, missing landmarks) is part of the product.

Source: [BlazePose GHUM 3D Model Card](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf).

---

## 3. Primary evidence — “stay still” need not mean “freeze or restart”

### 3.1 MediaPipe’s contract is best-effort output and confidence per frame; consumers should aggregate

The BlazePose pipeline is detector + tracker: the tracker emits landmarks, presence, and ROI; when presence fails, the detector runs again on the next frame. Source: [arXiv 2006.10204 Section 2.1](https://arxiv.org/abs/2006.10204).

The official pose-classification guide recommends EMA for frame-to-frame noise and double-threshold hysteresis to avoid toggling around a threshold. The official example uses an EMA window and resets only when the stream receives no input for more than 100 ms — not when one individual frame is poor. Sources: [pinned pose_classification.md](https://github.com/google-ai-edge/mediapipe/blob/3eb8983cde1517fdff4abbfb33586316af6d45be/docs/solutions/pose_classification.md); [EMASmoothing.java](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java).

`docs/autocalibracao-tolerancia-perda.md` already reached the same conclusion for tracking loss: aborting the entire window at the first `lost` has no support in primary sources; coverage + median + hysteresis is the standard approach.

### 3.2 The median is already robust to a minority of contaminated frames

In robust statistics, the sample median has a 50% breakdown point: half the observations must be contaminated to move the estimate arbitrarily far. Source: [Rousseeuw, Tutorial on Robust Statistics](https://wis.kuleuven.be/statdatascience/robust/papers/publications-1991/rousseeuw-tutorialrobuststatistics-jchemtrx-1991.pdf).

This does not mean movement is irrelevant. If most of the window contains a squat, lean, or incorrectly positioned arms, the median will estimate the wrong posture. It means that **a brief movement, a few occluded frames, or jitter do not require discarding the entire window**. The right policy is to reject bad frames/segments and require enough coverage from good frames.

### 3.3 Classical rest detection uses dispersion + duration, not a permanent distance from one anchor

The I-DT algorithm classifies a fixation when samples remain within a spatial dispersion threshold for a minimum duration; typical durations in eye tracking are 100–200 ms. The transferable idea is not the number, but the form: stillness is a property of a **window**, not a permanent distance from the first frame. Sources: [review of eye-event algorithms, PMC9699548](https://pmc.ncbi.nlm.nih.gov/articles/PMC9699548/); [Salvucci & Goldberg 2000](https://www.cs.drexel.edu/~dds26/publications/Salvucci-ETRA00.pdf).

The current absolute anchor is simple, but creates the effect “any movement restarts calibration.” A rolling window can accept natural micro-adjustments and discard only intervals whose dispersion, velocity, or posture makes them unsuitable.

### 3.4 Jump biomechanics also uses a quiet-standing baseline with tolerance, not absolute immobility

In a countermovement-jump force-plate protocol, body weight is the mean over 1 second of quiet standing, and movement onset is detected when the signal leaves a ±5 SD band. Source: [Owen et al. 2014, PubMed 24276298](https://pubmed.ncbi.nlm.nih.gov/24276298/).

The analogy is limited — force is not webcam pose — but the form is relevant: “quiet” is operationalized through a noise distribution and deviation from baseline, not zero physical movement. The goal is to estimate a stable neutral state, not forbid physiological sway.

### 3.5 Motion blur does not prevent micro-movement; large movement is a different regime

`docs/pesquisa-exposicao-minima-calibracao.md` already concludes that sway in mm/s does not produce relevant blur even at 1/30 s; the main low-light problems are noise, exposure hunting, reduced frame rate, and flicker. The same document notes that limbs moving at 1–3 m/s during gameplay blur by tens of millimeters.

**Implication:** allowing sway and natural posture during calibration does not enter the motion-blur regime that breaks the measurement. Allowing large gestures or running during collection is different — not because a reset is mandatory, but because those frames do not represent neutral posture and may have worse blur/confidence.

---

## 4. Technical analysis — break down what actually depends on calibration

The current profile has four outputs in `world` coordinates:

| Output | Consumer | Depends on neutral posture? | Depends on body being still? | Notes |
|---|---|---:|---:|---|
| `shoulderWidth` | swing velocity/position normalization | Slightly | No, to first order | It is torso anthropometry; any torso-confident frame contributes. Translation does not matter. |
| `leanUp0` | lane vertical reference | Yes | Needs neutral/upright frames, not absolute immobility | Can come from extended legs or torso; frames with leaning/running should be excluded. |
| `torsoLeanRad0` | neutral lateral lane lean | Yes | Needs neutral/upright frames | Natural sway around neutral can be median-filtered; sustained leaning is not neutral. |
| `readyWristLocal` | swing re-arming | Yes, per hand | Only the relevant hand needs to be at rest | Not needed for onset; a low-velocity fallback is possible. |

The consequence matters: **“stand still” is a crude proxy for “observe enough neutral posture.”** The proxy is simple, but combines independent signals:

- body translation does not change `shoulderWidth` or body-local coordinates;
- moving one foot does not change the neutral wrist position;
- moving a wrist does not change the torso’s neutral vertical;
- leg movement matters only if legs are being used for `leanUp0`;
- a landmark appearing/disappearing is a visibility event, not necessarily body movement.

Therefore, a technically better calibration state machine does not ask “has the entire body been motionless since the anchor?” It asks, per feature:

1. Is there enough temporal coverage of confident frames?
2. Do the frames belong to the instructed neutral posture?
3. Has the estimate’s dispersion/residual converged?
4. Is there evidence of a person/camera change that invalidates the profile?

---

## 5. Why the experience still seems to “require everything” despite the torso PR

Probable causes, in descending order of confidence:

1. **Global block before a profile exists.** Even calibration-free channels emit no events while `profileRef.current` is `undefined`. To users, “not fully calibrated” feels like “the game will not start” because the CV pipeline really does not produce controls.
2. **Movement reset is global and discards accumulated progress.** A movement discards `Calibrator` samples and resets progress to zero. There is no feedback distinguishing “moved too much,” “hip missing,” “face missing,” “hand missing,” or “tracking fluctuated.”
3. **Optional legs participate in the movement detector.** During running calibration, knees/ankles `[25..28]` can re-anchor the attempt despite not being required; worse, appearing after the anchor counts as movement. This is especially bad near the lower frame edge, where these points enter and leave.
4. **Tennis requires both wrists and recalibrates everything when switching modes.** A running profile discards incidental wrist references; when entering tennis, `App.tsx` calls `recalibrate()` if `readyWristLocal` is missing, restarting the entire process.
5. **The README is outdated.** Users may be trying to frame the whole body because documentation tells them to. The PiP is correct, but smaller and appears later.
6. **The tested version may not be the current `main`.** In this session, local `main` was 35 commits behind before updating; if the observed experience was on a deploy predating PR #22, it really was full-body. This does not explain everything — issues 1–4 remain on `main` — but it is important to distinguish an old version from the current design.
7. **Real camera conditions.** Low light, exposure hunting, a small/tilted face, or hips at the frame edge can keep confidence below the gate. The model card explicitly describes degradation from lighting, noise, motion, and overlap.

---

## 6. Recommended implementation direction

### 6.1 Small changes with high impact

1. **Unblock running/jumping without a profile.** `ActionPipeline` should process torso/cadence/jump even when `calibration === undefined`. Lane control should run only when `leanUp0` exists; swings should run only when a reference or fallback is available. This removes the impression of a calibration ceremony without reducing safety for channels that genuinely need references.
2. **Separate movement detection by consumer.** Running should not monitor `[25..28]` for reset unless the leg-based vertical source is explicitly active. An optional landmark appearing/disappearing should not count as movement; it should affect coverage/quality for that feature.
3. **Replace total reset with selective invalidation.** Moving frames should not enter the neutral median; coverage/time should continue. If posture changes persist or there is a long blackout, re-anchor a rolling window — do not discard the state already converged for other features.
4. **Calibrate wrists independently.** `readyWristLocal` should support independent left and right references. The pipeline already selects either arm; one missing hand should not block the other. This also improves accessibility.
5. **Add a low-velocity re-arm fallback.** Since `readyWristLocal` is only used to return to rest, the detector can re-arm after sustained low velocity even away from the calibrated position. This reduces the need to calibrate a wrist and avoids deadlock when the player rests their arm elsewhere.
6. **Explain the actual block in the UI.** Instead of a progress bar that resets without explanation, show messages such as “hip missing,” “head outside frame,” “right hand not visible,” “tracking fluctuated — hold this position,” or “posture changed; using the new stable segment.”
7. **Update the README.** Replace the full-body instruction with head + shoulders + hips; for tennis, add the racket hand.

### 6.2 Redesign: continuous, progressive calibration

Instead of a single 2–4 second ritual, keep a continuous estimator with a short rolling window and per-feature state:

- **body scale (`shoulderWidth`):** continuous median/MAD over torso-confident frames; converges quickly; updates slowly and with bounds to avoid absorbing a person change without invalidation;
- **neutral vertical (`leanUp0`):** collect frames with an upright torso, low angular velocity, and low dispersion; use legs only when verified extended and consistent, without switching sources mid-attempt;
- **neutral lean (`torsoLeanRad0`):** median of frames classified as neutral; require convergence by dispersion, not absolute immobility;
- **wrist rest:** cluster low-velocity frames independently for each hand; if it does not converge, allow swing detection with velocity-based re-arming and adaptive position;
- **progressive publication:** each control gets its own state — `ready`, `degraded`, or `uncalibrated` — instead of one all-or-nothing global profile.

Stillness detection should follow the I-DT pattern: a minimum window with low dispersion/velocity. The median/MAD makes it robust to a minority of contaminated frames; the rolling window forgets an old posture without erasing all learned state.

### 6.3 Policy for switching the vertical reference source

Ankle visibility deserves an explicit decision. Options:

1. **Fixed source per attempt:** if an attempt starts torso-only, it remains torso-only; appearing legs do not re-anchor or switch the reference. Simple and avoids resets.
2. **Two parallel estimates:** maintain torso-based and leg-based `leanUp0` estimates; publish the leg-based estimate only if it converges and agrees within a budget, otherwise keep the torso estimate.
3. **Incremental recalibration later:** after gameplay starts, if legs become visible and stable, improve the reference in the background with a bounded transition.

Option 1 is simplest for the next PR; option 2 is the better medium-term architecture.

---

## 7. What must be validated before relaxing thresholds

The sources support removing the full-body requirement and global reset, but do not provide final thresholds for this webcam/model. Measure on real recordings:

1. resting jitter of `[11,12,23,24]` in image/world coordinates at low, medium, and high lux;
2. visibility/presence rate for hips and shoulders with head-to-hip framing;
3. time to convergence and resets per attempt in current/proposed versions;
4. `leanUp0`/`torsoLeanRad0` error comparing torso-only with verified-leg estimates;
5. per-hand `readyWristLocal` error and re-arm rate with the velocity fallback;
6. effects of controlled natural movement: sway, foot adjustment, arm movement, a lateral step, face scratching;
7. behavior with only one visible hand and with intermittent framing that cuts off knees/ankles;
8. false-input rate when adaptive baseline is used from the first frame.

Synthetic tests should cover the logic (do not reset on optional legs, enable running without a profile, calibrate one hand), but they do not replace these measurements.

---

## 8. Gaps in the sources

- I found no quantitative validation of Pose Landmarker Lite on an ordinary webcam for **partial head-to-hip framing** compared with full-body framing.
- I found no reliable per-landmark resting-jitter figure for Pose Landmarker Lite; available studies measure accuracy against motion capture, not frame-to-frame noise in this configuration.
- Study PMC13766164 uses multi-camera/triangulation; using 0.7 as this app’s threshold is inspiration, not a direct transfer.
- The model card’s statement about missing limbs/prostheses is qualitative; it provides no error metric or guaranteed score semantics for that case.
- I found no primary study specifying exactly how to continuously calibrate neutral pose for a monocular exergame; the proposal here is an engineering inference from robust statistics, quiet-standing detection, and the pose tracker contract.

---

## 9. Final answer

**Technically, all of this is not required.** Full-body visibility is unnecessary; head + shoulders + hips is the supported minimum for the core, and legs/feet should be optional. Tennis can work with one hand and, to a large extent, without a rigid rest reference if re-arming is adaptive.

**Calibration also does not need to restart after every movement.** Frames that do not represent neutral posture must be kept from contaminating postural references. This can be done with frame selection, rolling windows, coverage, dispersion, median/MAD, and independent per-feature states — not a global reset.

**The blocking calibration ceremony can be removed for running/jumping today**, because those detectors are already self-referenced. For lane control and tennis, the right approach is progressive activation with feedback and fallbacks, keeping a short explicit collection only as a fast path to convergence — not as an absolute gate.

---

## Main sources

- [BlazePose: On-device Real-time Body Pose tracking — arXiv 2006.10204](https://arxiv.org/abs/2006.10204)
- [BlazePose GHUM 3D Model Card](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf)
- [MediaPipe issue #1995 — upper-body-only cases in the full-body model](https://github.com/google-ai-edge/mediapipe/issues/1995)
- [ML Kit Pose Detection](https://developers.google.com/ml-kit/vision/pose-detection)
- [Pose Landmarker — Google AI Edge](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
- [Chen et al., MediaPipe/Vicon validation — PMC13766164](https://pmc.ncbi.nlm.nih.gov/articles/PMC13766164/)
- [Pinned pose classification guide — EMA + hysteresis](https://github.com/google-ai-edge/mediapipe/blob/3eb8983cde1517fdff4abbfb33586316af6d45be/docs/solutions/pose_classification.md)
- [EMASmoothing.java — official example implementation](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java)
- [I-DT/I-VT review — PMC9699548](https://pmc.ncbi.nlm.nih.gov/articles/PMC9699548/)
- [Salvucci & Goldberg 2000 — Identifying Fixations and Saccades](https://www.cs.drexel.edu/~dds26/publications/Salvucci-ETRA00.pdf)
- [Rousseeuw — Tutorial on Robust Statistics](https://wis.kuleuven.be/statdatascience/robust/papers/publications-1991/rousseeuw-tutorialrobuststatistics-jchemtrx-1991.pdf)
- [Owen et al. 2014 — quiet-standing baseline in CMJ](https://pubmed.ncbi.nlm.nih.gov/24276298/)

## Related internal sources

- `docs/pesquisa-deteccao-pelo-torso.md` — evidence that torso-only calibration is viable for running/jumping.
- `docs/pesquisa-exposicao-minima-calibracao.md` — lighting/exposure limits and the unvalidated nature of the 1.8 s floor.
- `docs/autocalibracao-tolerancia-perda.md` — why transient loss should count toward coverage, not trigger an immediate reset.
- `docs/pesquisa-robustez-gestos.md` — jump/swing re-arming under jitter and velocity-based rest fallback.
- `src/cv/calibrator.ts`, `src/cv/autoCalibrator.ts`, `src/kinematics/actionPipeline.ts`, `src/kinematics/swingDetector.ts`, `tests/kinematics.test.ts` — code state reviewed for this analysis.
