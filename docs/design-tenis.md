# Nevergear Sports-style tennis design — Baseline Rally

Date: November 25, 2026 · Design document for rewriting `TennisGame`. Derived from the session bottleneck analysis (see `analise-gargalos-corrida.md` for the generic pipeline) and the CV research in `docs/`. Clearly distinguishes **facts verified in code**, **domain knowledge**, and **design decisions**.

---

## 1. How Nevergear Sports Tennis works mechanically

Domain knowledge about the original Wii Sports (2006):

1. **The player does not control movement** — the Mii runs to the ball automatically. Swinging is the only skill.
2. **Direction = timing**: the same natural swing sends the ball cross-court (early contact, in front of the body) or down the line (late contact, behind the body). There is no “aim with your arm.”
3. Power matters less than timing; a ball that is too fast is a risk for an error, not simply a virtue.
4. Serve: an upward flick tosses the ball, and a swing at the apex determines serve quality.
5. Forehand/backhand are inferred from the side of the gesture; the game uses generous windows — it is an arcade game.
6. Wrist-twist spin does not materially affect the core loop.

## 2. Sensor constraints — what can and cannot be copied

Facts verified in code and measurements from `pesquisa-pipeline-cv.md` §7.5:

| Capability | Status | Design consequence |
|---|---|---|
| Swing peak instant (`peakTimestampMs`) | **Good** — quantized to ±16–33 ms at 30 fps, monotonic timestamps | The core mechanic (timing) uses our best channel — the same happy accident as in Wii Sports. |
| Swing side (forehand/backhand) | **Good** — strong lateral signal | Inexpensive authenticity: direction mirrors on a backhand, as in real tennis. |
| Peak speed | **Coarse but usable** — finite differences of filtered position | Power in 3–4 levels, not finely continuous. |
| Contact height (wrist y at peak) | **Usable** — stable landmark | Smashes/volleys emerge for free. |
| `vy` at peak (rising/falling) | **Usable as a proxy** | Cosmetic/physical topspin or slice on the bounce. |
| Precise lateral wrist position | **Noisy** — current aiming uses it | **Remove position-based aiming; use timing-based aiming.** |
| Depth (`z`) | **Noisiest** — monocular | Do not use `z` for anything critical. |
| Wrist orientation/spin from twisting | **Impossible** | Not part of the core loop in the original Wii Sports game either — ignore it. |
| Photon-to-confirmed-event latency | **~100–500 ms** — pipeline + confirmation + arbitration | Requires retroactive adjudication (§4) — the heart of this design. |
| Latency to swing *onset* | **~50–100 ms** — one frame after crossing the threshold | Early channel for animation (`swing-start`). |

Physical constraints cannot be solved in software: motion blur from a fast-moving wrist on a room webcam (15–33 ms/frame exposure), wrist occlusion by the torso during the backswing, and a camera limit of 30–60 fps. The design assumes that **swings will occasionally be missed** — a missed swing must never unfairly cost a point: contact windows are generous and a whiff is always visibly the player’s fault (the ball went by), never the detector’s.

## 3. The game

### 3.1 Court and geometry

Approximately metric units, compressed to arcade scale:

```
z = -10 ───────── opponent baseline
z = 0   ═════════ net (height 0.9 at the center)
z = +10 ───────── player baseline
x ∈ [-3.5, +3.5] singles sidelines
```

- Player avatar at z ≈ +8.3; opponent at z ≈ -8.3.
- **Contact plane** `z_contact = +7.2` (in front of the player); the opponent’s plane is at -7.2.
- Avatar lateral reach: reach radius of ~1.15 u from the center of the body.

### 3.2 Automatic movement (as in Wii Sports)

The avatar runs on its own: it intercepts the ball’s lateral projection at a maximum speed of ~5.5 u/s. The real player **does not need to move** — and lane-lean is not used in tennis. Opponent placement applies indirect pressure: if the avatar is still moving when the ball arrives, the maximum return quality drops (power cap) — this is how wide balls become difficult without ever becoming impossible.

### 3.3 Rally state machine

```
SERVE_TOSS ──swing──> adjudicate serve ──> RALLY (ball in play)
    │miss (ball drops)                        │
    └─ re-toss (no penalty)                   ├─ ball in flight to opponent → AI returns or misses
                                              ├─ ball in flight to player → swing or let it pass
                                              └─ ball bounces twice, goes out, or hits net → POINT_OVER
POINT_OVER ──> scoreboard (15/30/40/game) ──> next serve (alternates each game)
MATCH_OVER ──> results screen ──> automatic restart
```

Simplified arcade rules (design decisions):

- **No service box or double fault**: a serve counts like any other ball — it must clear the net and land in the court. A missed toss is not penalized: toss again indefinitely, with a HUD hint. (Service boxes require geometric work with no showcase benefit.)
- Volley is allowed: the ball can be hit without bouncing — timing is the same.
- At most one bounce, as in real tennis; the second bounce ends the point.
- Classic 15/30/40/deuce/advantage scoring per game; the server alternates each game; match is best of 3 games (configurable), with automatic restart.

### 3.4 Contact adjudication — the heart of the design

**Problem**: the swing event arrives 100–500 ms after the actual physical contact. If the game checks the ball’s current position when the event arrives, timing is corrupted.

**Solution — retroactive adjudication**: the ball trajectory is ballistic and perfectly known. When the event arrives:

1. `t_peak = event.peakTimestampMs` — the physical instant of contact (estimated by the detector).
2. Analytically rewind the ball to `t_peak`: position, velocity, and number of bounces so far.
3. `timingError = t_peak − t_ideal`, where `t_ideal` is when the ball crosses the contact plane at a hittable height (0.4–2.2 u).
4. Windows (arcade, generous — tunable design decision):
   - `|timingError| ≤ 500 ms`, the ball is within lateral reach (≤2.2 u), and it is live (no second bounce and not past the player) → **contact**.
   - Otherwise → **whiff** (the ball remains live; physics resolves the point).
5. Return direction: continuous mapping from `timingError → lateral angle`, with sign dependent on the stroke side — early → cross-court, late → down the line; it mirrors on a backhand, as in real tennis. An extreme `timingError` (>~350 ms) sends the ball so wide that it goes out — the miss comes from geometry, not a special rule.
6. Power: event `power01` modulates outgoing speed (11–20 u/s). The cap is reduced if the avatar was moving. A high ball (above the shoulder at contact) becomes a smash: downward angle and speed bonus.
7. Spin: wrist `vy` at the peak — rising strongly = topspin (kicks up/forward on the bounce), falling = slice (stays low on the bounce). Physical effect **only on the bounce** — visible and honest.

**Visual rewind**: at adjudication, reposition the ball at the contact point with its new velocity **advanced by the delta** (`t_now − t_peak`), so the rendered position is where the outgoing ball would be now. This causes a 1–2 frame pop, masked by the contact sound and avatar swing animation, which began at `swing-start` (§3.5). This is the same cheat used by all retroactive netcode and camera-based games.

**If the detector misses a swing**: the ball goes by and physics resolves the point — indistinguishable from a real whiff. This is acceptable because it is rare; the reverse (a ghost swing) would be unacceptable, and the detector already avoids it by design.

### 3.5 The early channel: `swing-start` event

A new pipeline event, emitted on the frame when a swing crosses the onset threshold (before any confirmation — it can be aborted and never become a confirmed swing). Latency is ~50–100 ms vs. ~150–500 ms for the confirmed event. Uses:

- **Avatar animation**: procedural windup + stroke (~300 ms) starts at onset — by the time adjudication arrives, the racket is already mid-swing and the contact frame aligns with the ball’s snap. This closes the illusion of causality.
- Do not use it for adjudication: it is unconfirmed; backswings and arm adjustments also trigger it — visually harmless (it looks like preparation).

### 3.6 Target ballistics — how the outgoing trajectory is built

Instead of pushing velocities and hoping, **solve the trajectory for a target** (standard arcade technique, deterministic and testable):

1. Choose the bounce target `(x_t, z_t)`: lateral position from timing (continuous, clamped to ±20°), depth from power (harder = deeper/faster), plus a small deterministic-seed jitter.
2. `T = (z_contact − z_t) / v_forward` — flight time determined by the chosen speed.
3. `vx = (x_t − x_0)/T`, `vy = (gT²/2 − y_0)/T` — exact projectile solution for `y(T) = 0` under gravity `g`.

Emergent consequences without special rules: a hard ball travels flatter (risk of the net on low contact — real physics); extreme angles go out at the sideline; a smash from a high ball points down and is nearly indefensible. The net is a physical collision at the `z=0` plane with a height of 0.9 — hitting it ends the attack, as in tennis.

### 3.7 Opponent AI

- **Movement**: intercept the ball’s projection on the opponent’s plane at a maximum speed of ~5 u/s; return to center after the shot.
- **Return**: when the ball enters the opponent’s window, generate a target-ballistic return to a point on the player’s side. Placement variance is controlled by difficulty; speed and depth are too.
- **Error**: the chance of an error (net/out) increases with the quality of the incoming ball (speed + width + smash). Difficulty ramps smoothly across games — it starts generously (central, slow balls) so the player can learn the timing.
- Winners happen when the ball is fast and wide: the player’s avatar cannot reach it in time and the quality cap drops — but the point is never impossible because reach is guaranteed except for extreme combinations (arcade decision).

### 3.8 HUD, audio, and feedback

- Real tennis scoreboard: games + current points (15/30/40/AD), and a server indicator.
- Timing feedback on every contact: `EARLY`/`PERFECT`/`LATE` + resulting direction — teaches the central mechanic.
- State messages: serve prompt, whiff (“the ball went by!”), net, out, game/match.
- Existing contact sound (`audio.hit(power)`) plays at adjudication; bounce and serve can reuse `step`/`jump` — no new assets.

### 3.9 Keyboard (dev/test mode without a camera)

Space triggers a synthetic swing with `peakTimestampMs = now` — in other words, **keyboard timing is authentic**: press early for cross-court, late for down the line. Fixed power is 0.65 (shift+space = 1.0). This is enough to validate the whole game without a webcam — and is how the showcase is demonstrated on machines without a good camera.

## 4. Implementation architecture

### Pure modules (no Three.js — testable with Vitest, strict TDD)

| Module | Responsibility |
|---|---|
| `src/games/tennis/tennisScore.ts` | Scoring FSM for 15/30/40/deuce/game/match, alternating serve |
| `src/games/tennis/ballistics.ts` | Projectile: `advance` (position/velocity at t), `timeAtPlane`, `bounce`, `solveOutgoing` (target → velocity) |
| `src/games/tennis/contactAdjudicator.ts` | Rewind ball to `t_peak`, windows, `timingError` → direction/power/quality, whiff |
| `src/games/tennis/opponentAi.ts` | Movement target, return generation, error and difficulty model |

`TennisGame.ts` owns the Three.js scene, state machine, animations, and HUD — a thin integration layer over the modules.

### Changes to the sensing pipeline

> Architecture note (Nov. 25): the CV pipeline was extracted into the `@nevergear/spatial-core` package (`packages/core`) — protocol in `packages/core/src/providers/poseProtocol.ts`, worker in `packages/core/src/providers/pose.worker.ts`. The package also includes **hand-tracking** infrastructure (`HandClient`, hosted model) and recording replay, both currently outside the app’s path. Pose + hand fusion is future work: HandLandmarker is designed for close-up hands, while a hand occupies only a few pixels in a full-body frame from ~2 m — uncertain gain, certain inference cost. This tennis iteration uses pose alone, the measured and understood path.

1. **`swing-start` event** — new `SportActionEvent` type; `SwingDetector` emits on the onset frame.
2. **Enrich confirmed `swing`**: `contactY` (wrist height at peak, relative to shoulder width), `verticalSpeed` (`vy` at peak — spin proxy), `onsetTimestampMs`.
3. **60 fps camera**: `frameRate: { ideal: 60 }` with no cap — doubles swing samples where hardware allows.
4. **Latency-based GPU→CPU fallback**: median the real inference times of the first frames (discard the first, which includes warm-up); median above budget → recreate on CPU and report `FALLBACK`. This closes the trap measured in §7.5 of the research (software GL: 5–10 fps without fallback). Measurements from real frames avoid the clock-source problem of synthetic init probes.

### Test strategy

- Strict TDD for the four pure modules: test first, deterministic, no `setTimeout` — time is always an input.
- Swing: extend synthetic fixtures for onset/height/`vy` — same conventions as `tests/kinematics.test.ts`.
- GPU fallback: test the pure decision function; verify integration manually with `scripts/pose-bench.html`.
- Do not test `TennisGame` in Vitest (Three.js/WebGL) — all decision logic lives in pure modules; verify the scene manually with a keyboard.

## 5. Out of scope (declared YAGNI)

- Service boxes / double faults / tie-breaks.
- Wrist-twist spin (impossible with the sensor).
- Continuous puppet mode (avatar racket driven by the wrist in real time) — future work if procedural animation is unconvincing.
- Multiplayer / doubles.
- Adaptive difficulty beyond the linear ramp.

## How Wii Sports Tennis does it, and what we adopted

Consulted [MiiWiki](https://miiwiki.org/wiki/Tennis) and
[Wikibooks](https://en.wikibooks.org/wiki/Wii_Sports/Tennis). These are fan sources.

| Wii Sports, according to the sources | Here |
| --- | --- |
| Automatic movement; the player only returns the ball | Same |
| Swing timing and height determine direction | Timing determines the side; where the swing ends determines the arc |
| Serve: toss and hit; at the top, a fast serve gets a white trail | Same, but the toss is automatic |
| Low-to-high makes a lob; high-to-low makes a slice | Finish well above the head (height predicted from upward speed): high ball. Finish below the chest: low shot |
| Always doubles | Singles |
| 1 game, best of 3 or 5; 15, 30, 40, and advantage | Best of 3 |
| Mii crowd | Simple crowd |

**The sources do not discuss faults, double faults, or net/out rules.** To keep the game flowing, we decided that any swing that hits the ball always clears the net, and serves always land in.
