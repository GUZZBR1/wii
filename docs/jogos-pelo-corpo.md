# Body-controlled sports: Athletics, Tennis, and Boxing

Date: November 28, 2026. **Status: playable; validation across people and real-world setups remains incomplete.**

The menu offers **Athletics** (100, 200, or 400 m), **Tennis**, and **Boxing**, plus the three-sport **Iron Man** challenge. Athletics and Tennis use body input; Boxing also supports keyboard controls. The legacy obstacle course remains in the code, outside the menu.

> **Main caveat.** Evidence varies by sport. Athletics and Tennis thresholds come from a small number of webcam recordings, including one early running recording with 42% detection. Boxing has offline dataset results and an initial real recording, but punch type and target still need validation on frontal webcam recordings, and all three sports need broader player testing. These results do not establish performance for other people or setups.

## 1. What the player does

1. In the menu, use the **hand** (hand cursor) to choose a sport or the Iron Man challenge.
2. The game prepares the player:
   - **Athletics:** framing and a 5-second running warm-up.
   - **Tennis:** a guided warm-up on court, without an opponent: swings, the other side, a toss, and a serve.
   - **Boxing:** choose a fight, tutorial, punching bag, or dodge challenge; the tutorial demonstrates guard, punches, dodges, ducking, and a short closing test.
3. Play.
4. At the end, **raise both hands** for 1.5 seconds to play again.

To return to the menu from the results screen, **cross your forearms into an X** in front of your chest for 1.5 seconds (`armsCrossed` in `framing.ts`). During a match, use the “‹ Games” control. Boxing can also be played with the keyboard; see its controls on the lobby screen.

## 2. From camera frame to game

```
webcam ─▶ PoseClient (Worker, MediaPipe Pose Lite on CPU) ─▶ App.onPose
            └─ ActionPipeline (src/kinematics/actionPipeline.ts)
                 ├─ TorsoVerticalChannel: shared upper-body signal
                 │    ├─ IntensityMeter ─▶ effort ─▶ Athletics
                 │    ├─ Dodge / guard / duck / footwork ─▶ Boxing
                 │    └─ Legacy obstacle-course detectors ─▶ Track
                 ├─ SwingDetector (one per wrist) ─▶ swing ─▶ Tennis
                 └─ PunchDetector (one per arm) ─▶ punch ─▶ Boxing
            framingAdvice / handsHidden / handsRaised (src/kinematics/framing.ts) ─▶ games
```

- **CPU vision by default** (`src/cv/delegate.ts`): on an integrated GPU, the Full model competed with the
  3D game and made the camera stutter. `?delegate=gpu` switches back to the GPU with the Full model.
- **The shared torso channel only requires the shoulders** (`torsoVertical.ts`), which is enough for Athletics and Tennis. Boxing’s dodge, duck, and footwork signals add framing requirements and may ask the player to bring their hips into view. Many movement measurements are normalized in **shoulder widths**, reducing sensitivity to camera distance.
- **Broken frames are discarded:** during fast movement, the tracker sometimes collapses one shoulder onto
  the other (width changes from 0.28 to 0.01). An upside-down skeleton is also discarded.
- **The detector needs to see the head:** BlazePose finds the person through the face
  ([paper](https://arxiv.org/abs/2006.10204)). When the head was cropped, the body was lost during a run.

## 3. Athletics

The 400 m stadium, Mii, opening, and follow camera come from PR 41 (GUZZBR1). Rules are in
`src/games/athletics/race.ts` (pure and tested in `tests/race.test.ts`); the scene is `AthleticsGame.ts`.

| Phase | What happens |
| --- | --- |
| Framing | Asks the player to tilt the camera, move farther away or closer, or center themselves. Continues after 1 s of good image, or after 15 s with the body visible. |
| Warm-up | “Run all out” for 5 s. The Mii runs in place. The bar fills when the signal reaches the minimum needed for calibration. Calibration requires 1.5 s of valid signal across recent frames in the last 3 s. A high value from this interval defines the reference for that person and camera. If almost nothing is detected, it repeats up to twice with “show your hands” or “move your arms more,” then uses a default. |
| Countdown | 3, 2, 1 with sound. |
| Race | Three rivals (Bia, Caio, Davi) run at a fixed pace, slightly slower over longer distances. A split is announced with sound every 100 m. |
| Finish | Placement, everyone’s times, and a personal record for each distance (in the browser). |

**Speed:** intensity divided by the 80th percentile of readings from the last 3 seconds of the warm-up, with a 15% margin. Matching the warm-up yields about 7.4 m/s (100 m in roughly 14 s); going beyond it still helps. Speed builds over 0.5 s and decays over 1.4 s, so a missed reading costs little.

**Frozen camera:** a reading older than 0.5 s is invalid; the character slows down instead of continuing to run at the last value.

### Intensity meter (`src/kinematics/intensity.ts`)

One measurement: **how much the person moves per second**. It adds vertical wrist speed (relative to the shoulders) and head speed, in shoulder widths. It increases with both **pace and movement size**. If the head and shoulders move in the same direction, their shared sway also counts, including when arm movement is small or the wrists leave the frame.

In the recordings, in shoulder widths per second: standing still 0.02–0.3; walking up to 0.7; running 1.2–2.8.

It replaced two measured and discarded versions:

- Head sway, which ignored people who jog with a “gliding” motion (0.1–0.35 while running).
- Wrist-alternation counting, which saturated at 100% during strong pumping and ignored short arm movements.

Limitations: moving only the arms generates speed (accepted for this event); walking yields little; camera angle changes the raw value, compensated for by the warm-up.

## 4. Tennis

Rules and game decisions are in [design-tenis.md](design-tenis.md): the Mii runs to the ball automatically,
shot direction comes from the **timing** of the swing (early crosses the court, late goes straight), and contact is judged at the physical instant of the hit, not when the event arrives.

Current state:

- Court with service boxes and second-serve rules, games-and-points scoreboard, best of 3 games.
- Starts with a **court warm-up** (`tutorial.ts`): 3 swings, 2 from the other side, 2 tosses, and 2 serves. Each step advances when recognized; with no progress, it explains the step at 10 s and moves on at 22 s; raising both hands skips. It learns the player’s **racket hand** and **swing size** (between 1.6 and 1.9 shoulder widths, never stricter than the default). Only on the first game; “play again” skips the warm-up.
- Grass stadium with stands, crowd, and trees (`stadium.ts`), and a low camera behind the player.
- Mii-style tennis players, with loose hands and oversized rackets (`athlete.ts`).
- Generous hit window (±0.5 s) and a slow ball, with a **closing ground ring** to signal when to hit.
- Swing arc and trail, flash and shake on impact, racket sound, a crowd that jumps and applauds, and score announcements spoken by the browser (`effects.ts`, `audio.ts`).
- **Serves cannot be missed**: any swing during the toss lands in the correct box; timing only changes power and angle.
- Forehand and backhand **look different**: the character stands beside the ball and draws the racket back on that side, the swing comes from the recognized side, the trail is yellow (forehand) or blue (backhand), and the shot name appears.
- **Two-gesture serve**: raising the **free hand** tosses the ball immediately, and the racket hand serves. The racket hand is learned from returns (right-handed until evidence says otherwise) and never tosses. The ball waits 2.6 s. One recording measured a natural toss of 0.4–0.7 s, too short to require the hand to remain still.
- The **height** where the swing finishes changes the ball: above the head sends it high; below the chest sends it low.
- A blurred frame in the middle of a swing is skipped. Previously it erased the swing, and the return movement was read as a backhand.
- The opponent **returns the first 3 balls of every point**; after that, it can miss more often under pressure and visibly end up far from the ball when it does.
- `?fps` shows the delay between frame capture and arrival in the game.
- Final ball height is **predicted** from how quickly the arm is rising, without waiting for it to arrive. Predicting the animation in advance was measured and discarded: it saved about 60 ms but created 41 false movements for 63 shots.
- **Last-second assist** (`armMotion.ts`): if no swing was detected and the ball is passing, any clear arm movement (1 shoulder width in 0.5 s) returns it weakly toward the middle. This came from a second person’s recording: the camera saw them in 727 of 742 frames, but only **one** swing was detected. This person hits more slowly, more upward, and less sideways. A recognized swing always takes precedence and determines power and direction.
- Restart with both hands.

### Swing detector (`src/kinematics/swingDetector.ts`)

A swing means the wrist **travels a long way in a short time**: 1.9 shoulder widths in 270 ms, sideways or sideways-and-upward (at least 0.8 sideways), measured in the image relative to the midpoint between the shoulders. The scale used as a ruler only shrinks slowly because torso rotation makes the shoulders “shrink.” Lowering the arm does not count, and the return in the opposite direction is ignored for 0.8 s.

Measured in two recordings of one person:

- **Exaggerated swings:** all 12 visible swings are detected, plus one detection as the wrist leaves the frame.
- **Compact swings during play:** 5 of 8 visible swings (one miss occurs before calibration is ready). The previous rule detected none.

People who swing shorter or more slowly may still not be detected.

## 5. Boxing

The lobby offers four modes: **Tutorial**, **Fight**, **Punching Bag**, and **Dodge**. Fight mode also lets the player choose an opponent profile. The tutorial demonstrates guarding, straight punches, leaning left and right, ducking, and a short dodge test. Its instructions can be skipped with the raise-both-hands gesture. Training modes and the fight use the same pose pipeline.

Body input detects punches from wrist travel and reads guard, lateral dodges, ducks, and torso movement for footwork. Boxing also accepts keyboard input: **E** punches, **Q** blocks while held, **← / →** dodge, and **W / A / S / D** move. The lobby displays mode-specific controls. Detailed behavior and limitations are in [the boxing plan](plano-boxe.md).

The offline UTD-MHAD replay floor reports a confirmed punch in **23 of 32** frontal-boxing clips, with at least three of four clips accepted for **6 of 8** participants. Its negative-control set reports no confirmed punches in six non-boxing action classes across 56 clips, although jumping jacks produced two readings in one clip. These are offline dataset measurements, not a guarantee of webcam performance. Punch type and target still need validation with frontal recordings that label known punches; testing with more people in the actual game is also outstanding. Recordings are ignored by Git and must not be committed.

### Punch detection and classification

`PunchDetector` emits a punch event from wrist movement; `punchClassifier.ts` assigns a tentative punch type and target from the measured trajectory. The current `BoxingGame` uses those values in the damage rules. A guided recording script is available with **G** in Boxing mode; it asks for known punches and defensive movements, and `tests/recordedBoxing.test.ts` evaluates the windows when a local recording is present. The validation caveats and replay commands are in `plano-boxe.md`.

## 6. Shared components

| Component | File |
| --- | --- |
| Framing and visible/raised hands | `src/kinematics/framing.ts` |
| Restart with both hands (only after lowering them) | `src/games/core/restartGesture.ts` |
| Warning when the head is out of frame (after 1.5 s) | `HeadWarning` in `framing.ts` |
| Reduce resolution when frame processing is too slow | `src/games/core/qualityGovernor.ts` (PR 41) |

## 7. Obstacle course (outside the menu)

It remains in the code without maintenance. The detectors below are used only by this mode:

| Action | Technique | File |
| --- | --- | --- |
| Run | How much both shoulders and the head rise and fall together over 1 s | `bounce.ts` |
| Walk | Side-to-side shoulder movement, one per step, with the head nearly still | `walk.ts` |
| Jump | Shoulders and head ≥ 0.45 widths above their previous position; consecutive jumps are measured from the floor | `jumpDetector.ts` |
| Lane | Center measured after the person stands still for 1 s | `postureSignals.ts` |

## 8. How to measure (development tools)

Tools live in `src/cv/diagnostics/` and are enabled only in development or with `?debug`/`?fotos`, so a visitor cannot restart a recording accidentally.

- **G**: records a guided sequence for running, tennis, or boxing, depending on the active game.
- **E**: saves the last 20 s after an error.
- `?fotos`: **E** includes small camera images. These show the person: do not commit them and share them only with that person’s consent.
- `?fps`: display, camera, and pose rates, plus the chip drawing WebGL.
- Recordings in `tests/recordings/` and clips in `tests/recordings/errors/` are ignored by Git. `tests/recordedTrack.test.ts` fails if a recording regresses; **without local recordings, none of this runs**, including in CI.
- `scripts/pose-replay.html` generates the same format from a video at 30 frames per second.

## 9. Other caveats

- Webcam measurements are limited to a small number of recordings and do not represent a player population. The separate boxing dataset floor does not replace real-camera evaluation.

## 10. Remaining work

1. Complete an Athletics race and Tennis match using the camera without keyboard or mouse, then complete a Boxing bout with body controls.
2. Record more tennis examples (another person, soft swings, and a left-handed player).
3. Validate boxing punch types and targets with labelled frontal recordings, then test the current build with more people.
4. Test all three sports with at least three other people using criteria defined in advance: the effort bar fills while running and stays empty while standing still; hard running is clearly faster than light running; tennis swings are recognized; and boxing punches and defensive movements are legible.
5. Exit an in-progress match without a mouse in Athletics and Tennis; separately evaluate the keyboard and body-control flows in Boxing.
6. Tune rival pace and the Athletics speed scale, which are currently first estimates.
7. Diagnose camera stutters with `?fps`.
