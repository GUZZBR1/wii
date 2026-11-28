# Research: minimum webcam exposure for per-person calibration

> **Scope note (November 28, 2026):** This analysis describes an earlier implementation, when the menu offered Athletics and Tennis and calibration used an explicit settle-and-collect window. Boxing and continuous, implicit calibration were added later. The discussion of camera conditions and temporally correlated pose noise remains useful; the game list, calibration timings, and implementation-specific conclusions below are historical. For current gameplay and input requirements, see [the current game guide](jogos-pelo-corpo.md).

Question at the time of this study: what is the **minimum** camera exposure—time, framing, and lighting—needed to calibrate the earlier Athletics and Tennis implementation, and what might the engine need for later capabilities? This synthesis covers four areas: BlazePose accuracy research, quiet-standing biomechanics, webcam and imaging techniques, and commercial product practice. It also includes an original statistical analysis of convergence for the `Calibrator` used in that implementation snapshot.

Evidence labels: **[G]** Google document/source · **[I]** independent peer-reviewed study · **[P]** primary manufacturer documentation · **[A]** academic source · **[C]** community/blog · **[Calc]** arithmetic derived here · **[Inf]** inference/synthesis, not a direct result.

---

## 1. Executive answer

The current project asks the player to **settle for 1 s and collect for 3 s, or about 4 s standing still**. The analysis shows:

1. **The code uses 1.8 seconds of valid signal as an engineering hypothesis.** This rounds down the previously accepted worst case (65% × 2800 ms = 1.82 s); it is not a statistically demonstrated minimum for this app. The previous 3-second window was a fault-tolerant policy, not evidence that 1.8 seconds is enough.
2. **Postural sway supports measuring windows of several seconds, but does not determine the minimum by itself.** Soames & Atha found a primary modal frequency of 0.30–0.45 Hz in posturography of young adults (equivalent periods of about 2.2–3.3 s), along with secondary and tertiary peaks. This does not establish the error of a median of BlazePose Lite landmarks, nor prove that a window shorter than half a period causes systematic error in our product.
3. **The code can shorten the time adaptively** when its implemented gates converge. The benefit observed in tests comes from static synthetic fixtures; the time savings and quality on a real webcam still need validation.
4. **Some calibration cannot be removed:** session calibration is necessary for neutral-reference detectors (jump baseline, lane reference, ready position), because those parameters depend on **the person’s habitual posture on that day and with that camera**, not on fixed anthropometry. Kinect avoided calibration because (a) it had a depth sensor with real metric scale and (b) it used absolute detection rather than relative references. Our engine is reference-relative by design. The torso-lean research already documents that “the calibrated reference treats the person’s habitual posture as vertical” (`docs/pesquisa-inclinacao-tronco.md`). That is a feature, not a bug: it makes the detector robust, but ties calibration to the session.
5. **The main quality bottleneck is not resolution or frame rate; it is stable lighting and framing.** Google has not published a minimum lux level for BlazePose. Convergent industry practice points to ≥300 lux on the subject as a prudent target, with diffuse frontal light and stable exposure (without hunting) more important than megapixel count.

---

## 2. Why the median converges quickly—and where it does not

### 2.1 Median statistics

For iid Gaussian noise with standard deviation σ per sample, the median’s error over N samples is approximately **1.253·σ/√N**. With σ = 5 mm (on the order of post-filtering jitter plus sway), about 10 **independent** samples are enough for a median error of roughly 1.6 mm—negligible relative to the detectors’ error budgets (§4). The bottleneck is not the number of frames; it is **independence** between them.

### 2.2 Double filtering destroys temporal independence

MediaPipe applies One Euro filtering internally (finding #1 in `docs/auditoria-mediapipe.md`): `min_cutoff 0.05/beta 80` for image landmarks gives α ≈ 0.01 while still. The time constant is about 1/α frames ≈ 100 frames ≈ **3.3 s at 30 fps** [Calc]. As documented in `docs/pesquisa-robustez-gestos.md`, the residual noise is **slow drift**, not white noise—it “defeats N-consecutive-frame logic.” In a 3-second window, the smoothed noise component has only **about 1–3 effectively independent samples**. The median remains useful against transient outliers (bad frames and occlusion), but it does not suppress slow drift; that passes through.

The central implication is that **increasing frame rate or sample density does not improve calibration**. What helps is (a) a window long enough to cover more sway cycles and (b) rejecting bad frames.

### 2.3 Postural sway: the physical floor of “standing still”

Posturography literature **[I]**:

- Quiet hip: RMS **about 4–5 mm**; shoulders: **about 5–6 mm** (Wiesmeier 2015, PMC4477145).
- Center of pressure (CoP), eyes open, 30 s: peak-to-peak excursion of **22 mm AP / 12 mm ML** (Kenny 2019, PMC6449971).
- Point-to-point movement over about 1 s: **about 4 mm RMS** with eyes open (Doyle 2008, diffusion analysis).
- Center-of-pressure spectrum: Soames & Atha found 90–95% of energy below 2 Hz, with a primary mode at 0.30–0.45 Hz and higher secondary/tertiary peaks. Center of pressure on a platform is not the same signal as webcam-estimated landmarks.
- Standing with feet together **doubles** lateral sway; closing the eyes increases all sway.

Implications for the calibration window [Inf]:

- The measured primary mode corresponds to periods of about 2.2–3.3 s; a 2–4-second capture may contain roughly one cycle, depending on the person and condition.
- The sources reviewed do not measure the error of a landmark median over this window. The millimetre ranges above describe CoP and are not error bounds for this app.
- Therefore, the 1.8-second threshold is a hypothesis to validate with real signals before treating it as a product-quality floor. The synthetic test checks elapsed-time accounting, not the accuracy of the estimated posture.

### 2.4 Systematic error does not average out—but consistency can cancel it

Independent studies of absolute BlazePose accuracy on ordinary webcams **[I]**: Physio2.2M (C920, 30 Hz, 3/3.5 m, compared with marker-based motion capture) reports 2D MPJPE of **83–97 mm**, 3D MPJPE of **146–162 mm**, and z-axis error about twice x/y error (Lite is about 15 mm worse than Full/Heavy).

Those numbers look fatal, but **calibration does not need absolute accuracy; it needs consistency**. The detector uses the same biased measurement system during calibration and gameplay, so fixed bias cancels. What does not cancel:

1. **Pose- or position-dependent bias:** the person calibrates standing neutrally, then plays while leaning, crouching, or extending an arm; configuration-dependent errors do not cancel.
2. **A changed condition between calibration and gameplay:** the camera moves, the person changes distance, or the lighting changes. `docs/pesquisa-inclinacao-tronco.md` already documents: “Recompute or invalidate calibration if the camera moves. Camera-aligned coordinates have no way to detect this.”
3. **The depth axis:** z is the weakest axis (about twice the error); any future detector that depends on depth inherits the weakest signal (striking issue #19).

---

## 3. Physical exposure floors (conditions, not duration)

### 3.1 Framing and pixels on the body

Multi-source consensus:

| Anchor | Value | Source |
|---|---|---|
| Legacy MediaPipe evaluation envelope | Images evaluated with people at **2–4 m**; this is not a guarantee for this app | [G] Pose evaluation |
| BlazePose GHUM model-card scope limit | People beyond **4 m** are out of scope; no validated minimum distance | [G] model card |
| Minimum subject size | **256×256 px** “for best results” (heuristic, ambiguous) | [G] ML Kit |
| Subject height | Ideally **≥1/3 of the frame height** | [P] Apple Vision |
| Minimum input | 480×360 px | [G] ML Kit |
| Internal detector | Person crop is resized to 256²; more frame resolution cannot recover detail the sensor did not resolve | [G] paper |

Geometry for our typical camera (78° diagonal, HFOV ~70°, VFOV ~43°, C920 class) **[Calc]**: at 2 m, a 1.7 m person is about **771 px tall at 720p**—too tall for the frame (107% of its height). At 2.5 m, the person is about 617 px (86%, with room to fit); at 1.5 m, the person does not fit under any assumption. At 640×480, a full body requires roughly 2.3–3 m, depending on height. This is consistent with the range used in the legacy MediaPipe evaluation and industry practice (Kinect 1.8–2.5 m, PS Eye/PSVR 1.5–2 m, Peloton/Tempo ~1.8–2.4 m, OpenCap 2–3 m) **[P/A]**.

A 40 cm shoulder width at 2–2.5 m is about **145–181 px at 720p** (about 90–113 px at 480p after scaling) [Calc]—far above the `Calibrator`’s degenerate-geometry floor (0.03). The gate is for extreme cropping, not normal distances.

Documented failure mode: a 240 px person in a 1080p frame is **not detected** in the full frame, but is detected after cropping [C/G, MediaPipe issue #5157]. The full-body detector operates at 224² and can lose small people before the landmarker gets a chance.

**Framing floor**: the head must be visible (a detector requirement, because the face is used as a proxy for presence); the body should occupy at least one third of the frame; relevant joints should stay away from the edges, with room to move. Running needs the full body, including ankles; tennis needs shoulders to knees plus hands—the split is already implemented.

### 3.2 Lighting and exposure—the real multiplier

**Google has not published a minimum lux level for BlazePose**; it explicitly said it has no calibration for this [G, issue #3453]. Available guidance:

- Logitech recommends **more than 300 lux** to sustain 720p/60 on the C922 [P].
- Theia (professional multi-camera motion capture) recommends **at least 500 lux, ideally 1,000** [P].
- Typical lighting: offices are 300–500 lux; **living rooms are 50–200 lux**—so typical home use is below the preferred range [I].
- In low light, a webcam extends exposure (up to 33 ms at 30 fps), increases gain (noise), and/or **drops frame rate**. This behavior is documented on laptops (15 fps at 20 lux) and controlled by `EXPOSURE_AUTO_PRIORITY` in V4L2 [P].

**For calibration, motion blur is not the constraint**: sway is measured in mm/s, so a 1/30 s exposure blurs by 0.33 mm [Calc]. The real low-light problems are gain noise, **auto-exposure hunting** (frame-to-frame brightness changes, documented as a webcam failure by DXOMARK/VCX), dropped frame rate, and artificial-light flicker (rolling-shutter banding when 50/60 Hz anti-flicker settings are wrong) [P/I].

**After calibration, the gameplay constraint reverses**: a hand moving at 1–3 m/s blurs by 17–50 mm at 1/60 s and 33–100 mm at 1/30 s [Calc]—about 25–70 px at full-body scale, comparable to entire limb segments. Target gameplay exposure: **≤1/60 s, ideally ≤1/120 s**, which requires even more light. The same room may be bright enough to “calibrate” but not to “play.”

One controlled degradation study with Pose Landmarker Full [I, JMIR 2026] found **negligible** effects on mean angular error from moderate synthetic underexposure and blur. However, it digitally simulated degradation on laboratory video; it did not measure noise from a low-cost sensor. This is weak evidence and should not be generalized.

### 3.3 Landmark confidence

A multi-camera study against Vicon **[I]** found that error increases markedly below visibility **0.5**, while variance increases below **0.8**. A practical derivation is 0.5 as a usability floor and **0.7–0.8 for calibration frames** as a conservative target. The current threshold of 0.55 is in the middle—reasonable given that the median rejects outliers, but the worst frames that pass at 0.55–0.7 are the ones the median must absorb.

### 3.4 Frame rate and rolling shutter

- No controlled study of frame rate versus spatial accuracy was found. 30 fps is the denominator used by all validations [I]. Lower frame rate does not worsen an individual frame; it reduces temporal coverage.
- Rolling shutter (typical readout of 16–40 ms on consumer cameras) [P] is irrelevant to a still calibration (about 0.1 mm of shear), but relevant to fast limbs in gameplay (25–75 mm of top-to-bottom shear at 1–3 m/s) [Calc].
- At 7 fps (a degraded device), the requirements of 12 samples over 2.8 s still pass. `docs/analise-gargalos-corrida.md` already notes that the gate is permissive; the cost is that each blackout consumes a larger share of the coverage window.

---

## 4. Error budget by parameter—what sets the time floor

Required precision versus what each calibrated parameter feeds:

| Parameter | Consumer | Error budget | Difficulty |
|---|---|---|---|
| `world.shoulderWidth` | Swing-speed scale | ~10% (4 cm)—loose | Trivial: converges in <1 s |
| `readyWristLocal` | Swing re-arming (radius 0.35 widths, ~14 cm) | ~5 cm—very loose | Trivial |
| `image.torsoHeight` | Knee/jump scale | ~5–10% | Easy |
| `world.leanUp0` | Lane reference; triggers at 0.15 rad (8.6°) | ~2–3° (~2–3 cm of leg geometry) | Moderate: requires verified extended legs—already implemented |
| `image.kneeToHipY0` | Neutral knee offset; on/off bands 0.1/0.05 | ~0.02–0.03 units (~1–2 cm) | Tight |
| `image.hipY0` | Jump baseline; arming ≤0.03, takeoff 0.08 torso | **~0.02 torso (~1–1.5 cm)—the tightest** | Difficult: bias of 0.03 consumes the entire arming band |

The two tightest parameters are **vertical and depend on the true neutral posture**—this is where sway phase error matters. With vertical/ML sway of about 4–6 mm RMS and a median over a window covering roughly one cycle (2–3 s), expected residual error is about 2–4 mm [Inf], within the budget but with little margin. A 1-second window that happens to capture an extreme weight shift (15–30 mm) exceeds the budget by 2–10×. **That is why about 2 seconds of valid signal is the floor, not about 0.5 s**, and why the stillness gate and extended-leg check matter more than the sample count.

---

## 5. Implementation hypothesis for the time floor

The sources do not establish a minimum amount of **valid signal** for this application:

1. **Noise independence:** about 10 independent observations are needed for the median to compress residual white noise. With correlated noise at τ ~0.3–1 s (after double filtering; order of magnitude [Inf]), this calls for a 1–3 s window. It is not the dominant constraint.
2. **Exposure to sway:** the literature suggests low-frequency CoP components, but does not convert them into a minimum duration for pose landmarks. The **1.8 s** limit is an implementation hypothesis pending measurement of duration and error with a real webcam.
3. **Outlier robustness:** the median tolerates fewer than 50% contaminated samples. The old 65% gate allowed up to 35% invalid frames, but that does not measure residual error or guarantee quality in a shorter window.
4. **Posture checks** (extended legs, stillness): these are evaluated per frame but must coincide with valid frames; in practice, the previous items already cover the duration requirement.

Code policy: **1.8 s of valid signal and at least 2 s of span**, with 65% coverage during collection after settling. With static fixtures, the full attempt takes 2 s. None of these values has been validated as an accuracy limit with a real person and webcam.

### 5.1 Where time can be saved without sacrificing quality

1. **Adaptive early exit:** the current code checks coverage gates on every frame and finishes after ≥1.8 s of valid signal (2 s with an ideal fixture). It does not measure independent drift or require 90% coverage; add such criteria only after defining a measure and validating it with a real webcam.
2. **Merge settling with collection:** the current implementation counts frames from the anchor toward the valid-signal floor, but evaluates dropout coverage only after settling. The synthetic test converges in 2 s; the gain and anchor stability need real evaluation.
3. **Sport-specific calibration with minimum scope:** this remains a design option. Today both sports request shoulders, wrists, hips, and knees; tennis does not yet have a reduced profile or a separately validated floor.
4. **No benefit:** increasing frame rate (correlated noise), increasing resolution (the internal crop is 256²), or increasing the minimum sample count beyond the time span.

### 5.2 What not to do

- **Do not lower the floor without measuring error with a real webcam:** synthetic fixtures contain no sway and cannot show whether shorter calibration contaminates `hipY0`, knee references, or the ready position.
- **Do not eliminate session calibration:** the tightest parameters are posture- and session-dependent. What can be eliminated is *unnecessary recalibration* (for example, caching a profile per person—but the camera or room may change, and camera-aligned coordinates cannot detect a camera change; see §2.4).
- **Do not lower calibration confidence below 0.5:** independent evidence shows a marked increase in error below that point.
- **Do not copy Theia’s setup (a 500 px subject height, 1,000 lux):** it is professional multi-camera motion capture, impossible and unnecessary for a 480p webcam.

---

## 6. Consolidated minimum-calibration specification

### Conditions (quality prerequisites)

| Dimension | Engineering reference | Exploratory target | Evidence |
|---|---|---|---|
| Distance (full body) | ~2 m (with the head visible) | 2–2.5 m | [G][P][Calc] |
| Subject height in frame | ≥1/3 | ≥1/2 with room to move | [P Apple][Inf] |
| Maximum distance | 4 m (out of scope beyond this) | ≤3 m | [G] |
| Light on subject | ~300 lux, diffuse frontal light, no backlight | 500+ lux | [P Logitech/Theia][Inf] |
| Exposure during calibration | Any setting up to 1/30 s (sway does not blur) | Stable, no hunting | [Calc][P] |
| Exposure during gameplay | ≤1/60 s | ≤1/120 s | [Calc][Inf] |
| Frame rate | ~15 fps (coverage still converges) | Stable 30 fps | [Inf] |
| Landmark confidence in calibration frame | ≥0.5–0.55 | ≥0.7 | [I] |
| Camera | Fixed; do not move during or after calibration | — | [G/Inf] |
| Posture | Natural foot width, eyes open, relaxed and consistent arms | Fixed visual target | [I posturography] |

### Time

| Component | Theoretical minimum | Current design | Improvement path |
|---|---|---|---|
| Accumulated valid signal | **1.8 s in code** | Not measured on a real webcam | Hypothesis derived from the previous gate (65% × 2800 ms) |
| Clock window | ≥2 s span in code | Not measured on a real webcam | Static synthetic test |
| Settling | Merged into exposure from the anchor | Verify stability of each reference | Current rule plus synthetic test |
| Total attempt (good conditions) | 2 s in fixtures | Not measured on a real webcam | Tests do not measure sway or profile error |
| Tennis-only (reduced scope) | Not implemented yet | Measure before setting a floor | Exploratory proposal |

### Environmental issues to explain (industry consensus, [P] × 7 manufacturers)

Use diffuse frontal light; never place a window or lamp behind the person; avoid direct sunlight; use a static background without mirrors or TVs; wear fitted clothing that contrasts with the background; keep other people and pets out of the frame; avoid strong wall patterns. Do not show a permanent checklist—surface guidance after repeated failures, following commercial product practice.

---

## 7. Gaps no source resolves (and the repository already knew about)

1. **BlazePose Lite resting jitter on an ordinary webcam, in millimetres:** no published value exists. The repository already prescribed the experiment (`docs/pesquisa-robustez-gestos.md`: stand still for 10 s and measure SD/p95). This is the missing measurement needed to turn §2.2 from an order-of-magnitude estimate into a number. Tracked by issue #20.
2. **Accuracy versus real webcam lighting** (not digital simulation): no data found.
3. **USB MJPEG compression versus pose accuracy:** not measured; 720p/1080p over USB 2 imply MJPEG (442–995 Mbit/s uncompressed versus 480 theoretical) [Calc][P].
4. **Population distribution of landmark error over 2–4 s windows:** posturography measures CoP over other durations; it does not provide BlazePose Lite error for this use.
5. **Validation with a real person and camera:** none in the project so far (issue #20); all human-signal amplitudes are estimates from the literature.

## 8. One-sentence answer

> **The current code’s hypothesis is 1.8 seconds of valid signal**, with the body framed and the camera stationary. Sway literature motivates measuring exposures of several seconds, but does not validate this threshold for BlazePose Lite landmarks; validation with a real webcam is still missing. The implementation tolerates dropouts through temporal coverage and should be tuned using real measurements of error and duration.

---

### Main sources

- Physio2.2M—BlazePose accuracy versus motion capture on a C920 [I]: https://www.nature.com/articles/s41598-025-22626-7
- BlazePose paper/model card [G]: https://arxiv.org/abs/2006.10204 · https://developers.google.com/ml-kit/images/vision/pose-detection/pose_model_card.pdf
- Legacy MediaPipe Pose evaluation [G]: https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md (datasets with people at 2–4 m; does not validate this app)
- ML Kit Pose guidance [G]: developers.google.com/ml-kit/vision/pose-detection/android
- Posturography: Kenny 2019 (PMC6449971), Wiesmeier 2015 (PMC4477145), Gatev (PMC2269093), Doyle 2008 SDA, [Soames & Atha 1982](https://pubmed.ncbi.nlm.nih.gov/6981506/) (CoP spectral frequency, not landmark accuracy window)
- Multi-view webcam/Vicon [I]: PMC13766164 · stereo vs. monocular: PMC11644880
- Controlled Pose Landmarker degradation [I]: PMC13747219 · PoseBench: arxiv.org/abs/2505.23760
- Logitech C922 lux [P]: support.logi.com/hc/en-us/articles/360023345533
- Theia camera setup [P]: docs.theiamarkerless.com · OpenCap [A]: journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462
- ExerCam [A]: mdpi.com/2076-3417/11/19/9132 · Apple Vision [P]: WWDC2020/10653
- Kinect zero-calibration [P]: Zhang, Microsoft Research IEEE MM 2012
- Internal: `docs/auditoria-mediapipe.md`, `docs/pesquisa-inclinacao-tronco.md`, `docs/pesquisa-robustez-gestos.md`, `docs/autocalibracao-tolerancia-perda.md`, `docs/analise-gargalos-corrida.md`, `src/cv/calibrator.ts`, `src/cv/autoCalibrator.ts`
