# Boxing Plan: Tracking, External Validation, Game, and Tutorial

Date: November 27, 2026 · Studied base: `origin/main` `94ffaaa`. Planning document, not an implementation. It separates what already exists in code, measured evidence, external research, and proposed decisions.

---

## 0. Implementation status (Nov. 27, 2026, branch `research/boxing-tracking-plan`)

Implemented with passing tests (`npm test && npm run lint && npm run build`):

- **FPS-parameterized replay** (`f4bef05`): `pose-replay.html?fps=15` samples at the clip's frame rate — prerequisite for UTD evaluation.
- **Trajectory measurement and classification** (`e39196d`): `PunchMeasurement` (body-local samples in shoulder widths, contact, peak velocity, displacements) is emitted with a confirmed `punch` event; pure `punchClassifier.ts` classifies `straight/hook/uppercut/unknown` and target `head/body/unknown`; `PunchDetector.diagnostics` counts failure reasons (onsets, confirmations, missed extension/travel), and `ActionPipeline.punchDiagnostics` aggregates them by hand.
- **Typed punches, duck defense, and typed opponent attacks** (`37f7055`): `DuckTracker` in image space (world landmarks are hip-centered and unsuitable); defense matrix `isDodgedTyped` — straight to head: slip/duck; straight to body: only retreat/guard; hook: duck; uppercut: slip, duck never helps. Player damage rules: uppercut +25% when the opponent is open, hook penetrates half guard, body punch deals 75% damage but ignores high guard. Opponent chooses hand, type, and target in fixed RNG order.
- **Adaptive tutorial** (`580f67c`): pure `BoxingTutorial` (guard 1 s → 3 jabs → 3 crosses → 2 hooks → 2 uppercuts → 2 body punches → 2 slips → 2 ducks), learns lead hand and median reach by type in memory; `tutorial` game mode with passive opponent, hint after 10 s, abandons a stage after 22 s, raised-hands gesture skips.

Pending, in this order: validate type and target against scripted recordings, then validate with real people.

**Revised external-validation strategy (Nov. 27, 2026):** BoxingVI does not answer the type question for our domain. Its clips are fight broadcasts filmed from the side — punches travel perpendicular to the camera axis, so the depth channel used by our measurements simply does not exist in those videos — and its pose annotations are 2D AlphaPose in image space, incompatible with the shoulder-width body-local trajectory consumed by the classifier. The Zenodo Olympic dataset has the same problem (ringside GoPro, athletes small in frame, two fighters occluding each other). The question "Does the classifier get jab/cross/hook/uppercut and head/body right on a front-facing webcam?" can only be answered with frontal recordings of known punches — exactly the scripted-recording infrastructure the project already had for tennis. Implemented: `BOXING_RECORDING_SCRIPT` (guard → 3 jabs → 3 crosses → 2 hooks → 2 uppercuts → 2 body punches → slips → ducks → 2 negative controls), G key in boxing mode records the script with `boxe-` prefix, and `tests/recordedBoxing.test.ts` evaluates type/target by window using the same script timing. A real person still needs to perform the script once to calibrate the floor.

**Deep study with the first real recording (Nov. 28, 2026):** the first scripted recording (11.3 fps, CPU delegate — the real production condition, worse than UTD's 15 fps) revealed three mechanisms with direct evidence:

1. **Crouching fabricates phantom uppercuts.** Punch coordinates are relative to the shoulder; during a duck, the shoulders drop ~0.25 normalized units and a fist stationary in world space "rises" 1.0–1.6 widths in the local reference — a trajectory identical to an uppercut, with real elbow extension (the arm really does extend when the shoulder drops and the fist stays put). The local arm signal is indistinguishable from a punch; the only discriminator is reference motion. Implemented: veto onset while the shoulder line is rapidly descending (`REFERENCE_VETO_SPEED_SW_PER_S` = 0.7 sw/s, downward only). Documented cost: UTD floor drops from 23 to 22 clips — an athletic punch with torso drop is genuinely ambiguous (s1t4 descends at 2.1 sw/s) — and the gameplay gain (defense no longer becomes a phantom attack) outweighs that clip. **Known residual**: an onset that fires on the descent ramp before measured velocity crosses the threshold escapes (the filter adds ~1 frame of delay); one phantom per recording is the current ceiling, encoded in the floor.

2. **Punch shape cannot be measured in the wrong window or reference frame.** Two independent corruptions: (a) the confirmation window (walk-back + grace) includes motion that is not part of the punch — retraction inflates `pathLength` and dilutes shares, while an extended elbow from previous combinations contaminates the origin; (b) the shoulder reference **rotates with the torso** — a cross with correct hip rotation sweeps 1.5–2.0 widths laterally in the reference frame without any real arc in the world. Implemented: wrist positions are projected into the body basis **frozen at onset** (`frozen` in samples), and the classifier measures shape in a self-delimited window — from contact (maximum forward position in the frozen frame) backward while forward increases without interruption and never crossing an already extended elbow (a punch starts from a bent chamber). Result in the real recording: the jab correctly classifies as `straight/head`; anchor tests cover retraction and chamber noise. Additional discovery: at 11 fps, onset fires at the physical peak of extension, so nearly all shape occurs *before* onset — the onset→contact window degenerates in production.

3. **Confirmation recall at 11 fps remains the dominant bottleneck** (`missingExtension` 24 vs. `missingTravel` 13 in the recording): brief physical extension is barely represented in the 11 fps reconstruction. Lowering the travel floor to 0.15 recovers almost nothing and admits a false positive from guard — evidence that extension, not travel, is the bottleneck. The bent-stop of origin walk-back is geometrically correct but was reverted: confirmation at 11 fps currently depends on the full walk-back — technical debt noted for the recall work.

**Confirmation recall resolved with evidence (Nov. 28, 2026):** window instrumentation revealed that elbow extension was *structurally corrupted* in production geometry. Punching toward the camera is the worst case for monocular reconstruction — the arm shortens along the optical axis and depth noise collapses the reconstructed angle: in the real 11 fps recording, raw jab cosine spikes at 0.2–0.37 and **never** reaches 0.65 in any frame. The geometric threshold measured what the arm *is*, not what it *measures as*. Threshold sweeps against three floors showed: false-positive count **identical** at 0.65, 0.2, and with no requirement at all (precision is preserved by onset speed + travel + closure on retraction), UTD 22→24 clips, real-recording recall 7→15 punches. Below 0.2, only the duck phantom appears — 0.2 is the adopted threshold, with evidence in code. Complementary discovery: mirrored onsets in both hands during one-handed punches (torso rotation contaminates both channels) and onsets during slips — neither confirms, validating the downstream chain.

Pending, in this order: residual duck phantom (retroactive veto or adjudication), cross-validation with more bodies. The origin walk-back bent-stop was **tested and rejected with the extension floor corrected**: it removes the residual duck phantom (honest origins do not inflate the phantom's travel) but costs 2 UTD clips and 1–2 real punches — and the self-delimited classifier already protects shape independently of origin. Recall is the dominant production quality; the trade-off is not justified.

**Tutorial adaptation connected to the detector (Nov. 27, 2026):** the profile learned in the tutorial was not consumed by anything — it now follows the tennis pattern. Tutorial mode enters with the generous confirmation floor (`LEARNING_PUNCH_TRAVEL` = 0.15 widths, so compact beginner punches can confirm), then informs the pipeline of adapted travel: three quarters of the median demonstrated reach, clamped between 0.15 and the 0.25 default — adaptation only relaxes, never tightens beyond the default. The value persists in the pipeline when the player leaves for the fight, and returns to default when switching sports. Covered by tests in `boxingTutorial.test.ts` (math), `punchDetector.test.ts` (compact punch confirms only with adapted floor), and `boxingGame.test.ts` (full game→pipeline path).

**Formal UTD-MHAD baseline (Nov. 27, 2026, instrumented pipeline, 32 a13 clips at 15 fps):** 13/32 clips confirm ≥1 punch in the interior; 3/8 subjects reach ≥3/4 — below the success criterion (6/8). Counters show 67 onsets for 15 confirmations, with dominant causes `missingExtension` 43 and `missingTravel` 35 (and `timedOut` 11), versus **zero** `sampleGaps` and zero `invalidSamples`. Interpretation: pose tracking is not the problem; punches start but fail to reach elbow extension (cos ≥ 0.65) or travel (≥ 0.25 shoulder widths) within 350 ms — consistent with frontal shadowboxing, compact punches, and no opponent. Next step is to review the confirmation chain against this evidence (time window, full-extension requirement, or both), without loosening it enough to accept non-punch gestures. Secondary observation: some confirmed punches classify as `uppercut` during actions labeled frontal punches — BoxingVI type validation will tell us whether that is classifier bias or subject repertoire.

**Hardening the confirmation chain (Nov. 27, 2026, same branch):** three measurement fixes — no thresholds relaxed — guided by counters and frame-by-frame analysis:

1. **Stroke origin.** Onset fires once the wrist is already fast (≥ 1.5 widths/s), so much of the stroke occurred before the measurement origin: measured from the full movement, the fist advances 0.4–1.35 widths; measured from onset, only 0.12–0.3. The detector now walks backward through the filtered series (up to 300 ms) to find where forward movement began.
2. **Window closed before the peak.** Maximum extension physically coincides with the start of retraction, and OneEuro filters delay by 1–2 frames — the window closed on the first retraction frame, before the filtered cosine showed the peak. Unconfirmed punches get 120 ms of retraction grace; confirmed punches still close immediately.
3. **Extension evaluated at the raw peak.** The filtered cosine attenuates brief peaks by 0.03–0.1; closure evaluation uses the maximum of filtered and raw values across the window (one isolated noisy frame is not enough: onset, travel, and timing are still required).

Result on the permanent offline floor (`tests/utdMhadBoxing.test.ts`, recordings gitignored): **23/32 clips, 6/8 subjects at ≥3/4 — the preregistered success criterion is met** (was 13/32 and 3/8). Subject 5 has geometrically impossible reconstruction (the fist gains half a meter of depth in one frame) and subject 2 is marginal (1/4). Negative control (`tests/utdMhadNegatives.test.ts`, 56 clips from 7 non-boxing actions by the same subjects): **zero false punches in 6 actions**; only jumping jacks (a27) produced 2 readings in 1 clip — clean precision. Residual observation: `missingTravel` remains relevant because MediaPipe depth reconstruction is noisier exactly when the arm points toward the camera — the z channel is the weak link in frontal-punch measurement.

**Visual inspection of clips (extracted frames):** subjects are far from the camera (full body in frame, small figure) and punch with arms hanging, without a guard. Marginal subjects 2 and 5 make genuinely compact punches, with little arm extension — their residual misses are poor input + weak movement, not detector logic. Important caveat for type classification: because punches start from hanging arms, raising the guard contaminates `verticalRise` measured from movement onset, and 15/29 confirmed punches classify as `uppercut` during frontal-punch actions — a measurement bias in this dev set, not necessarily in the game, where the tutorial teaches a high guard before punching. **Type validation requires BoxingVI, as planned; UTD cannot answer that question.**

---

## 1. Executive summary

Boxing already exists on `main`: there is a punch detector, guard, lateral dodge, approach/retreat, dash, heavy-bag training, dodge training, and first-person fighting. The problem is no longer "create boxing from scratch"; it is to make boxing **legible through body movement and validated**:

1. **Harden measurement before classification.** An exploratory UTD-MHAD evaluation found pose tracked in ~96% of frames, but only 14/32 `front boxing` clips confirmed at least one punch. There were 64 `punch-start` events vs. 15 confirmed `punch` events. The bottleneck is the confirmation chain, not pose presence.
2. **Separate detection from classification.** `PunchDetector` should keep answering quickly, "Was there a punch?" A pure classifier should consume the measured trajectory and answer "jab/cross/hook/uppercut?" and "head/body?"
3. **Use datasets for validation, not retuning until they pass.** UTD-MHAD is the first test because it is frontal and webcam-like; BoxingVI is the best set specific to punch types; the Szczyrk/Zenodo Olympic dataset is best for head/body/block/miss targets; recordings of other people remain irreplaceable.
4. **Copy the tennis pattern:** a timing game with retroactive adjudication, a pure tutorial that learns the person, and generous assistance when a compact movement is not recognized.
5. **Adaptive tutorial is part of tracking.** It is not just instruction: it is the phase that measures that person's guard, lead hand, punch size, target height, and dodge range.

---

## 2. What athletics and tennis teach us

### 2.1 Shared pipeline

```
webcam
  -> PoseClient/pose.worker (MediaPipe Pose Landmarker, CPU by default)
  -> PoseSnapshot with image landmarks + world landmarks
  -> AdaptiveCalibrator (scale, neutral center, reference pulses)
  -> ActionPipeline
       -> discrete events (sprint, swing, punch-start, punch)
       -> continuous controls (guard, dodgeZone, ringDepth, lateralDash)
  -> game
```

Important decisions already proven in the project:

- **Measure in shoulder widths.** Cancels camera distance and makes it possible to compare different bodies.
- **Two-phase discrete signal.** `*-start` is early and unconfirmed, useful for animation; the confirmed event carries the estimated physical peak time and is used for rules.
- **Retroactive adjudication.** Tennis judges contact at `peakTimestampMs`, not when confirmation arrives. Boxing already uses the same idea through `openingAt` and zone history.
- **Pure rule modules.** `boxingRules.ts`, `opponentAi.ts`, and `trainingRules.ts` do not import DOM or Three.js. Keep it that way.
- **Implicit calibration.** `AdaptiveCalibrator` learns scale, neutral center, and pulse positions during play, using temporal evidence and slow blending.
- **Pure adaptive tutorial.** `tennis/tutorial.ts` advances on recognized movement, explains after ~10 s without progress, gives up/advances after ~22 s, can be skipped, and learns racket hand and swing size without becoming stricter than the defaults.
- **Generous fallback.** Tennis assists players whose compact movements do not pass the main detector. Boxing needs the same principle: a clear but short punch must not simply disappear.

### 2.2 The project's most important constraint

`docs/jogos-pelo-corpo.md` states that thresholds were tuned using recordings of **one person**, in one room/webcam setup, and that a new recording once dropped running detection to 42%. That is the central failure to avoid in boxing: working on the developer's body is not enough.

---

## 3. What already exists in boxing on `main`

### 3.1 Sensing

`src/kinematics/punchDetector.ts`:

- one detector per hand;
- measures wrist pulses in body-local coordinates, with `forward = -z`;
- onset requires forward velocity and elbow opening;
- confirmation requires minimum extension and forward travel within a window;
- power comes from peak velocity;
- rearms on retraction or rest;
- comments themselves say thresholds are tunable guesses tested only with synthetic poses.

`src/kinematics/postureSignals.ts` and `boxingLocomotion.ts`:

- `DodgeZoneTracker`: small lateral lean relative to calibrated center;
- `RingDepthTracker`: approach/retreat through apparent scale, combining shoulder width and torso height;
- `LateralDashTracker`: short lateral jump;
- binary guard based on wrists held high, close to the body, with bent elbows.

Current structural limitations:

- punching requires hips in addition to shoulders/elbow/wrist, although `bodyBasis` can fall back to gravity vertical without hips;
- `ActionPipeline` feeds `PunchDetector` only when the gate is `tracked`; `degraded` frames interrupt continuity;
- guard requires both hands and the whole torso;
- no punch-type classification, target height, lead/rear hand, or downward dodge (`duck`);
- no boxing-specific tutorial/calibration.

### 3.2 Game

`src/games/boxing/` already contains:

- first-person fighting with HP, 3 rounds of 60 s, guard, damage, counterattack, and KO;
- opponent with a pure guard → windup → recover cycle and retroactive `openingAt`;
- rhythm-based heavy-bag training and zone-based dodge training;
- ring movement through sustained lean, depth, and dash;
- mode/opponent selection and development keyboard controls.

The current game treats every confirmed punch the same, varying only `power01`, opening, and counterattack. The next design opportunity is to make **type** and **target** matter without building an overly complex simulation.

---

## 4. Exploratory UTD-MHAD measurement

### 4.1 Method

Exploratory evaluation, not a final benchmark and not a criterion for threshold tuning:

- UTD-MHAD action `a13` (`front boxing`), 8 people × 4 trials = 32 clips;
- RGB 640×480, AVI headers at 15 fps; temporary conversion to WebM preserving resolution and frame count, nominally at 15 fps;
- headless Chromium 159, real worker, CPU delegate, Pose Landmarker Lite;
- `AdaptiveCalibrator` + `ActionPipeline` from `main`, with the center band used by boxing mode;
- clip detection criterion: at least one confirmed `punch` in the clip interior (excluding 0.5 s at the start and 0.25 s at the end);
- no thresholds changed; no clip selected after viewing results.

Artifacts and media were kept outside Git in `/tmp`, following the privacy policy. SHA-256 of the local manifest for the `a13` AVIs: `d08eef993d3b51e790c0af87f0a3479e88f07a755fd164d136752188444515c5`.

### 4.2 Result

| Metric | Result |
|---|---:|
| clips processed | 32/32 |
| frames with `tracked` tracking | 96.1% average |
| frames with scale ready | 78.3% average |
| clips with ≥1 confirmed punch | 14/32 (43.8%) |
| people with ≥3/4 trials detected | 3/8 |
| total `punch-start` | 64 |
| total confirmed `punch` | 15 |
| subject 2 | 0/4 trials detected |
| subject 5 | 0/4 trials detected |

Per person, trials with at least one confirmed punch:

| Person | Trials detected |
|---:|---:|
| 1 | 1/4 |
| 2 | 0/4 |
| 3 | 3/4 |
| 4 | 2/4 |
| 5 | 0/4 |
| 6 | 2/4 |
| 7 | 3/4 |
| 8 | 3/4 |

### 4.3 Interpretation

The detector sees the body almost all the time, but starts far more punches than it confirms. The primary hypothesis should not be "lower everything"; it should be to measure where the chain fails:

1. onset fires late, near the peak, because of 15 fps and filtering;
2. monocular forward displacement in `z` is unstable and sometimes does not accumulate the minimum travel from the sample before onset;
3. `degraded` frames during extension cause the pipeline to skip samples, and a short sequence of gaps resets the detector;
4. retraction/deceleration is detected before a sample simultaneously satisfies extension and travel;
5. different people perform "front boxing" with very different range and speed — exactly the problem the project already knows about.

`punch-start` is not a clean count of candidate punches either: rearm/re-onset can inflate the total within one action. Even so, the asymmetry is too large to ignore. Since `a13` is an action label per clip, not per punch, this measurement does not estimate precision or recall per punch. It also does not measure false positives. It is smoke-test evidence: tracking exists, but it is not yet robust across bodies.

---

## 5. Public datasets and the role of each

### 5.1 Selection matrix

| Dataset | Contents | Why it matters | Limits/license | Proposed role |
|---|---|---|---|---|
| [UTD-MHAD](https://personal.utdallas.edu/~kehtar/UTD-MHAD.html) | 8 people, 4 repetitions, RGB/depth/skeleton/IMU; action 13 `front boxing`; frontal view | Closest to a front-facing webcam setup; already used here for running | Page does not declare a standard license; people are small in frame; only one generic boxing class | **First external smoke test** for presence/robustness, not fine-grained classification |
| [BoxingVI](https://github.com/Bikudebug/BoxingVI) / [paper](https://arxiv.org/abs/2511.16524) | 6,915 punch clips, 20 YouTube videos, 18 athletes, 6 classes: cross, jab, lead/rear hook, lead/rear uppercut; temporal boundaries + 2D AlphaPose | Best match for type classification in real monocular video | Repository has no declared license; Google Drive download; training/instruction videos, not home webcams; AlphaPose pose ≠ MediaPipe | **Primary punch-type benchmark**, split by subject |
| [Olympic Boxing Fight Video Dataset](https://doi.org/10.5281/zenodo.21295125) | 22 fights, 4 synchronized 1080p50 GoPros, blurred faces; head/body/block/miss classes per hand, expert annotated | Best source for head/body target and blocked/missed outcomes | CC BY 4.0; real fights with occlusion and two people; youth-category participants, requiring ethical care even when anonymized | **Target/defense benchmark**, not first webcam validation |
| [Smart Boxer IMU](https://doi.org/10.5281/zenodo.14965635) / [paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC12061147/) | Wrist IMU at 200 Hz from elite boxers, lead/rear jab/hook/uppercut | Reference for temporal dynamics and type separability; CC BY 4.0 | Not vision; sensor axes are not camera axes; continuous data requires segmentation | **Kinematic plausibility check**, not game input |
| Berkeley MHAD | 12 people, `punching` action, mocap + multiview RGB/depth/accelerometer | 3D body ground truth and style variation | Official site is currently unstable; BSD-2 license reported in a secondary catalog, needs confirmation before use/redistribution | Secondary 3D reference |
| [MSR Action3D](https://sites.google.com/view/wanqingli/data-sets/msr-action3d) | `forward punch` and `side-boxing`, 10 subjects, depth + 20-joint skeleton | Two punch forms in controlled data | No complete natural RGB in a format compatible with our pipeline; license unclear | Low priority; skeletal comparator |
| [NTU RGB+D](https://rose1.ntu.edu.sg/dataset/actionRecognition/) | A50 `punch/slap`, 40 subjects, RGB+D+IR+3D joints, 3 cameras | Scale and body diversity | Terms require an institutional academic project and institutional email; action is an interaction between two people, not boxing technique | **Do not use in this personal project** |
| [UCF101](https://www.crcv.ucf.edu/research/data-sets/ucf101/) / [Kinetics](https://arxiv.org/abs/1705.06950) | Classes `BoxingPunchingBag`, `BoxingSpeedBag`, `punching bag`, `punching person (boxing)` | Visual diversity "in the wild" | Clip labels only, not enough segmentation/pose/cleanliness; YouTube links and variable terms | Qualitative reference/stress test, never a threshold criterion |
| [BoxMAC](https://arxiv.org/abs/2412.18204) | 15 professional boxers, 13 labels including punches, stance, slip, block, guard, duck, clinch; 60k frames/2,314 clips | Rare defense coverage | Paper does not make availability/license equally clear; no pose; fight setting | Taxonomy inspiration and possible future benchmark |

### 5.2 Practical consequence

No single dataset answers the product question: "Can an ordinary person in front of a laptop webcam make a movement our detector understands?" Validation therefore needs layers:

1. **UTD-MHAD**: different bodies in a controlled frontal camera setup.
2. **BoxingVI/Olympic**: real technique and target variety.
3. **Our own recordings with at least 3 other people**: the only layer representing distance, framing, lighting, and player behavior in our game.

Criteria and analysis must be defined before results are examined. Datasets stay out of the repository; only manifests, hashes, and aggregate metrics are kept.

---

## 6. Biomechanical evidence useful for design

The literature does not provide direct thresholds for our webcam, but it helps prevent design mistakes:

- A 3D study of 15 amateurs found significant differences between straight punches, hooks, and uppercuts; the jab had the shortest delivery time (~405 ms), and the lead hook had the highest fist velocity (~11.95 m/s) ([Tandfonline, 2018](https://www.tandfonline.com/doi/full/10.1080/24748668.2018.1525651)).
- A study of jabs/crosses/hooks in competitive boxers also found shorter times for jabs/crosses than hooks and contact velocities on the order of several m/s ([Sports Biomechanics, 2011](https://doi.org/10.1080/14763141.2010.547590)).
- A classic study with synchronized cameras observed contact speeds of 5.9–8.2 m/s and kinematic differences between hooks and jabs ([PubMed](https://pubmed.ncbi.nlm.nih.gov/3377096/)).
- The Smart Boxer study reports complete punches averaging ~0.9 s and uses time-frequency IMU features; jab/hook/uppercut separate through patterns of intensity, curvature, and rotational control ([PLOS One, 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12061147/)).
- A study of defenses in elite boxers describes slipping, ducking, and sidesteps as center-of-mass/torso movements whose range, speed, and symmetry depend on athlete level ([BMC Sports Science, 2026](https://link.springer.com/article/10.1186/s13102-026-01693-x)).

Implication for a 15–30 fps webcam: a jab may last only ~6–12 frames; its peak may fall between frames; motion blur is expected. The design cannot depend on one exact sample or precise `z`. It should depend on **trajectory shape**, generous confirmation windows, and estimated peak timestamps.

---

## 7. Proposed tracking architecture

### 7.1 Separate three questions

1. **Was there a punch?** — reactive, low-latency detector, per hand.
2. **What kind of punch was it?** — pure classifier over the already measured trajectory.
3. **Was the body defending/dodging?** — independent continuous controls, sampled over the punch's physical window.

This avoids turning `PunchDetector` into a huge state machine and preserves the `punch-start` channel for animation.

### 7.2 Measurements the detector should preserve

Today the confirmed event carries only hand, power, and timestamps. To classify without guessing later, the detector should retain trajectory samples from onset through confirmation/retraction, in shoulder-width units:

- wrist position `(x, y, z)` relative to its own shoulder;
- elbow cosine/angle;
- time, velocity, and height at the peak;
- origin, peak, and end positions;
- forward, lateral, and vertical travel;
- path length and displacement/path ratio;
- approximate torso rotation from the shoulder line, when reliable;
- confidence and count of missed frames.

The public event need not expose the entire raw series if that bloats the protocol; it could expose a compact `PunchMeasurement`. Test modules can consume the internal series.

### 7.3 Punch-type classification

Initial classes, deliberately small:

| Geometric class | Expected signature | Game use |
|---|---|---|
| `straight` | forward dominance, high elbow extension, relatively straight path | jab/cross depending on hand relative to stance |
| `hook` | large lateral/horizontal curvature component, less-extended elbow, torso rotation | angular punch, can bypass part of guard |
| `uppercut` | upward vertical component + moderate extension, curved bottom-to-top path | punish a duck/low guard |
| `unknown` | insufficient evidence | must always exist; never pretend certainty |

`jab` and `cross` are not just arm geometry: they depend on which hand leads in the stance. The tutorial should infer or ask for the stance through body movement. If stance is uncertain, the game can use hypothetical `straight-lead`/`straight-rear` labels or simply `straight` without forcing boxing terminology.

Design rules:

- classification is probabilistic internally, discrete externally, with `confidence`;
- `unknown` is a legitimate result and uses the generic punch rule;
- never classify from a single axis; compact hooks/uppercuts are inherently ambiguous;
- classification must not delay the event: compute it at the same confirmation point using only data available up to then.

### 7.4 Target: head or body

The user asked for punches to the head and chest/body. The robust approach is not to infer fine-grained intent, but to use two generous zones:

- `head`: fist height at peak/contact near or above the shoulder/chin line;
- `body`: height clearly below the shoulder line, in the chest/abdomen range;
- `unknown`: intermediate zone or weak tracking.

Height should be relative to calibrated torso, not raw image coordinates. Leaning the torso down must not, by itself, turn every punch into a body shot; therefore the decision uses fist position in body coordinates and, when available, a guard reference learned in the tutorial.

### 7.5 Defenses

Guard and lateral slip exist today. The minimal complete plan is:

| Defense | Signal | Status |
|---|---|---|
| high guard | wrists near face/shoulders, elbows bent | exists as a binary signal |
| left/right slip | small lateral displacement from neutral center | exists as `dodgeZone` |
| duck | fast, reversible vertical drop of shoulders/head relative to neutral | **missing** |
| retreat | increased distance/apparent body shrinkage | exists as `ringDepthMove`/`ringDepth01` |
| low/body guard | wrists protecting torso, not face | **optional, after measurement** |

`duck` deserves its own pure tracker, with hysteresis and protection against confusing a slow repositioning crouch with a defensive move. As with punches, there should be an early onset for animation and a confirmed/continuous state for rules.

Manual parries are out of the initial scope: a short lateral hand movement is very easy to confuse with a hook, an incomplete guard, or a posture adjustment on a front-facing webcam.

### 7.6 Temporal robustness

Changes to test in the pipeline before classification:

1. **Do not discard a punch because of one blurred frame.** As in `SwingDetector`, skip a short gap; reset after long gaps.
2. **Separate gates.** Punching may not need the same hips as footwork. If `bodyBasis` falls back without hips, measure whether that is enough for the arm; footwork still requires the full torso.
3. **Instrument non-confirmation reasons.** Pure counters: onset without extension, extension without travel, timeout, sample gap, low confidence, retraction before confirmation.
4. **Measure 15 and 30 fps separately.** UTD is 15 fps; webcams may be 30/60. Do not choose a threshold that only works because there are more samples.
5. **Benchmark latency.** Use `pose-bench.html` before/after; classification must not add perceptible latency because it uses data already available.

---

## 8. Proposed gameplay

### 8.1 Arcade principle

As in tennis, the game should be **legible, not a faithful simulation**. The player needs to understand why they won or lost each exchange.

Proposed core rules:

- every confirmed punch has some effect if it is in range and within the timing window;
- class and target modify risk/reward, rather than creating impossible moves;
- guard reduces damage; it does not negate everything forever;
- dodging in the right direction opens a counterattack;
- a classification error degrades to a generic rule and never feels unfair.

### 8.2 Initial consequences table

A proposal small enough to test:

| Recognized punch | Advantage | Cost/risk |
|---|---|---|
| jab/lead straight | fast, good chance to interrupt windup, low commitment | low damage |
| cross/rear straight | medium/high damage, greater range | longer recovery; punishable if slow |
| hook | bonus against front guard or when target is aligned to the side | a miss leaves a larger opening |
| uppercut | bonus against duck or low guard | requires close range; weak against retreat |
| body punch | lower HP damage, but reduces stamina/guard or slows recovery | less decisive than a head shot |
| head punch | higher damage | easier to defend with slip/high guard |

One design decision remains open: whether to add stamina. The KISS recommendation is **do not add stamina in the first iteration**. Instead, body punches apply a short, visible debuff to the opponent's recovery/guard; if that feels arbitrary, only then consider stamina as an explicit resource.

### 8.3 Opponent

The opponent should move beyond just `hand + targetZone` and use a typed attack:

```
hand: left/right
kind: straight/hook/uppercut
target: head/body
lane: -1/0/1
impactAtMs
```

The correct defense depends on attack type, with a few memorable rules:

- high straight: slip or high guard;
- hook: duck/retreat or guard on the correct side;
- uppercut: do not duck; retreat/high guard;
- body punch: retreat or low guard, if low guard is added; otherwise step back.

The visual telegraph must be honest: the opponent shows the shoulder/hip/glove distinctly before impact. As in the tennis design, reaction timing should start from the physical event, and the defense window should use body samples in the interval `[impact, impact + grace]`.

### 8.4 Training and modes

- **Heavy bag:** ideal for teaching punch types and targets. The bag/mitt can ask for "high jab", "body cross", "hook" in sequence, scoring recognized type and timing.
- **Dodge training:** evolve from lateral zones to typed attacks, while keeping the same pure telegraph/active/resolved state machine.
- **Fight:** only after the player completes a short version of the tutorial, or explicitly skips it.

---

## 9. Adaptive boxing tutorial

### 9.1 Principles copied from tennis

- one instruction at a time;
- no active opponent while learning;
- more generous criteria at the beginning;
- a hint after ~10 s without progress;
- advance/give up after ~22 s so the player is not stuck;
- raised-hands gesture skips;
- learn without becoming stricter than defaults;
- keep every tutorial rule in a testable pure class, like `TennisTutorial`.

### 9.2 Proposed sequence

1. **Boxing framing.** Head, shoulders, hips, and wrists visible where possible; enough distance that punches stay in frame. If hips are not needed for punching after gate separation, update the instruction to reflect the actual framing requirement.
2. **Guard.** "Raise both fists near your face." Hold for ~1 s. Learn each hand's guard position and estimate stance.
3. **Lead jab.** Three repetitions. Show the expected hand only after stance is inferred; if uncertain, accept any straight punch first and name it later.
4. **Rear cross/straight.** Three repetitions. Learn forward travel, speed, and extension per hand.
5. **Hook.** Two repetitions per hand or at least one lead hook. Accept a wide movement at first; then measure compact curvature.
6. **Uppercut/body.** Two upward repetitions; then a low target on a visual pad.
7. **High/low target.** Mitts or zones on the opponent/bag request head/body. Learn that person's vertical mapping.
8. **Slip.** Left/right, returning to center. Learn a comfortable range without requiring exaggerated displacement.
9. **Duck/retreat.** One repetition each; if not recognized, keep slip + guard as sufficient defenses.
10. **Short combination.** jab → cross → hook or jab → body → head, without pressure; then a short test fight.

### 9.3 What the tutorial learns

| Learned profile | Later use |
|---|---|
| lead hand/stance | name jab/cross and show correct instructions |
| guard position per hand | reduce false negatives for guard and distinguish high/low |
| typical travel and speed per type | accept compact punches without opening up to noise |
| high/low target height | distinguish head/body for that person/camera |
| slip/duck range | adapt zones without turning noise into a dodge |
| pose loss/quality rate | choose appropriate feedback and assistance |

The profile should live in session memory, like the tennis racket hand. Persisting body data in the browser needs an explicit privacy decision and is not needed for the first version.

### 9.4 Corrective feedback

The tutorial should say what to change, not just "not recognized":

- "Extend your arm farther forward" when extension is insufficient;
- "Start with your fist at guard" when the origin is wrong;
- "Move the hook farther to the side" when laterality is insufficient;
- "Raise your fist at the end" for an uppercut;
- "Aim higher/lower" for the target;
- "Show your whole arm" when confidence/occlusion dominates.

These diagnostics depend on the failure counters in section 7.6 — another reason to instrument before classification.

---

## 10. Validation plan

### 10.1 Required infrastructure

First engineering work, independent of gameplay rules:

1. make `pose-replay` FPS-parameterized (UTD is 15 fps, not 30);
2. allow batch/headless execution that exposes recordings and metrics without redistributing video;
3. save manifests with SHA-256 for clips, conversions, model, commit, and configuration;
4. add counters for punch non-confirmation reasons;
5. record metrics per subject, not only global averages.

These should be small, independent PRs.

### 10.2 UTD-MHAD protocol

Preregister before the next tuning change:

- positives: `a13 front boxing` (32 clips);
- negatives: walking, jogging, squat, and arm actions already used in the running evaluation, plus confusable actions (`throw`, `baseball swing`, `tennis forehand`, `tennis serve`, `two-hand push`, `knock`, `catch`, `pick up and throw`) if extracted;
- positive clip criterion: ≥1 confirmed punch in the interior;
- per-person criterion: ≥3/4 trials;
- proposed initial success criterion: ≥6/8 people, with no material false positives among negatives;
- report `punch-start`, confirmations, power, tracking, scale readiness, and failure reasons.

Since there are no per-punch labels, this test measures minimum sensitivity per clip, not exact punch count.

### 10.3 BoxingVI protocol

- use the published train/validation split by subject, or create a split by athlete if the videos/groups require it;
- pass RGB through the same MediaPipe worker; use AlphaPose only as a comparison reference, not as input;
- metrics: temporal recall by overlap/tolerance, event precision, type confusion matrix, onset→confirmation latency;
- do not tune on validation; tune only on train/dev and report validation once.

### 10.4 Olympic/Zenodo protocol

- use only reviewed/annotated segments, respecting the reviewed-frame list;
- separate metrics for head/body/block/miss targets;
- measure whether our geometric target agrees with the referee's category without expecting perfect correspondence: a body punch in the annotation may have a high final fist position because of posture/reach;
- keep videos out of Git and cite CC BY 4.0 in any figure or public use.

### 10.5 Our own recordings with other people

Minimum criteria before calling boxing robust:

- at least 3 people besides the developer;
- explicit consent; files in `tests/recordings/`, gitignored;
- short guided script: guard, jab, cross, hooks, uppercuts, high/low, slips, duck, retreat, neutral movement;
- predefined criteria per person and movement;
- report compact/fast movers, left-handed people, and people who have never boxed separately.

---

## 11. Recommended implementation sequence

1. **Instrumentation and batchable replay.** Small, independent, no gameplay behavior changes.
2. **Formal UTD baseline.** Repeat the measurement with a complete report and failure reasons.
3. **Generic detector robustness.** Fix gaps/`degraded`/hips/failure counts with synthetic tests and replay; only then adjust thresholds if the evidence points there.
4. **`PunchMeasurement` + pure classifier.** Do not change gameplay rules yet; validate against synthetic fixtures and BoxingVI dev.
5. **Head/body target.** Validate against Olympic and our own recordings; keep `unknown`.
6. **Adaptive tutorial.** In parallel with the classifier, because it produces the profile needed for labels and personal thresholds.
7. **Typed gameplay.** Opponent, type/target rules, heavy-bag training, typed dodge.
8. **Validation with real people.** Only then tune final defaults.

This order avoids the tempting but wrong path: inventing game interactions on top of a detector that still fails to confirm punches from other people.

---

## 12. Explicitly out of scope (YAGNI)

- manual parries in the first version;
- a full stamina bar in the first version;
- fine-grained estimates of real force in Newtons;
- orthodox/southpaw classification beyond what is needed for the lead hand;
- using HandLandmarker for fists/fingers — hands occupy very few pixels in full-body framing and the gain is uncertain;
- training a heavy ML model inside the browser;
- persisting body data without an explicit privacy decision;
- redistributing dataset videos in the repository.

---

## 13. Open decisions for review

1. **Keep boxing body-only or allow keyboard as an explicit dev mode?** The HUD currently exposes keyboard. Recommendation: body control as the main experience; keyboard only behind a flag/dev mode, as a test tool.
2. **Name jab/cross without a reliable stance?** Recommendation: name them only after the tutorial infers stance; otherwise use generic `straight`.
3. **Add low guard now?** Recommendation: not before target validation; high guard + retreat are enough for body punches in the first iteration.
4. **Use BoxingVI without an explicit license?** It may be used for internal evaluation if the download is accessible, but do not redistribute; obtain permission/license or prefer Zenodo CC BY for public artifacts.
5. **When should `PunchDetector` be tightened?** Only after failure counters show the cause; do not use the 14/32 rate as an excuse for blind tuning.
