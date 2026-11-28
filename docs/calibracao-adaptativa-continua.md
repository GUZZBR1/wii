# Continuous adaptive calibration — implicit calibration during play

Date: November 25, 2026. Complements `docs/pesquisa-calibracao-corpo-parcial.md`.

## Question

Does calibration need to be a visible ceremony — “stand still, show your whole body, wait” — or can the system estimate and improve its references while someone simply plays?

## Verdict

It can be continuous and invisible. Motion-capture literature calls this **implicit calibration**, **online calibration**, or **self-calibration during dynamic activity**. Related examples include:

- JointTracker uses a recursive Bayesian estimator to calibrate human kinematic chains during movement, without an initial static pose.
- Recent IMU work describes “implicit calibration”: immediate use, with online estimation from constraints observed over a short, varied window.
- Classic tracking techniques use median/MAD, temporal consensus, recursive estimators, and uncertainty-based sample selection.

The app’s current implementation follows this family, but remains deliberately simple: **it is neither a full Kalman filter nor a formal Bayesian posterior**. It is a robust online estimator with light priors and slow updates.

## Implemented algorithm

### 1. Evidence from each frame, not a calibration mode

`src/cv/adaptiveCalibrator.ts` consumes the same frames used for gameplay. A frame becomes central evidence only when:

- shoulders `[11,12]` and hips `[23,24]` exist in image and world coordinates;
- minimum confidence is at least `0.55`;
- the geometry is not degenerate;
- long intervals without a callback do not count as observed time.

Legs, feet, and wrists are not required for this central evidence.

### 2. Shoulder width — rolling robust median

`shoulderWidth` is nearly constant for the same person. The estimate uses a median over an 8-second rolling window and a slow published update. This avoids two problems:

- frame-to-frame noise does not become phantom swing velocity;
- a brief change in camera distance or a few outliers do not rewrite the scale.

Scale readiness (`readiness.scale01`) combines observed span, temporal coverage, and median dispersion.

### 3. Neutral vertical — RANSAC-style temporal consensus

`leanUp0` comes from verified extended legs when there is enough evidence; otherwise, it uses torso direction. Instead of averaging, it uses temporal vector consensus:

1. Each candidate vector is scored by the weight of vectors that agree with it within 15°.
2. The dominant group wins.
3. The reference is the normalized combination of that group.

This is a simple RANSAC-style consensus or mode: transient leans and noisy frames do not pull the vertical as they would an average.

### 4. Neutral lean — histogram mode with weak priors

`torsoLeanRad0` is estimated using a histogram mode followed by a local median. Two weak priors protect against control feedback:

- An upright-posture prior makes large leans less likely to be neutral.
- A prior based on the current posterior prevents deviations from the published reference from immediately recentering neutral.

These priors do not prevent adaptation. A sustained, recurring new posture still accumulates evidence and moves the reference slowly. This is intentional: without that delay, holding a lean to control the lane would recenter neutral and create circular drift — the game would require an increasingly large lean.

Neutral readiness (`readiness.neutral01`) combines time, coverage, mode strength, and local dispersion. It converges more slowly than scale because lateral lean is also a control input.

### 5. Wrist rest position — recurring low-velocity spatial clustering

For each hand independently:

1. The wrist is transformed into body-local coordinates and normalized by `shoulderWidth`.
2. Velocity is calculated in the same reference frame, so torso sway does not count as wrist movement.
3. Only low-velocity frames are considered rest candidates.
4. A dense cluster must recur — in at least two separate episodes or one long hold.
5. The published reference is the cluster median and changes slowly.

A single short pause does not become a reference. This reduces the risk of treating the end of a racket swing as a neutral position.

### 6. Progressive publication by dependency

The profile is no longer all-or-nothing:

- Running, cadence, and jumping do not depend on the profile.
- Swing depends on body scale (`scale01`), so it can activate early.
- Lane control depends on the neutral reference (`neutral01`), so it activates later.
- Wrist reference is optional and tracked per hand; without it, swing detection still rearms after sustained low velocity.

The player sees no calibration phases, progress, diagnostics, or calibration instructions.

## Fundamental limit: identifiability

No algorithm using only a monocular camera can perfectly distinguish these two situations:

1. The person has actually changed their neutral posture.
2. The person is holding a lean as a control input for a long time.

For that reason, the solution does not promise perfect, instantaneous adaptation. The correct safeguards combine:

- a stability prior;
- slow adaptation;
- recurring evidence;
- hysteresis;
- rolling windows;
- readiness separated by control.

This is the inherent trade-off of implicit calibration. The implemented version chooses not to sacrifice control stability in order to adapt too quickly.

## Current tests

`tests/adaptiveCalibration.test.ts` covers:

- torso-only publication in under 1 second without legs or wrists;
- withholding publication until minimum span and coverage are met;
- long callback gaps not counting as evidence;
- robust median of shoulder width;
- preference for vertical from extended legs and fallback to the torso;
- rejection of a hidden core or `NaN` confidence;
- slow adaptation to a neutral posture;
- no recentering after a short lane-style lean;
- swing activation before the neutral lane reference;
- not learning a wrist rest position from one short pause;
- learning a rest position from recurrence.

## Validation still needed

Synthetic tests establish the logic, not real-world ergonomics. Before adjusting the numbers, measure the following with a real webcam or replay:

- p95 shoulder/hip and wrist jitter in normal, low, and backlit conditions;
- time until `scale01` and `neutral01` cross their thresholds;
- false lane and swing frequency during the first 10 seconds;
- neutral drift while holding lane-control leans for 1, 3, and 10 seconds;
- convergence of wrist references during real rallies;
- CPU/GPU and 30/60 fps comparisons.

## External sources consulted

- [JointTracker: recursive online calibration/tracking for human kinematic chains](https://pmc.ncbi.nlm.nih.gov/articles/PMC11216284/)
- [Transformer IMU Calibrator — dynamic/implicit calibration during activity](https://arxiv.org/pdf/2506.10580)
- [High-Accuracy Real-Time Whole-Body Human Motion Tracking Based on Constrained Nonlinear Kalman Filtering](https://arxiv.org/abs/1511.04278)

These sources motivate the direction; this implementation is specific to BlazePose’s monocular invariants and limitations.
