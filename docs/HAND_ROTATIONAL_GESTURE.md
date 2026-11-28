# Nevergear Menu Hand-Rotation Gesture

## Summary

The Nevergear Menu accepts a palm-rotation gesture to turn the channel carousel. The gesture is limited to the `home` screen and is processed only while the carousel is active (`ring === true` and no opening zoom is in progress). Title screens, game selection, gameplay, and pose tracking do not use the detector.

The implementation has three small boundaries:

1. **`RotationalFlickDetector`** (`packages/core/src/intent/rotationalFlickDetector.ts`): a pure, deterministic detector over `worldLandmarks`.
2. **Hand-cursor arbitration** (`src/kinematics/handCursor.ts`): decides when rotation blocks pinch, fist/back, and hover input.
3. **`CarouselController`** (`src/ui/carouselController.ts`): continuous carousel physics in `requestAnimationFrame`, without simulating arrow clicks or rendering React at 60 fps.

## Flow

```text
HandLandmarker worldLandmarks (21 x 3D)
        │
        ▼
palmBasis(WRIST, INDEX_MCP, MIDDLE_MCP, PINKY_MCP)
        │  3D basis in camera space
        ▼
relative rotation between frames / real dt ──► raw angular velocity
        │                                           │
        │                                  OneEuroFilter (scalar)
        │                                           ▼
        └──────── finger curvature ──► open / cupped / unknown palm
                                                    │
                                                    ▼
                              IDLE → ROTATION_CANDIDATE → ROTATING
                                                ⇅             ⇅
                                             CANCELLED     RECOVERY
                                                               │
                                                      open palm ▼
                                                      BRAKING → SNAP_TO_CARD → IDLE
```

The palm basis preserves the hand's global rotation in camera space. This differs from `canonicalLandmarks`, which removes rotation and scale for shape recognition. The detector measures the smallest relative turn between 3D bases, so there is no `359° ↔ 0°` jump and no absolute angle with wraparound is filtered.

## Activation contract

`App.tsx` passes the following to `HandCursorDetector`:

- `worldLandmarks` for the primary hand;
- `rotationEnabled` only when the current screen is `home` **and** `HomeMenu` has marked the carousel as active.

`HomeMenu` owns the gate because it alone knows whether the grid has become a carousel and whether the opening zoom has started. When leaving the screen, entering the zoom, or unmounting the component, the gate returns to `false`. A screen or camera change therefore cancels rotation instead of leaving velocity or gestures armed.

## States and arbitration

- `ROTATION_CANDIDATE`: requires 110 ms of evidence before taking control. It does not block input yet: pinch, back, and swipe remain active, and an in-progress pinch disables rotation.
- `ROTATING`: arbitrated angular velocity drives the carousel; hover, click, back, and swipe are blocked.
- `RECOVERY`: passive hand return preserves momentum; small velocities in the opposite direction are zeroed. Reversal requires a stronger impulse with hysteresis.
- `BRAKING`: an open palm held for 70 ms sets control velocity to zero and immediately slows the carousel.
- `SNAP_TO_CARD`: the nearest channel (`Math.round(turn)`) becomes the snap target.
- `CANCELLED`: hand loss, invalid timestamps, a long gap, or a handedness change. After rotation ends, pinch and fist must be re-armed (`release`/`open`) before clicking or going back.

## Initial parameters

| Parameter | Value | Reason |
|---|---:|---|
| `candidateMs` | 110 ms | Prevents hand movement or a pinch from starting rotation; the first frame counts for at most half its duration. |
| `candidateMinSpeedDegPerSec` | 70°/s | Above incidental rotation from simply moving the hand. |
| `candidateTimeoutMs` | 240 ms | Tolerates noisy shape/curvature frames at 15–20 fps without leaving a candidate active indefinitely. |
| `openBrakeConfirmMs` / `candidateShapeCancelMs` | 70 / 70 ms | Hysteresis against a single frame of open or closed fingers. |
| `maxFrameGapMs` | 250 ms | Tolerates slow webcam frame rates. |
| `reversalSpeedDegPerSec` | 95°/s | Reversal requires more energy than entry. |
| `maxAngularVelocityDegPerSec` | 360°/s | Caps motion at one visual revolution per second. |
| `brakeSnapDelayMs` | 65 ms | The open palm must persist briefly before snapping. |
| `snapSignalMs` | 300 ms | Gives the carousel time to complete its 180–250 ms snap. |
| `cuppedMinCurvature` / `openPalmMaxCurvature` | 0.13 / 0.06 | Joint-cosine curvature separates a cupped palm from an open one with hysteresis. |
| Carousel `snapDurationMs` | 220 ms | Clamped to 180–250 ms. |
| `driveResponseMs` / `brakeResponseMs` | 90 / 42 ms | Smooth response to the impulse and near-immediate braking. |

Curvature uses `1 - average(joint cosine)` over `worldLandmarks`. Straightness metrics based on fingertip-to-base distance barely separated an open palm from a fist in synthetic measurements; joint cosines worked better because they capture bending across the fingers.

## Carousel physics

The controller integrates real `deltaTime` from `requestAnimationFrame`:

- `ROTATING`: exponentially approaches the target velocity;
- `RECOVERY` or a still hand: momentum decays exponentially;
- `BRAKING`: decays rapidly to zero;
- `SNAP_TO_CARD` or low momentum: eases to the nearest whole channel;
- `prefers-reduced-motion`: snapping is immediate and the cursor's orbital animation is disabled.

The `requestAnimationFrame` loop runs while the carousel is ready, with or without a hand. When idle, it does not move anything; mouse input and CSS transitions do not depend on the loop. Hand samples older than 150 ms are treated as idle, preventing a stationary `ROTATING` frame from continuing to accelerate the carousel. Mouse clicks and arrow keys take ownership for 900 ms — the CSS transition duration — so a flick during an animation does not skip its target. The React component remains the mouse/keyboard interface: arrow keys and channel clicks call `syncTurn` on the controller and preserve the existing CSS transition. During gesture control, the controller writes `left/top/transform/opacity/zIndex` directly to the channels, and the `is-gesture-controlled` class removes transitions that would compete for those same attributes. React is synchronized only when the front channel changes or movement settles.

## Lateral swipe

`src/kinematics/handSwipe.ts` advances or goes back one channel with a quick horizontal movement (a leftward hand movement advances). It evaluates sliding windows of 40–140 ms and requires average speed of 1.55 image widths per second, net horizontal displacement of at least 0.1 image widths, horizontal dominance (1.25× vertical movement), at least two intervals in the same direction, and a period of stillness beforehand. There is a 350 ms cooldown in the same direction and 450 ms in the opposite direction. Swipes are blocked during a pinch, fist, or committed rotation; pinch re-arms only after the hand slows down. A very fast cursor reach can also trigger a swipe.

## Optional diagnostics

Enable with `?handDebug=1`. The overlay shows real data from the pipeline:

- phase, hand shape, and curvature;
- 3D basis (palm normal and wrist-to-middle-finger axis);
- raw, filtered, and arbitrated angular velocity;
- pinch state, cursor-freeze reason, swipe movement, capture-to-delivery latency, and effective worker FPS;
- direction, rejection reason, `dt`, and effective hand FPS;
- carousel mode, velocity, `turn`, front channel, `dt`, and effective FPS.

The overlay is disabled by default and uses `pointer-events: none`.

## Automated coverage

Coverage added or extended:

- `tests/rotationalFlickDetector.test.ts`: 31 deterministic tests, including angular wrap, jitter, invalid or irregular timestamps, gaps, varying FPS, handedness changes, left/right mirroring, open/closed hand, recovery, reversal, braking, snap, and cancellation.
- `tests/carouselController.test.ts`: FPS-independent physics, the 360°/s cap, momentum, reversal, braking, snap, channel wrap, `prefers-reduced-motion`, parameter validation, and external ownership.
- `tests/handCursor.test.ts`: 6 new arbitration scenarios (gate off, velocity/phase publication, pinch/fist suppression and re-arming, frozen cursor, and hand loss).
- `tests/useHandHitTest.test.tsx`: hover/click/back are blocked during rotation, and a held click does not fire later.
- `tests/homeMenuCarousel.test.tsx`: direct continuous painting, the control class, debug data, and `requestAnimationFrame` cancellation on unmount.

## Manual webcam validation

1. Run `npm run dev` and open the Nevergear Menu with `?handDebug=1`.
2. Enable the camera and wait for the `synced` state.
3. In the carousel, cup the palm slightly and rotate as if turning a small steering wheel.
4. Check the overlay: shape `cupped`, phase `ROTATING`, matching direction, and control velocity below 360°/s.
5. Return the hand without turning in the opposite direction; the carousel should keep moving briefly on momentum.
6. Open the palm: it should enter `BRAKING`, then `SNAP_TO_CARD`, and stop on the nearest channel.
7. During `ROTATING`, bring thumb and index finger together or make a fist: no click or back action should occur. When finished, release and pinch again to confirm re-arming.
8. Enter a game or turn off the camera during the gesture: rotation should cancel and the gate should return to false.

### Tuning

If the webcam is low or the hand is far away, increase `candidateMs` or `candidateMinSpeedDegPerSec`. If open palms are classified as cupped, increase `cuppedMinCurvature`; if a cupped palm is classified as open, lower `openPalmMaxCurvature`. Make small changes and revalidate with deterministic tests before using the webcam.
