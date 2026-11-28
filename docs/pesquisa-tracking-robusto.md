# Research — Robust Tracking: How Production Systems Prevent Spurious Pose Loss in Camera-Controlled Games and Fitness Apps

Date: November 26, 2026 · Branch: `main` (`4ffa382`)

Research based on **primary sources**: Microsoft’s official Kinect smoothing white paper (Microsoft Learn archive), the official Microsoft Kinect for Windows v1.7 Human Interface Guidelines (PDF), Meta Quest *First Steps* engineering blog (production hand-tracking filter), a Peloton CV VP presentation (Embedded Vision Summit), Ubisoft’s Just Dance Camera Controller engineering blog, the official BlazePose GHUM 3D model card (Google PDF embedded on Hugging Face), the BlazePose paper (arXiv 2006.10204), the DeepSORT paper (arXiv 1703.07402), the 1€ Filter paper (Casiez et al., CHI 2012), source code from `tensorflow/tfjs-models` (pose-detection/MoveNet) and `google-ai-edge/mediapipe` (C++ filters), official MediaPipe repository issues, the W3C Image Capture spec, and camera-tracking literature. Complements `docs/autocalibracao-tolerancia-perda.md` (internal `visibility`/`presence` and graph semantics), `docs/auditoria-mediapipe.md` (internal smoothing), and `docs/pesquisa-robustez-gestos.md` (jitter and detector re-arming) — this focuses on **what shipped products do between a bad frame and a gameplay decision**.

**Motivating problem:** today `TrackingGate` declares `lost` after 4 consecutive bad frames (~133 ms at 30 fps — `src/kinematics/trackingGate.ts:34`), the label becomes `NO POSE` (`src/App.tsx:131`), and `RunGate` pauses running and restarts with a 3 s countdown on recovery (`src/games/track/runGate.ts:31-33,51-54`). A burst of occlusion/motion blur lasting ~130 ms — invisible to the player — costs a pause + 3 s countdown. The question: what does industry do in this interval?

---

## 1. Executive summary

1. **No reference product reacts to tracking loss after ~130 ms.** Concrete production figures converge on a grace window of **hundreds of milliseconds to 1 second**: Meta First Steps drops an object only after 75 ms of continuous low confidence + 15 ms of stabilization after recovery; DeepSORT (a reference tracker in the literature) deletes a track only after `max_age = 30` frames without a match (~1 s at 30 fps) and requires 3 consecutive detections to create a track; Google’s own tf.js pose-detection tracker uses `maxAge: 1000` ms; a published MediaPipe-to-VRM retargeting implementation waits 0.5 s before returning the avatar to neutral. Kinect HIG explicitly says the primary user should **not** be disengaged immediately.
2. **The dropout pattern is not “pause”: it is coast with damping + return interpolation.** Meta First Steps’ documented algorithm (flagship VR onboarding product) extrapolates position using velocity/angular velocity from the last high-quality sample, applies frame-by-frame damping on bad frames to slow the motion to a stop, and on recovery interpolates from the extrapolated position to the real one over **~100 ms** (10 frames), always targeting the newest sample — there is never a snap or pause. Peloton handles occlusion/lighting/framing through **UI nudging without adding friction** (“ML and UI work together … without introducing friction”).
3. **Lite is probably a false economy for this game.** In Google’s official evaluation on Yoga/Dance/HIIT (datasets closest to our use), Full beats Lite by **+5.3/+3.8/+2.2 PCK@0.2 points**, for only **+5 ms/frame on a 2018 Pixel 3 GPU (25 vs 20 ms)** and +2 ms on a 2017 MacBook Pro (27 vs 25 ms). The GHUM 3D model card shows a 87.0% → 91.8% PDJ difference (+4.8). Heavy costs twice as much as Full (53 ms) for another 2–3 points — that likely does not pay off. Lite is worse precisely at skin-tone/region extremes (ranges 6.5–7.3 versus 4.8–5.7 for Heavy).
4. **The gate using `min(visibility)` across central points is stricter than any published practice.** BlazePose’s author recommends a **0.5** post-sigmoid threshold per point; application literature uses 0.5–0.7 **per landmark involved in the calculation**, never “the minimum of a set invalidates the whole body.” The systematic guidance (Microsoft, Google, Meta) is: bad point → hold the last good value / skip the derived signal for that frame — do not zero out the game.
5. **Fast motion is a known and still-open Pose Landmarker failure mode** (issue #6239: landmarks “carried away”/detached during explosive movements, worse at low FPS, no maintainer fix). A 60 fps camera reduces inter-frame displacement and limits maximum exposure time (1/60 s), reducing motion blur — the existing `frameRate: {ideal: 60}` constraint is the right direction and has evidence supporting it.
6. **Two distinct error sources require two distinct treatments** (Kinect white paper, Section 2): small constant white noise → smoothing filter; temporary spikes during inference/occlusion → spike/outlier filter + more aggressive adaptive smoothing *only when the point is inferred*. One filter does not solve both.

---

## 2. What production exergames and fitness apps do during occlusion/out-of-frame conditions

### 2.1 Meta First Steps (VR, hand tracking — the best documented case)

The Meta Quest team documented the complete mitigation algorithm used in *First Steps*, its flagship onboarding app, because “hand position/orientation accuracy degraded rapidly in certain conditions (poor lighting, hand-over-hand occlusion) and was extremely damaging to gameplay” — [developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps](https://developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps/):

**Five-step pipeline per frame:**

1. **Stillness freezing** — if the data has not perceptibly changed since the previous frame, keep the previous transform (removes micro-jitter at no cost).
2. **Jitter smoothing** — if the new data is close to the previous data, interpolate toward it by a small percentage (lag only on small, imperceptible movements).
3. **Quality classification** — invalid → low quality; high confidence → high quality; otherwise apply heuristics.
4. **Extrapolation (coast)** — they do *not* interpolate toward low-quality data (“this turned out to be even more frustrating than incorrect data”). Instead, **integrate velocity and angular velocity from the last high-quality sample**, and apply a **damping scalar** to velocity on every low-quality frame, so hands slow to a stop if the burst persists.
5. **Return interpolation** — when high-quality data returns, interpolate from extrapolated to real position over **“a tenth of a second”** (~100 ms); this does not increase perceived latency because every frame interpolates toward the newest data (which moves with the hand).

**Gameplay rules for tracking state:**

- “Hands don't drop objects when off camera” — design rule: a held object is **never** released due to tracking loss.
- An intentional drop is triggered only when confidence is “high” **and** pinching has stopped for **75 continuous ms**; after tracking recovers, wait **15 ms** before checking for drop; grab and drop thresholds are **different** (hysteresis).
- Throwing with mid-throw tracking loss: build the launch vector from (a) velocity from the buffer 40 ms earlier if continuous data exists in the last 80 ms; (b) otherwise, the all-confidence buffer if velocity >50 cm/s in the forward direction; (c) otherwise, the 60% vector from loss point→current position combined with 40% gaze direction, magnitude ×0.4.
- Keep a **1 s buffer** of transforms/velocities to reconstruct events.
- Explicit design lesson: “design your interactions in a way that ensures players keep their hands out in front of them, at a height and length that is tracked well”.

Other Meta artifacts follow the same pattern: official Unreal sample `UHandTrackingFilterComponent` “detects when hand tracking is lost and **holds the last known hand position with decay**, preventing sudden jumps when tracking resumes” ([developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay](https://developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay/)); Wide Motion Mode (Quest 3+) “display[s] plausible hand poses even when the hands are outside the headset's field of view” using body tracking as fallback, with a warning about a small accuracy regression during transition back ([developers.meta.com/vr/documentation/unity/unity-wide-motion-mode](https://developers.meta.com/vr/documentation/unity/unity-wide-motion-mode/)); Hand Tracking 2.1 focused on “reduce tracking loss and predict future positions better… Recovery times have also been greatly reduced after incurring a loss when hands fall outside the FOV” ([developers.meta.com/vr/blog/hand-tracking-improvements-v2-1](https://developers.meta.com/vr/blog/hand-tracking-improvements-v2-1/)).

### 2.2 Peloton Guide (fitness with a TV camera)

From Peloton’s AI/CV VP presentation at the Embedded Vision Summit — [official PDF](https://www.edge-ai-vision.com/wp-content/uploads/2023/10/T1T06_Nichani_Peloton_2023.pdf):

- Slide “Robustness Driven through UI and Nudging”: edge cases — **brightness, occlusion, camera tilt/distance, multiple people** — are handled by **UI nudging**; “Orientation nudging occurs in all time-based and rep tracking workouts **to minimize inaccuracies due to occlusion**” (guide the user to face sideways/forward depending on exercise).
- Explicit philosophy: “ML and UI work together to ensure that member has a **robust experience without introducing friction**”.
- Fairness metrics are split by body type/skin tone/gender with true positive rate by exercise (e.g. Squat 99.7–100%, Dumbbell Swing 96–100%) — the model is evaluated by slice, not only by average.
- Movement Tracker is tolerant by design: the “sweat drop” fills if you move about 75% of the interval, and any movement counts — independent review: [connectthewatts.com/2022/04/11/peloton-guide-review](https://connectthewatts.com/2022/04/11/peloton-guide-review/).
- User manual setup: stay **within ~2 m** of the camera, camera height 0.9–1.8 m, avoid direct light/windows behind you, mirrors/TVs/background movement, and clothing that blends into the background — [official manual](https://m.media-amazon.com/images/I/C1e-PuDXIXL.pdf).

### 2.3 Just Dance Camera Controller (Ubisoft, 2023 beta → official 2026)

- Uses an existing deep-learning model to estimate the player as a **3D skeleton**, compares it with the coach’s moves, and produces a score using its own ML comparison algorithm (distances, angles, orientations, movements) — [Ubisoft developer blog, October 2025](https://www.ubisoft.com/en-us/game/just-dance/2026/news-updates/2UBGhF4xWMLAVVFMmTCWwn/revolutionising-motion-gaming-the-camera-controller-feature).
- 1.5 years of full-time R&D; they trained a dedicated model using their “own dance motion database with help from volunteers within the Just Dance production team”; rules were adjusted by watching streams and getting feedback from top players — [Xbox Wire, October 2025](https://news.xbox.com/en-us/2025/10/14/just-dance-2026-camera-controller/).
- **There is no public documentation of frame-by-frame dropout/occlusion handling** — declared gap. Relevant architectural fact: score is an **aggregate over the choreography** (not a per-frame boolean gate), and the game never pauses the music for tracking — the choreography continues; bad frames cost score, not interruption.

### 2.4 Kinect (historical reference for AAA motion games)

**Joint states:** Kinect for Windows emits per-joint `Tracked`/`Inferred`/`NotTracked` — “A tracked joint that cannot be seen by the camera is inferred. That is, the joint position is calculated from surrounding joint data rather than captured by the camera” ([TrackingState enumeration, Kinect v2](https://raw.githubusercontent.com/Kinect/Docs/553f7c37ca8327003dc7b1990a0dcc6bc9118d5c/Kinect4Windows2.0/k4w2/Reference/Kinect_for_Windows_v2/Kinect/TrackingState_Enumeration.md)). Azure Kinect follows the same contract with 4 levels and emits an occluded joint as a “predicted joint pose” with `CONFIDENCE_LOW` ([official reference](https://microsoft.github.io/Azure-Kinect-Body-Tracking/release/1.x.x/group__btstructures_ga8582ddc16801cb72d4d3691bcfc3cddb.html); already covered in `docs/autocalibracao-tolerancia-perda.md`).

**Official UX guidance (Human Interface Guidelines v1.7, 135-page Microsoft PDF):** [download](http://download.microsoft.com/download/B/0/7/B070724E-52B4-4B1A-BD1B-05CC28D07899/Human_Interface_Guidelines_v1.7.0.pdf)

- pp. 94–95 (engagement handoff): “The primary user drops his or her hand but **does not completely disengage** and other users cannot immediately take over control” — engagement hysteresis is a behavior they recommend *over the default*; a challenger must complete a “speed-bump action” (press a button) to take over.
- pp. 88–89 (User Viewer): showing a silhouette/feedback of what the sensor sees “reduces any feeling that the application or Kinect for Windows is buggy, unresponsive, or unexplainably jumpy” — tracking-state transparency is part of the UX solution.
- p. 63: “You can also prompt people to move into the appropriate field of view whenever they're **cropped, too close, or too far back**” — nudge, do not pause.
- p. 43: tracking is more stable facing the sensor; hands at the sides are more trackable than in front of the body; maximum 30 fps — “For very fast gestures, consider skeleton tracking speed and frames-per-second limitations”.

**Published game example (theatre/mocap):** in *Experimenting with Shakespeare* (Kinect), “If a player's tracking is lost (typically due to leaving the space or occlusion from another player), their avatar disappears, and the sync line returns to help them repossess their character” — degrades to guided reacquisition, not fatal error ([shakesperiment.tome.press, Act IV](https://shakesperiment.tome.press/chapter/act-iv-if-looking-liking-move-motion-capture-and-the-optics-of-collaboration/)).

### 2.5 Other examples

- **Kemtai** (physiotherapy/fitness, validated against Vicon): marketing claims “Advanced Occlusion Handling — maintains tracking in challenging conditions or when body parts are partially obscured” and stability “even with varied lighting, clothing, background, and body type” — and explicitly says it **does not** use open-source models: “Open source models are a fast way to a demo and a dead end after that” ([kemtai.com/our-computer-vision](https://kemtai.com/our-computer-vision/), [LinkedIn Kemtai Vision](https://www.linkedin.com/posts/kemtai_seven-years-five-generations-three-model-activity-7517834458155356160-Q6yH)). Evidence that temporal robustness is treated as a proprietary differentiator — it does not come for free with the base model.
- **Magic Leap 2** (SLAM, not pose, but a UX pattern): “The Magic Leap 2 lets developers manage their own tracking loss behavior – some developers may want to pause the update loop and display a splash image, while others may want the app to continue playing” — the platform delegates the choice; pausing is an option, not the default ([forum.magicleap.cloud](https://forum.magicleap.cloud/t/fallback-to-imu-only-tracking-in-low-light-conditions/5780)).

**Convergent pattern:** no reference product pauses or interrupts on the first burst. The spectrum is: coast/extrapolate with damping (Meta) → aggregate into score without direct penalty (Just Dance, Peloton) → UI nudging to fix the cause (Peloton, Kinect HIG) → pause only as a configurable last resort (Magic Leap).

---

## 3. MediaPipe Pose Landmarker — what primary sources say

### 3.1 `visibility`/`presence` — meanings and thresholds

- **BlazePose GHUM 3D model-card definition** (official Google PDF, April 16, 2021, embedded at [huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite)): “VISIBILITY denotes the probability that a keypoint is located within the frame **and not occluded** either by other body parts or other objects. PRESENCE denotes the probability that a keypoint is located within the frame. It does not indicate whether the keypoint is occluded.” Both are emitted as logits and become probabilities after sigmoid (our graph already applies sigmoid internally — see `docs/autocalibracao-tolerancia-perda.md` Section 2.1).
- **Threshold recommended by the model author:** Valentin Bazarevsky (first author of BlazePose) in issue #1351: “So reasonable threshold will be **0.5** if you apply the sigmoid or 0.0 if you want to skip this step” — [github.com/google/mediapipe/issues/1351](https://github.com/google/mediapipe/issues/1351). Application practice: 0.5–0.7 per landmark **used in the calculation**, and skip/hold the frame when the required point is below threshold — never invalidate the whole pose based on the minimum of a large set ([sitepoint.com/your-pose-model-gives-you-coordinates-not-meaning](https://www.sitepoint.com/your-pose-model-gives-you-coordinates-not-meaning/), [aifitnessapi.com/guides/improve-pose-detection-accuracy](https://aifitnessapi.com/guides/improve-pose-detection-accuracy)).
- **Correct semantics change gate design:** high `presence` + low `visibility` = point **in frame but occluded** — a case where the predicted position may still be useful for coasting. Low `presence` = point outside image — position is pure extrapolation. Today the gate uses `min(vis, presence)` indistinguishably (`src/kinematics/math.ts`).
- **Empirical caveat:** in issue #5159, visibility scores for clearly visible joints were 0 in a **tennis** application (legacy API, custom thresholds; closed without a resolution — maintainer only advised migrating to Tasks API) — [github.com/google-ai-edge/mediapipe/issues/5159](https://github.com/google-ai-edge/mediapipe/issues/5159). Weak evidence, but directly in our domain: in dynamic tennis scenes, scores may be too conservative for a hard gate.

### 3.2 Internal temporal stability — what the model does and does not do

- **Detector→tracker pipeline with ROI loop** (not detection on every frame): “The tracker predicts keypoint coordinates, the presence of the person on the current frame, and the refined region of interest for the current frame. **When the tracker indicates that there is no human present, we re-run the detector network on the next frame**” — [BlazePose paper Section 2.1, arXiv 2006.10204](https://arxiv.org/abs/2006.10204). There is real internal tracking, but **no presence coasting/hysteresis** — one frame with presence below threshold blocks output and triggers full-frame redetection on the next frame (graph details in `docs/autocalibracao-tolerancia-perda.md` Section 2.2).
- **Design assumption: head always visible.** “We make the strong, yet for AR applications valid, assumption that the head of the person should always be visible for our single-person use case” (paper Section 2.2); detector uses face detection as proxy and predicts hip/scale/rotation from the head. Model card lists “Head is not visible” as **out of scope**. Direct implication: a player ducking/leaving the top of the frame breaks the entire detection, not just head points.
- **Occlusion is covered in training** — Section 2.6: random-rectangle occlusion augmentation + per-point visibility classifier, “This allows tracking a person constantly even for cases of significant occlusions, like upper body-only or when the majority of person body is out of scene.” The model **predicts** occluded points and marks them — consumers must use the scores (an Azure-Kinect-like contract, not a missing-data contract).
- **Tracker alignment tolerance:** augmentations of 10% shift/scale and 8° roll; ideal crop has a 25% margin around the body (model card, “Training Factors”). Corollary: if the body shifts by more than ~10% of its own size between frames, the tracker ROI is outside its training regime — failure at low FPS/fast motion is structural, not a bug.
- **Internal smoothing is active in our configuration** (VIDEO + `numPoses=1`): One Euro `min_cutoff=0.05, beta=80` on image landmarks and `0.1/40` on world landmarks + EMA α=0.1 only on `visibility` (sources/numbers already audited in `docs/auditoria-mediapipe.md` #1 and `docs/autocalibracao-tolerancia-perda.md` Section 2.1). Confirmed by maintainer in issue #4507: smoothing is automatically on in VIDEO/LIVE_STREAM with `numPoses=1` starting in 1.2.3 — [github.com/google-ai-edge/mediapipe/issues/4507](https://github.com/google-ai-edge/mediapipe/issues/4507).
- **Timestamps affect filtering:** internal 1€ recalculates frequency from actual Δt between packets (`one_euro_filter.cc`: `frequency_ = 1.0 / (Δt)` — [code](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/util/filtering/one_euro_filter.cc)); maintainer advises using “the time of the video frame (rather than the current time)” — [issue #4715](https://github.com/google-ai-edge/mediapipe/issues/4715). Different frame rates produce different filtering — reported in [issue #2497](https://github.com/google-ai-edge/mediapipe/issues/2497).

### 3.3 Known failure modes

| Failure | Primary evidence |
|---|---|
| **Explosive movement / low FPS:** temporally detached landmarks, “carried away” — squat: feet/hip sink as if the model predicted a fall; worse at low FPS. Issue **open, no fix** (#6239, Feb–Mar 2026, maintainer confirmed and requested reproduction) | [github.com/google-ai-edge/mediapipe/issues/6239](https://github.com/google-ai-edge/mediapipe/issues/6239) |
| **Poor light/noise/motion increases jitter:** “When degrading the environment light, noise, motion or face overlapping conditions one can expect degradation of quality and increase of 'jittering'” | BlazePose GHUM 3D Model Card, Limitations/Environment ([PDF](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite/resolve/main/Model%20Card%20BlazePose%20GHUM%203D.pdf)) |
| **Head out of frame / >4 m / multiple people:** explicitly out of scope | Model card, “Out-of-scope applications” |
| **Partial body without torso/head is not detected at all:** “A person cropped by the frame with no torso or head in view is not found at any setting, because the detector that feeds the landmarker anchors on a torso” | [react-native-pose-detection docs](https://github.com/khalid999devs/react-native-pose-detection/blob/main/guides/reference/pose-camera.md) (measured against `pose_landmarker_full`) |
| **Recommended distance 2–4 m** for good quality | Official response by sgowroji in [issue #2940](https://github.com/google-ai-edge/mediapipe/issues/2940) and mediapipe.readthedocs.io pose (“single person located 2-4 meters from the camera”) |
| **ROI outside crop:** the model tolerates a body partly outside the scene *once tracked* (upper-body-only works — paper Section 2.6/Fig. 5), but initial **redetection** requires torso/head — important asymmetry: losing tracking is much worse than never having it |

### 3.4 Lite vs Full vs Heavy — official figures

**Accuracy** (PCK@0.2; torso-normalized 2D):

| Dataset/evaluation | Lite | Full | Heavy | Source |
|---|---:|---:|---:|---|
| Yoga | 90.2 | 95.5 | 96.4 | [mediapipe.readthedocs.io/en/latest/solutions/pose.html](https://mediapipe.readthedocs.io/en/latest/solutions/pose.html), “Pose Estimation Quality” |
| Dance | 92.5 | 96.3 | 97.2 | same |
| HIIT | 93.5 | 95.7 | 97.5 | same |
| Mean geographic PDJ (14 regions, model card) | 87.0 ± 2.0 | 91.8 ± 1.4 | 94.2 ± 1.3 | Model card PDF p. 6 |
| Geographic fairness range | 6.5 | 4.8 | 4.8 | same |
| Skin-tone range | 7.3 | 7.0 | 5.7 | same, p. 7 |
| Original paper (AR/Yoga, older 2D models) | 79.6 / 77.6 | 84.1 / 84.5 | — | [arXiv 2006.10204, Table 1](https://arxiv.org/abs/2006.10204) |

**Official latency:**

| Platform | Lite | Full | Heavy | Source |
|---|---:|---:|---:|---|
| Pixel 3 TFLite GPU | 20 ms | 25 ms | 53 ms | mediapipe.readthedocs.io pose, latency table |
| MacBook Pro 15" 2017 | 25 ms | 27 ms | 38 ms | same |
| Pixel 3 XNNPACK CPU | ~44 fps (≈23 ms) | ~18 fps (≈56 ms) | ~4 fps (≈250 ms) | Model card PDF p. 1 |
| Pixel 3 TFLite GPU (fps) | ~49 fps | ~40 fps | ~19 fps | same |

**Gameplay reading:** on the GPU delegate (our nominal case), Full costs +5 ms/frame over Lite (+25%) and gives +3.8 to +5.3 PCK points on datasets closest to running/dance/HIIT — fairness/robustness gaps also improve. Since 20→25 ms still fits 30–40 fps pipeline rates and our round trip is already below 33 ms on healthy GPU hardware (`docs/pesquisa-pipeline-cv.md` Section 1), **Lite is very likely a false economy**: the quality difference should translate directly into fewer low-confidence frames (less spurious `lost`), while latency cost is small. Heavy (+28 ms over Full) would allow only 15–20 fps inference — a poor trade-off for a ~250 ms swing. On CPU fallback, Lite is the only viable model (44 vs 18 fps) — an argument for **delegate-adaptive model choice**.

---

## 4. Temporal coherence — techniques with production evidence

### 4.1 One Euro filter — correct tuning

- Original paper: [Casiez, Roussel & Vogel, CHI 2012](https://gery.casiez.net/publications/CHI2012-casiez.pdf); official tuning guidance at [gery.casiez.net/1euro](https://gery.casiez.net/1euro/): beta=0, fcmin≈1 Hz; hold still and **lower fcmin** until jitter stops; move quickly and **raise beta** until lag is acceptable; beta depends on units — start at 0.001/0.0001 and vary by factors of 10. Implemented in Google Chrome (chrome://credits), “used in Chrome on all Android devices,” Unreal Engine, Meta Horizon SDK, and Vicon Tracker — the de facto interaction-industry standard.
- MediaPipe implements it with frequency **recomputed from actual timestamp Δt** and normalization by object scale (bbox); derivative has a fixed 1 Hz cutoff — [one_euro_filter.cc](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/util/filtering/one_euro_filter.cc), [landmarks_smoothing_calculator_utils.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/calculators/util/landmarks_smoothing_calculator_utils.cc).
- Since our input already has an aggressive internal 1€ filter (α≈0.01–0.02 at rest — `docs/auditoria-mediapipe.md` #1), the app’s second layer probably should be **lighter or removed** where it only smooths (already noted in `docs/pesquisa-robustez-gestos.md` Section 3).
- tf.js pose-detection variant: in addition to standard 1€, the final low-pass has a **nonlinear saturation threshold**: `result = stored + alpha·threshold·asinh((value − stored)/threshold)` — behaves linearly near zero; large displacements grow only logarithmically. This is an **outlier cap built into the filter** (spike suppression), with `thresholdCutOff = 0.5` + speed-adaptive `thresholdBeta·|edValue|` — [low_pass_filter.js](https://unpkg.com/@tensorflow-models/pose-detection@latest/dist/shared/filters/low_pass_filter.js), [one_euro_filter.js](https://unpkg.com/@tensorflow-models/pose-detection@latest/dist/shared/filters/one_euro_filter.js). MoveNet config: `frequency 30, minCutOff 2.5, beta 300, derivateCutOff 2.5` — [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts).
- MediaPipe also has `RelativeVelocityFilter` (recent velocity window; “higher window_size adds to lag and to stability; lower velocity_scale adds to lag and to stability”) as an alternative to 1€ in some solutions — [relative_velocity_filter.h](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/util/filtering/relative_velocity_filter.h).

### 4.2 Kinect — Holt double exponential smoothing + jitter radius + clamp (AAA production)

From the official white paper “Skeletal Joint Smoothing” (Mehran Azimi, Microsoft ATG) — [learn.microsoft.com/.../jj131429](https://learn.microsoft.com/en-us/previous-versions/windows/kinect-1.8/jj131429(v=ieb.10)):

- **Two noise types, two treatments:** “the relatively small white noise that is always present… the other is temporary spikes caused by inaccuracy, which happen when the joint has an inferred tracking state. Since these noises have different characteristics, different filtering techniques should be used for each… developers need to use a combination of two or three filtering techniques.”
- **Adaptive smoothing by tracking state:** “apply a more aggressive smoothing filter when a joint's state is inferred… adaptively update the filter parameters based on the joint's tracking state. Also, filters that are specifically more powerful in removing spike noise should be applied when a joint's state is inferred.”
- **Built-in filter parameters** (Holt double exponential + jitter removal + overshoot control): Smoothing/Correction ∈ [0,1]; Prediction = frames ahead; JitterRadius (m) clamps jitter; MaxDeviationRadius (m) clamps how far the filtered result can stray from raw. Official presets ([joint filtering docs](https://learn.microsoft.com/en-us/previous-versions/windows/kinect-1.8/jj131024(v=ieb.10))): **default for gesture recognition in games** `{0.5; 0.5; 0.5; 0.05 m; 0.04 m}`; menus `{0.5; 0.1; 0.5; 0.1; 0.1}`; very smooth/high latency `{0.7; 0.3; 1.0; 1.0; 1.0}`.
- **Latency:** “User research shows that **72% of people start noticing this delay when latency is more than 100 msec**, and therefore it is suggested that developers aim for an overall latency of 100 msec.” Forecasting ~2 frames may reduce ~66 ms latency under ideal conditions, but increases overshoot — constrain with kinematics (bone lengths, hinge-joint limits).
- **Operational rules:** use real timestamps and **interpolate missing points** when frames drop; “**reset the filter when a skeleton is lost**”; filter per joint and per use (fast hand ≠ spine; avatar ≠ gesture scoring).

### 4.3 Kalman — comparative evidence for game control

- Edwards & Green (IVCNZ 2014) compared 4 filters for Kinect video-game control: SDK Holt, moving average, constant-value Kalman, and **WPA (Wiener Process Acceleration) Kalman**. Result: moving average/constant-velocity Kalman smooth well but add high latency; “The WPA Kalman filter was found to have the best overall performance” — [doi 10.1145/2683405.2683453](https://doi.org/10.1145/2683405.2683453) (abstract; full text paywalled).
- DeepSORT: 8-D state with a **constant-velocity model** and track handling: `a_k` counts unmatched frames; a track is deleted only when `a_k > A_max` (**`max_age = 30` frames in experiments**); new tracks are *tentative* and confirm only after **3 consecutive associated frames** — [arXiv 1703.07402 Section 2.1](https://arxiv.org/abs/1703.07402); reference implementation `n_init=3, max_age=30` — [nwojke/deep_sort](https://deepwiki.com/nwojke/deep_sort/2.1-tracker-implementation). This is the classic formulation of **temporal existence hysteresis**: confirm quickly enough not to miss real objects (3 frames), disappear slowly enough to survive occlusion (30 frames).
- Google’s tf.js pose-detection tracker uses the same idea in production: `maxAge: 1000` (ms), `minSimilarity 0.2`, keypoint confidence threshold 0.3, minimum 4 keypoints to associate — [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts) (`DEFAULT_KEYPOINT_TRACKER_CONFIG`).

### 4.4 Multi-frame voting / state hysteresis — converging evidence

| Source | Enter (confirm) | Exit (give up) | Grace window |
|---|---|---|---|
| DeepSORT | 3 consecutive frames | 30 unmatched frames (~1 s at 30 fps) | ~1 s |
| tf.js pose tracker | — | `maxAge` 1000 ms | 1 s |
| Meta First Steps (object drop) | high confidence | 75 ms continuous low confidence + 15 ms stabilization after return | ~90 ms |
| ML Kit pose classification | EMA α=0.2, window 10 | reset only on **stream stall >100 ms**, not one bad frame | ~100 ms+ |
| Kinect engagement (HIG) | deliberate speed-bump action | does not disengage when hand drops | indefinite (until challenger acts) |
| VRM retarget (MediaPipe Holistic, dev.to) | — | pose missing for **>0.5 s** before returning to neutral | 0.5 s |
| Our app today | 3 good frames | **4 bad frames (~133 ms)** | ~133 ms |

Sources: DeepSORT/tf.js/Meta/ML Kit as in Sections 4.3 and 2.1; ML Kit EMA: [EMASmoothing.java](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java) (`RESET_THRESHOLD_MS = 100`); VRM: [dev.to/kiarina](https://dev.to/kiarina/real-time-webcam-to-vrm-retargeting-with-mediapipe-holistic-173-fps-on-m1-max-4be3); Kinect HIG pp. 94–95.

Note: Meta/ML Kit’s 75–100 ms is for **reacting to a gesture/action** within a continuous stream; DeepSORT/tf.js/VRM’s 0.5–1 s is for **declaring identity/presence loss**. Our `lost` serves both roles at once — and the “player presence” role has the wrong constant (133 ms). Separate fast gesture reaction (short) from giving up on presence (long).

### 4.5 Coasting/extrapolation — the concrete pattern

Synthesis of the sources (Meta Section 2.1 + DeepSORT Section 4.3 + Kinect Section 4.2):

1. Keep a kinematic state (position + velocity, ideally per landmark or derived channel) from the last **good** frames.
2. During bad frames: integrate velocity with **per-frame damping** (Meta) or a pure constant-velocity model (DeepSORT) — for gameplay, damping is essential because human motion is not ballistic beyond a few hundred milliseconds.
3. **Never interpolate toward bad data** — occluded/inferred data is biased (Kinect white paper: temporary spikes that “go away as the joint tracking state goes back to TRACKED”).
4. On recovery: short (~100 ms) blend from extrapolated to measured, always targeting the newest measurement.
5. Coast timeout: after ~0.5–1 s without good data, freeze/neutralize — only then consider degrading gameplay.

---

## 5. Camera-frame quality — what actually matters

1. **Exposure/motion blur is the dominant physical lever for fast movement.** PeTrack (pedestrian-tracking software documentation for research): 24–30 fps is enough for walking (≤7 cm/frame), “**For running people, increasing the frame rate can improve tracking**”; exposure of **1/150 s is enough for walking pedestrians and 1/500 s for running** — [petrack.readthedocs.io/planning/camera](https://petrack.readthedocs.io/en/latest/planning/camera.html). Handa’s Imperial College thesis: higher frame rate implies a lower maximum shutter time → **less motion blur, but more noise** — lighting-dependent trade-off — [doc.ic.ac.uk/~ajd/Publications/handa_phd2013.pdf](http://www.doc.ic.ac.uk/%7Eajd/Publications/handa_phd2013.pdf). TOG “The need 4 speed”: 30 fps sensors “allow for large inter-frame motions to occur that make such tracking problematic… longer exposure times produce artifacts due to motion blur” — [doi 10.1145/3272127.3275062](https://dl.acm.org/doi/10.1145/3272127.3275062).
2. **Implication for getUserMedia:** at 60 fps, the camera physically cannot expose longer than 1/60 s per frame — even if we process only every other frame, blur from a fast swing is halved versus 30 fps. The `frameRate: {ideal: 60}` constraint (`src/App.tsx:148`) is correct; `ideal` (not `exact`) negotiates down on 30 fps cameras without failing — as required by the mediacapture spec ([w3c.github.io/mediacapture-main](https://w3c.github.io/mediacapture-main/)).
3. **Fine exposure control exists, but only in Chromium:** Image Capture extension exposes `exposureMode`/`exposureTime` as track constraints; implementations: Windows since Chrome 60/76, Linux/ChromeOS yes, macOS since 111, Android 72 — **absent in Firefox/Safari** — [w3c/mediacapture-image implementation-status.md](https://github.com/w3c/mediacapture-image/blob/main/implementation-status.md), [spec](https://www.w3.org/TR/image-capture/). So exposure can be capped via `applyConstraints` on desktop Chrome (gracefully degrade where unsupported), but forcing a short exposure in a dark room makes the image darker and increases gain noise — an experiment, not a default.
4. **Resolution above ~640p has little value to the model:** the graph resizes to network input regardless — “the first thing mediapipe graph does is to downsize the image into whatever the model expects (regardless of input image size)” (mcclanahoochie, [issue #238](https://github.com/google/mediapipe/issues/238)); the landmarker runs on the ROI’s 256² crop. Independent measurement (real webcam, CPU): requesting 1280×720 dropped the pipeline to 16.5–21.6 fps versus 29.9 fps at 640×480 — ordinary cameras may ignore the request or cost more bandwidth/decode — [diyor-ai/gesture-control-system README](https://github.com/diyor-ai/gesture-control-system). More resolution helps only if the body occupies few pixels (player far away) — the right fix is framing UX (2–4 m, body 70–90% of frame height), not more pixels.
5. **Frontal/even lighting and clothing contrast** are prescribed by all vendors (Peloton manual, Section 2.2; Meta: “bright, even lighting… same amount of light as you would have in the living room when you have guests over” — [meta.com/help/quest](https://www.meta.com/help/quest/598701621088668/)). With a monitor-top webcam, room lighting is often behind or to the side — setup nudging is part of the system, not optional.

---

## 6. Graceful gameplay degradation — what shipped products do

Product synthesis (sources in Sections 2 and 4):

| Situation | Observed production behavior |
|---|---|
| Short burst (<~300 ms) | **Invisible to the player**: coast/extrapolation with damping (Meta), filter absorbs it (Kinect smoothing), aggregate score barely notices (Just Dance/Peloton). No UI. |
| Medium loss (~0.3–1 s) | Avatar/object **freezes or slows** at last good pose; derived input drops smoothly to zero, not as a step; held object **is not released** (Meta); no pause. |
| Long loss (>1–2 s) | Warning/transparency UI: User Viewer/silhouette (Kinect HIG), reacquisition sync line (Shakespeare), “step back/adjust lighting” nudge (Peloton); app *continues* — full pause is developer opt-in (Magic Leap). |
| Recovery | ~100 ms blend without snap (Meta); **no countdown/position restart** in any source; re-engagement is immediate when the user was already primary (Kinect handoff). |
| Persistent root cause | Setup nudging (distance, lighting, tilt) — fix the cause, not the symptom (Peloton, Kinect HIG p. 63). |

The current app’s anti-pattern — pause the run and restart with a 3 s countdown (`runGate.ts:51-54`) — has no counterpart in any primary source found; it is more punitive than any reference, including 2010–2013 Kinect.

---

## 7. Open-source implementations and artifacts worth studying

| Resource | What to extract | URL |
|---|---|---|
| Meta First Steps blog | Complete five-step algorithm (stillness-freeze → jitter-smooth → quality-gate → extrapolate+damping → ~100 ms blend-back) + drop/grab hysteresis rules | [developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps](https://developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps/) |
| Kinect Skeletal Joint Smoothing White Paper | Two-noise theory, adaptive smoothing by tracking state, parameter presets, reset-on-loss, 100 ms rule | [learn.microsoft.com/.../jj131429](https://learn.microsoft.com/en-us/previous-versions/windows/kinect-1.8/jj131429(v=ieb.10)) |
| Kinect Human Interface Guidelines v1.7 (135 pp.) | Engagement hysteresis, User Viewer/transparency, framing nudges | [Microsoft PDF](http://download.microsoft.com/download/B/0/7/B070724E-52B4-4B1A-BD1B-05CC28D07899/Human_Interface_Guidelines_v1.7.0.pdf) |
| tfjs-models pose-detection | 1€ with asinh anti-spike saturation; smoothed ROI crop α=0.9; reset→full-frame redetect when `pose.score <0.25`; tracker `maxAge 1000 ms` | [detector.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/detector.ts), [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts), [low_pass_filter.js](https://unpkg.com/@tensorflow-models/pose-detection@latest/dist/shared/filters/low_pass_filter.js) |
| DeepSORT | `max_age/n_init` — reference for existence hysteresis in tracking | [arXiv 1703.07402](https://arxiv.org/abs/1703.07402), [nwojke/deep_sort](https://github.com/nwojke/deep_sort) |
| ML Kit pose-classification sample | EMA α=0.2/window 10 + reset only on stall >100 ms; double-threshold hysteresis for rep counting | [EMASmoothing.java](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java), [pose_classification.md](https://github.com/google-ai-edge/mediapipe/blob/3eb8983cde1517fdff4abbfb33586316af6d45be/docs/solutions/pose_classification.md) |
| MediaPipe filtering utils | Reference C++ OneEuro/RelativeVelocity/LowPass implementations | [mediapipe/util/filtering](https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/util/filtering) |
| Unreal hand gameplay sample (Meta) | `UHandTrackingFilterComponent`: hold last known position with decay | [developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay](https://developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay/) |
| react-native-pose-detection | Documented product choices: auto-smoothing off for 1 pose, filter reset when frames stop for >2.5 intervals, minConfidence 0.6 for single pose | [guides/reference/pose-camera.md](https://github.com/khalid999devs/react-native-pose-detection/blob/main/guides/reference/pose-camera.md) |
| MediaPipe issues #6239/#4507/#2497/#4715 | Fast-motion decoupling (open), confirmation of internal smoothing, timestamp dependence | [#6239](https://github.com/google-ai-edge/mediapipe/issues/6239), [#4507](https://github.com/google-ai-edge/mediapipe/issues/4507), [#2497](https://github.com/google-ai-edge/mediapipe/issues/2497), [#4715](https://github.com/google-ai-edge/mediapipe/issues/4715) |
| diyor-ai/gesture-control-system | Real-webcam measurement: 640×480→29.9 fps versus 720p→16.5–21.6 fps | [github.com/diyor-ai/gesture-control-system](https://github.com/diyor-ai/gesture-control-system) |
| 1€ filter site | Two-step tuning procedure + verified implementations | [gery.casiez.net/1euro](https://gery.casiez.net/1euro/) |

## 8. Declared gaps

- **No public figure** for how Just Dance Camera Controller handles frame-by-frame dropout (proprietary algorithm; only general architecture is public).
- I found no public Xbox/AAA certification requirement for tracking-loss behavior — evidence of “AAA standard” comes from official Kinect guidelines and documented cases, not TCRs.
- Lite/Full comparison is static per-frame PCK; **there is no published temporal dropout benchmark** (empty frames/minute in video) by model variant — the hypothesis “Full reduces spurious lost” must be measured in our harness (`scripts/pose-bench.html` + fixture replay).
- The ideal `minPosePresenceConfidence` threshold (default 0.5) for reducing empty frames without admitting ghosts is not documented in any source — lowering it is a local experiment.

---

## 9. Practical recommendations

Ordered by expected impact/effort. “Impact” = reduction in spurious `lost` or UX cost per burst. Every change to temporal behavior should have a deterministic fixture test (repository policy).

### Tier 1 — low cost, high impact (do first)

1. **Separate “react to gesture” from “give up on presence” in the gate.** Keep current confirmation (3 good frames ≈90 ms), but increase exit to `lost` from 4 frames (~133 ms) to **~500–1000 ms** of bad frames — evidence converges (DeepSORT 1 s, tf.js 1 s, VRM 0.5 s); even 500 ms eliminates most motion-blur/occlusion bursts during swings. Implement by counting `timestampMs`, not frames (Kinect white paper requires real Δt accounting; frames can drop). Cost: constant change + tests. Sources: Section 4.4 table.
2. **Do not pause or restart countdown on transient loss.** Change `RunGate`: during bursts below the limit (e.g. 1–2 s), the run **continues** with degraded input (speed decaying smoothly — see item 3) and a subtle visual notice (transparency like User Viewer — Kinect HIG pp. 88–89); pause only after sustained loss; recovery resumes **without** a 3 s countdown when the player never left. No reference product re-onboards after a burst — the current countdown is the system’s most punitive behavior. Sources: Sections 2 and 6.
3. **Coast with damping on continuous controls.** Instead of `sprintSpeed01` falling to 0 on the first non-`tracked` frame, keep the last valid cadence decaying (e.g. ×0.9/frame or half-life ~150 ms) for up to ~500 ms — exactly Meta’s pattern (integrate velocity + damping per bad frame), adapted to our scalar channel. Prevents the runner from “freezing in mid-air” during each burst. Sources: Section 2.1 step 4, Section 4.5.
4. **Gate per used landmark, not global min().** The torso gate for cadence/jumping already uses the four central points — but swing uses wrist + torso `world` coordinates with the same 0.55 threshold, and `min()` over 5 points is statistically much stricter than per-point gating. Adopt: (a) threshold 0.5 (BlazePose author recommendation, Section 3.1); (b) on a bad frame, **hold detector state** instead of resetting — resetting `SwingDetector`/`CadenceTracker` on `lost` (`actionPipeline.ts:59-63,74`) destroys tracking memory that could survive the burst; with item 1’s grace window, reset occurs only on real loss. Sources: Sections 3.1 and 4.2 (“reset the filter when a skeleton is lost” — but only when it is actually lost).

### Tier 2 — medium effort, high impact

5. **Evaluate Lite → Full with a real benchmark.** Swap the `.task` on GPU and measure: empty frames/minute, p95 round-trip latency, spurious `lost` rate on recorded fixtures. Static evidence (+3.8–5.3 PCK for +5 ms GPU) suggests a strong temporal-robustness gain at low cost; CPU fallback remains Lite. If +25 MB download is an issue, consider loading Full only when delegate=GPU. Sources: Section 3.4. **Temporal-dropout improvement is not published — measure before adopting** (gap in Section 8).
6. **~100 ms blend-back after a burst.** When points return, interpolate positions/derived angles from coasted to measured over ~100 ms, targeting the newest measurement — avoids a snap that retriggers velocity detectors (false swing on recovery). Meta documents that this does **not** add perceived latency. Source: Section 2.1 step 5.
7. **Nonlinear spike suppression (asinh) or deviation clamp on derived channels.** Production tf.js uses `threshold·asinh(Δ/threshold)` in its low-pass; Kinect uses MaxDeviationRadius. Directly applicable to scalar channels (`torsoVertical`, wrist velocity) so a bad frame with a teleported coordinate cannot contaminate cadence/swing even before any gate. Sources: Sections 4.1 and 4.2.
8. **Use real `captureTime`/`frame.timestamp` in timestamps sent to the graph.** The internal 1€ derives frequency from timestamp Δt; today we use `performance.now()` for scheduling, not capture time — maintainer recommends “time of the video frame” (#4715), and rVFC spec provides `metadata.captureTime` (SHOULD) — already noted in `docs/pesquisa-pipeline-cv.md` Section 2.1. Impact: internal smoothing is correctly calibrated when frames drop.

### Tier 3 — opportunistic / measure first

9. **Camera: keep `frameRate: {ideal: 60}` and experiment with exposure caps in Chromium.** 60 fps already limits exposure to 1/60 s and doubles samples from a 250 ms swing; advanced `applyConstraints({exposureTime})` may reduce blur further in desktop Chrome (Windows 76+/macOS 111+/Linux), gracefully degrading where absent — measure the effect in low light before enabling by default (a dark/noisy image is worse than blur). Sources: Section 5 items 1–3.
10. **Setup nudging in calibration UI** (2–4 m distance — practically, for a desktop webcam: body 70–90% of frame height, head always visible, frontal light). This is standard Peloton/Kinect practice and costs only UI. `AutoCalibrator` already measures framing — extend it with head/face visibility and lighting-orientation checks. Sources: Sections 2.2, 5.5, 3.3.
11. **Adapt smoothing to frame quality** (aggressive when visibility/presence is low, light when high) — direct Kinect white-paper prescription, Section 3.6. Only after measuring actual residual jitter (`docs/pesquisa-robustez-gestos.md` Section 3 measurement recipe), since current double filtering is already excessive at rest. Source: Section 4.2.
12. **Lower `minPosePresenceConfidence` below 0.5?** Hypothesis to reduce empty frames; no source quantifies the trade-off. If tested, measure false-positive pose rate (ghosts in background) too — gap in Section 8.

### Do not

- **Do not** interpolate toward low-confidence landmarks: documented bias (Kinect white paper; Meta tried it and reverted — “ended up being even more frustrating”).
- **Do not** raise capture resolution expecting robustness: the model downsamples internally; cost is throughput (720p measurement ≈ half the fps of 480p).
- **Do not** add another 1€ layer to landmarks: there is already uncalibrated internal + app double filtering (`docs/auditoria-mediapipe.md` #1); change only after measurement.
