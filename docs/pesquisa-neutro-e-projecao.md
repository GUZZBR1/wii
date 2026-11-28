# Hysteresis-Aware Neutral Center and Projective Sensitivity — Online Calibration and Lateral Normalization

Research date: November 2026.
Scope: lane control through the lateral displacement of the shoulder center in image coordinates, with an adaptive neutral center. This complements `docs/pesquisa-inclinacao-tronco.md` and `docs/auditoria-mediapipe.md`; it does not repeat the pipeline audit or the full torso-lean analysis.

**Questions.**

- **A.** When the player is off-center but still inside the hysteresis band (`0.05 ≤ |u| < 0.12`), is that displacement a resting posture or a control input? Is it safe to use the lane-zone state to admit calibration evidence?
- **B.** Which normalization denominator is more robust: projected shoulder width along x, the Euclidean length of the shoulder line, torso height/length, or a hybrid? Should the lane-entry threshold depend on projected body orientation?

## 0. Relation to existing notes and precision corrections

Earlier notes already establish the essentials about `worldLandmarks`: they are centered at the midpoint of the hips, estimated in meters from GHUM fits, and do not form a fixed world frame or a gravity-aligned frame; depth is their weakest component. This research confirms those conclusions in the primary sources cited below.

Three important clarifications:

1. **The z-sign convention for `worldLandmarks` is not documented consistently across official sources.** The Pose Landmarker documentation says only that world landmarks are in meters with an origin at the hips; for normalized landmarks, smaller z means closer to the camera. A MediaPipe maintainer stated in issue #4205 that the same z relationship applies to world coordinates, with negative values between the hips and the camera. The official TensorFlow blog post about BlazePose GHUM, however, describes `keypoints3D` with positive z as points approach the camera. This may reflect wrapper or legacy differences, or simply inconsistent documentation. **Do not depend on the z sign without checking it at runtime in the exact API used by the app.** Sources: [Pose Landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker), [issue #4205](https://github.com/google/mediapipe/issues/4205), [TensorFlow Blog — BlazePose GHUM](https://blog.tensorflow.org/2021/08/3d-pose-detection-with-mediapipe-blazepose-ghum-tfjs.html).

2. **A purely planar rotation of the shoulder line does not “inflate” its true Euclidean length.** If a rigid horizontal line of length `sW` rotates by φ within the image plane, its components become `sW cos φ` along x and `sW sin φ` along y; its Euclidean length remains `sW`. The practical problem with the current code’s `Math.hypot(dx, dy)` is different: landmark `x` and `y` values are normalized separately by the image width and height, so `hypot` mixes different units and overweights the vertical component in landscape video frames. The official documentation explicitly says that x is normalized by width and y by height. Source: [Pose Landmarker guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js). The mathematics above is our own derivation, not a claim from the literature.

3. **`worldLandmarks` do not measure the body’s lateral displacement in the environment.** Because the origin is at the hip center in every frame, a full step to the side moves the hips and the origin together; the translation disappears. Issue #5444 confirms that the origin changes frame by frame with the hips. Therefore, world landmarks are not a direct substitute for image coordinates when controlling lanes by body position. Source: [issue #5444](https://github.com/google-ai-edge/mediapipe/issues/5444).

---

# Part A — Resting posture versus intentional input during online calibration

## A1. What analogous control systems do

### A1.1 IMUs: estimate bias only when there is independent evidence of rest

The closest analogy is gyroscope and accelerometer bias estimation in inertial navigation. These systems apply an artificial zero-velocity or zero-angular-rate measurement only after an independent detector decides that the sensor is stationary.

- The paper **“Inertial Navigation Aiding by Stationary Updates”** summarizes the principle: when a vehicle is known to be stationary, artificial zero-velocity and/or zero-angular-rate measurements correct velocity, attitude, and IMU biases; implementation requires reliable automatic tests to detect stationary periods. Source: [IEEE T-ITS, DOI 10.1109/TITS.2011.2168818](https://doi.org/10.1109/tits.2011.2168818).

- The **VQF** filter implements this separation directly. At rest, gyroscope bias is estimated from filtered readings; during movement, the update is less reliable. The paper describes one Kalman filter that performs different updates depending on the rest/motion state and assigns “much larger trust” to updates at rest. Source: [Laidig & Seel, VQF, arXiv:2203.17024](https://arxiv.org/pdf/2203.17024), published as [Information Fusion 91, 187–204, DOI 10.1016/j.inffus.2022.10.014](https://doi.org/10.1016/j.inffus.2022.10.014).

- The detail most relevant to our feedback loop is that VQF’s rest detector **does not use the signal after correction by the estimated bias**. The algorithm filters raw gyroscope and accelerometer measurements, computes the deviation between the instantaneous measurement and the low-pass reference, and declares rest only if that deviation remains below the thresholds for about 1.5 seconds. The implementation also rejects rest when the filtered reference itself exceeds the largest plausible bias (`biasClip`). Source: [VQF paper, Appendix C](https://arxiv.org/pdf/2203.17024) and the [reference Python implementation](https://vqf.readthedocs.io/en/stable/_modules/vqf/pyvqf.html).

- The review **“Fifteen Years of Progress at Zero Velocity”** warns that applying ZUPT when the zero-velocity assumption is false introduces systematic errors: errors cease to be white or zero-mean, and steps can become shorter or vertically distorted. The detection threshold is a trade-off between sensor error and model error. Source: [Nilsson et al., arXiv:2008.09208](https://arxiv.org/html/2008.09208v1), published as [IEEE Sensors Journal, DOI 10.1109/JSEN.2020.3018880](https://doi.org/10.1109/jsen.2020.3018880).

**Lesson for the game.** The “center zone” should not be treated as sufficient proof of rest or neutrality, just as a “small gyroscope value” is not enough to prove that an IMU is stationary. We need a rest detector that uses quantities independent of the calibrated center — for example, shoulder-center velocity or variance, which do not depend on `x0` — and we must accept that false-positive rest detections introduce systematic bias into the neutral estimate.

### A1.2 Joysticks: adaptive centers use qualified resting points, not every sample near the center

Microsoft patent **US10463954B2 — “Mechanical center calibration of control sticks in user input devices”** describes mechanical-center calibration from a sequence of “qualified resting points.” A point qualifies only when the control:

- returns to a central qualification zone after leaving it;
- stops changing within a certain time after entering the zone;
- remains below a variation threshold for a minimum duration;
- and, in one described implementation, produces at most one resting point per entry into the zone, requiring an exit and re-entry to qualify another.

The estimate uses a weighted moving average of these points. Primary source: [US10463954B2](https://patents.google.com/patent/US10463954B2/en).

**Lesson for the game.** The natural unit of evidence is not “every frame inside the band,” but a **qualified resting episode**: the body enters the neutral zone, stabilizes, remains there long enough, and only then contributes — ideally through one median for the episode rather than hundreds of correlated frames. Requiring the player to leave and re-enter prevents one long hold from dominating the reference.

### A1.3 Implicit calibration in HCI: update only from samples validated by behavioral evidence

Eye-tracking research is useful because it also addresses calibration drift during use.

- **PACE — Personalized, Auto-Calibrating Eye Tracking** collects interaction data without explicit calibration, but does not accept every sample: it uses behavior-informed and data-driven validation to identify good training samples; rejected samples are retained and reconsidered after model updates. Source: [Huang et al., CHI 2016, DOI 10.1145/2858036.2858404](https://dl.acm.org/doi/pdf/10.1145/2858036.2858404).

**Lesson for the game.** The question is not only “is the sample near the current center?” but “is there independent behavioral evidence that this is a neutral state?” In our case, the best available substitutes are rest/dwell, recurring episodes, and the absence of a recent lane transition — not the value of `u` alone.

### A1.4 Robust adaptive control: dead zones, slow adaptation, and bounds are standard protections against drift

In adaptive control, continuously updating parameters from small errors or errors contaminated by disturbances causes “parameter drift.” Ioannou and Sun devote Chapter 8 of *Robust Adaptive Control* to adaptation instabilities and robust modifications: leakage, parameter projection, dynamic normalization, and dead zones. The dead-zone principle is to adapt only when the error is large relative to model error or disturbance; otherwise, adaptation is disabled or attenuated. Primary source: [Ioannou & Sun, *Robust Adaptive Control*, Chapter 8](https://flyingv.ucsd.edu/krstic/teaching/282/ioannousun.pdf).

**Lesson for the game.** The neutral center is an adaptive parameter. The right design is not an integrator that always corrects the observed error; it is an estimator with conditional admission, slow updates, robust aggregation, rate limits, freezing while the control channel is saturated or in a lane, and a recovery mechanism for when the observability assumption no longer holds.

## A2. What pose-controlled games and exergames do

### A2.1 Official pose-classification guidance: hysteresis, EMA, and torso normalization

Google’s official pose-classification guide for ML Kit recommends EMA to reduce frame-to-frame noise and double-threshold hysteresis: the exit threshold is lower than the entry threshold, creating a band in which the state does not change. The same guide says that, before pose features are extracted, poses were normalized to have **the same torso size and upright torso orientation**. Source: [Pose classification options — ML Kit](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses).

### A2.2 MediaPipe browser projects for body control: convergent practice, weak validation

These artifacts are primary engineering sources, not controlled scientific evidence:

- **Expressway** uses MediaPipe Face/Pose in the browser, calibrates neutral and extremes, defines thresholds as a fraction of the range with a noise floor, applies One Euro filtering, a dead zone, and a Schmitt trigger, and reports that its neutral baseline “keeps drifting slowly while you play.” Source: [Expressway — how it works](https://automationoptimization.github.io/expressway/).
- **ROY SPEED — Body-Tracking AR Running Game** uses initial calibration adjusted for player height/distance, exponential smoothing, hysteresis, and cooldowns; its README also mentions slow baseline adaptation while the player is standing still. Source: [GitHub — anupomroy111/Body-Tracking-AR-Running-Game](https://github.com/anupomroy111/Body-Tracking-AR-Running-Game).
- **SurfCam** divides vertical measurements by torso length to reduce distance dependence and uses three lateral position bands with hysteresis. Source: [GitHub — Blueturboguy07/surfcam](https://github.com/Blueturboguy07/surfcam).

The practical consensus is explicit or slow calibration, hysteresis, body normalization, and protection against drift. None of these projects provides a formal stability analysis of the zone → calibration → zone loop.

## A3. Feedback-loop analysis — our own derivation

Let `p` be the true postural position of the shoulder center, `x0` the estimated neutral center, and `e = x0 - p` the calibration error. Ignoring noise and scale, an admitted update of the form

```
x0 ← x0 + α(x - x0),   0 < α < 1
```

produces `e ← (1 - α)e`. In other words, **while correct evidence continues to be admitted, the loop is contractive, not explosive**. The problem is not classical exponential instability; it is loss of observability caused by gating.

The zone depends on the same `e`: if the error is large enough to make a truly centered posture appear to be in a lane (`|u| ≥ 0.12`), the zone leaves the center, samples stop being admitted, `x0` is not corrected, and the zone remains lateral — a calibration deadlock even though the player is physically standing at center. In practice, errors smaller than the entry threshold are self-correcting because centered evidence remains admissible; larger errors depend on the time-based escape hatch.

## A4. Design recommendation for Problem A

**The zone is a veto/context signal, not proof.** When the zone is centered, a displacement inside the band is not commanding a lane and could be posture; ideally, it would enter calibration only after passing an independent rest detector, episode aggregation, and slow adaptation. In a lateral zone, no sample from the band is evidence of neutral. The main risk is not exponential oscillation, but deadlock from loss of observability.

> **Status (implemented in this PR):** the zone veto is applied using the zone recorded per sample at collection time — admitting samples based on the current zone would retroactively reopen samples from a held lane that are still in the window. Independent rest qualification and episode aggregation described below remain future work.

Future refinement documented for later work (not implemented in the position-control PR): qualified resting episodes — a continuously centered zone, shoulder-center velocity (independent of `x0` because the temporal derivative cancels the offset) below a threshold for 0.7–1.5 seconds, one median per episode, recurrence before moving the center, and mandatory re-entry as in joystick patent US10463954B2. These values are engineering hypotheses to measure in real sessions, not validated constants.

**Minimum tests recommended by the research** — partially covered already in the PR: stable offset posture at ±0.07 converges without entering a lane ✔; long holds at ±0.13/±0.20 are not tracked ✔; periodic sway within the band does not adapt (symmetric — the mode is the consensus); an artificially incorrect `x0` self-corrects below the entry threshold.

---

# Part B — MediaPipe semantics and projective geometry for normalization

## B1. What `landmarks` and `worldLandmarks` actually mean

The official Pose Landmarker documentation defines `landmarks.x/y` as normalized by image width and height **respectively** — different denominators. `worldLandmarks` are 3D coordinates in meters, with an origin at the midpoint of the hips, estimated by fitting the GHUM statistical model to 2D evidence. Sources: [Pose Landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker), [BlazePose GHUM 3D model card](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf), [BlazePose GHUM Holistic, arXiv:2206.11678](https://arxiv.org/abs/2206.11678).

Immediate consequence: any Euclidean length computed directly as `hypot(dx_norm, dy_norm)` **is not a consistent length in the image plane**, because x and y were scaled by different denominators. In a 16:9 frame, the vertical component is overweighted by approximately (W/H)² ≈ 3.16 in the squared distance — a tilted shoulder line measures wider than the same horizontal line, and the measurement changes with tilt precisely during the deviation.

**Consequence for lane control.** Do not use `worldLandmarks.x` of the shoulder center as the player’s lateral position signal: the origin at the hips removes translation of the whole body — exactly the quantity lane control needs to measure.

## B2. Projective geometry — our own derivation under weak perspective

Let `s = f/Z` be the image/world scale, `W` the physical shoulder width, and `θ` the yaw around the vertical axis. For pure yaw and horizontal shoulders, projected width is `w ≈ sW cos θ`; the torso’s vertical height does not change.

**Step parallel to the camera** over physical distance `D`: `Δx ≈ sD`, so the normalized ratio is `u ≈ (D/W) sec θ` — sensitivity increases by `1/cos θ` (×1.15 at 30°, ×1.41 at 45°). **Step sideways relative to the body:** numerator and denominator contract together, so the ratio is invariant. Real players facing the screen move mostly along the camera’s x-axis, so the inflation case is the relevant one — but it becomes large only at degenerate yaw (>30°), where pose quality already degrades for other reasons.

**Planar rotation (shoulder tilt during a lean):** in pixels, `hypot` is rotation-invariant; x-only shrinks by `cos φ` and would create positive feedback — the denominator falls while the deviation numerator rises. In normalized coordinates, however, naive `hypot` mixes units and is no longer invariant. The correct form in units of image-width fractions is:

```
w = hypot(x11 - x12, (y11 - y12) * imageHeight / imageWidth)
```

## B3. Verdict for Problem B

> **Status (implemented in this PR):** the recommended aspect-ratio correction below has already been applied — `LanePositionTracker` and `AdaptiveCalibrator` measure shoulder width using `dy × frameHeight/frameWidth`, and frame dimensions travel in `PoseSnapshot` from the worker bitmap. Pose recordings gained schema v2 with per-frame dimensions; v1 files migrate using the input geometry recorded in the source. What remains future work is a hybrid equivalent frontal scale for extreme yaw, subject to the benchmark described below.

No single denominator is robust in every condition. The current `hypot` must first be corrected for aspect ratio — a direct geometric correction that requires no tuning. Among the simple options, aspect-corrected Euclidean shoulder width is better than x-only for front-facing players. At extreme yaw, the torso is geometrically more invariant, but the literature favors Euclidean length or torso transformation rather than simple vertical height — a **slowly filtered hybrid equivalent frontal scale** is the documented path for future work, with a dedicated benchmark (yaw 0/15/30/45°, steps along both axes, leaning, running with sway, 4:3 and 16:9 cameras) before changing the denominator. The lane threshold remains fixed if scale is corrected; adapting the threshold by yaw without decomposing step and lean mixes two incompatible control semantics.

**Pose-normalization references in the literature:** ML Kit normalizes poses to the same torso size and upright orientation before extracting features — [Pose classification options](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses). Pose Trainer normalizes by torso length — [arXiv:2006.11718](https://arxiv.org/html/2006.11718v1). OpenPose gesture recognition warns that normalization by shoulder-to-shoulder distance fails away from a frontal view — [link](https://link.springer.com/chapter/10.1007/978-3-030-35699-6_22). Using world landmarks to estimate yaw/frontal orientation is recommended with caution (the z component is weak); maintainers report that world landmarks are not guaranteed to be reprojectable — [issue #1895](https://github.com/google-ai-edge/mediapipe/issues/1895).
