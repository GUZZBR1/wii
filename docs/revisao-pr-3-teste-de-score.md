# PR Review — test coverage for the new scoring calculation

Date: November 26, 2026 · Branch: `fix/cv-pipeline-bottlenecks` · Diff reviewed: `git diff main...HEAD`

**Review comment:** "New scoring calculation has no regression test — the testing guide (AGENTS.md) requires coverage for changes to gameplay rules. A test is missing to show that multiple ticks worth less than one point increase the score."

The comment is substantiated: AGENTS.md says "Add a test for every new detector behavior or gameplay rule change", and the change in `src/games/track/TrackGame.ts:95` is exactly a gameplay rule (how much the score increases per second). The practical obstacle is real: `new TrackGame()` creates `new GameLoop(canvas, ...)` (`TrackGame.ts:32`), which runs `new THREE.WebGLRenderer({ canvas, ... })` (`src/games/core/GameLoop.ts:34`) + `ResizeObserver` (`GameLoop.ts:37`) + `window.devicePixelRatio` (`GameLoop.ts:35`); `TrackGame` itself also uses `window.setInterval` (`TrackGame.ts:33`). None of these are available in Vitest's `node` environment (`vite.config.ts:8`). This document evaluates the options and proposes the smallest refactor and test.

---

## 1. What the fix changed (bug mathematics)

Before: `this.score += Math.round(dt * (5 + this.speed01 * 45))` — rounded **every tick**.
After: accumulate the fractional value (`TrackGame.ts:95`) and apply `Math.floor` only when publishing the HUD (`TrackGame.ts:126`).

`GameLoop` runs with a fixed step of `dt = 1/60` (`GameLoop.ts:48`), so the increment per tick is `(5 + speed01·45)/60`:

| `speed01` | points/s (rule) | increment/tick | `Math.round` per tick (old code) | effective points/s (old code) |
|---|---|---|---|---|
| 0 (idle) | 5 | 0.083 | 0 | **0** |
| 0.32 (default) | 19.4 | 0.323 | 0 | **0** |
| 0.55 | 29.75 | 0.496 | 0 | **0** |
| 0.56 | 30.2 | 0.503 | 1 | **60** |
| 1 (max.) | 50 | 0.833 | 1 | **60** (+20%) |

The old code awarded no distance points for any `speed01 < 25/45 ≈ 0.556` — meaning the player scored only at hurdles — and **over-awarded** 60 points/s (instead of 50) above that threshold. It was a step function, not the intended rate of 5–50 points/s. Verified in Node 24: 60 ticks at `speed01 = 0.32` total `19.400000000000027`; with `Math.round` per tick, they totaled `0`.

**Floating-point caveat for the test:** the fractional sum drifts by a few ULPs over many ticks. Measured: 240 ticks at `speed01 = 0` total `19.999999999999986` → `floor = 19` (not 20); 600 ticks at `speed01 = 1` → `499.9999999999956` → `floor = 499`. Conclusion: **do not** write exact assertions for `floor(n·rate)` when the analytical value is an integer; use counts whose result has a safe margin from an integer (e.g., 19.4) or inequalities/`toBeCloseTo`.

---

## 2. Options for making the rule testable without Three.js/WebGL

### (a) Extract the scoring rule into a pure module — **recommended**

All score arithmetic in `update()` is independent of Three.js: the distance tick (`TrackGame.ts:95`) and hurdle outcomes (`+100` / `max(0, −35)`, `TrackGame.ts:110-111`). The only remaining 3D logic is the *condition* for clearing a hurdle (lane, `jumpTime`, `runner.position.y`). Therefore, nearly 100% of the scoring rule can be extracted:

```ts
// src/games/track/trackScore.ts — pure module with no imports (matching the
// src/kinematics/ detector convention: small stateful classes with no DOM/Three.js)
export class TrackScore {
  private value = 0;

  /** Distance score: 5 to 50 points per second, based on pace. */
  advance(dt: number, speed01: number): void {
    this.value += dt * (5 + speed01 * 45);
  }

  /** Hurdle cleared (open lane or jump). */
  hurdleCleared(): void { this.value += 100; }

  /** Hurdle collision: −35 points, never below zero. */
  hurdleHit(): void { this.value = Math.max(0, this.value - 35); }

  /** Raw fractional value, useful for precise test assertions. */
  get raw(): number { return this.value; }

  /** HUD score: the integer part, rounded down. */
  get display(): number { return Math.floor(this.value); }
}
```

Changes to `TrackGame` (5 lines):

```ts
private readonly score = new TrackScore();          // era `private score = 0`
// update():        this.score.advance(dt, this.speed01);
// barreira:        if (...) this.score.hurdleCleared(); else this.score.hurdleHit();
// publishHud():    const score = this.score.display;
```

Name/location: `src/games/track/trackScore.ts` follows the repo's pure-logic module convention (`cadenceTracker.ts`, `oneEuroFilter.ts`, `poseClient.ts` — camelCase) and the "no DOM/Three imports" rule that AGENTS.md already sets for `src/kinematics/`. The `distance` line (`TrackGame.ts:94`) stays in the game — it drives the stride animation, not the score. Optionally, add a `label` getter using `padStart(5,'0')` to test formatting too, but that is unnecessary.

### (b) Inject the loop/renderer into the constructor — possible, but disproportionate for now

`constructor(canvas, onHud, makeLoop = (c, s, cam, u) => new GameLoop(c, s, cam, u))` would allow capturing the `update` callback and driving the entire game in a test — including the hurdle branch and `jumpTime`. However, `update()` is `private`, its observable effects live on Three objects (`hurdles`, `runner`), and the constructor would still call `window.setInterval` (`TrackGame.ts:33`) — requiring `vi.stubGlobal('window', ...)` or another seam. This would make the production signature diff larger to gain coverage the review did not request. It is worth recording as a future option **if** hurdle × jump × lane interactions need testing.

### (c) jsdom/happy-dom environment in Vitest — does not solve it

`vite.config.ts:8` uses `environment: 'node'` (Vitest default — vitest.dev/guide/environment). Neither jsdom nor happy-dom provides a WebGL context: `canvas.getContext('webgl'/'webgl2')` returns `null` in jsdom (open jsdom/jsdom#3617, "Implement WebGL"). And three r187's `WebGLRenderer` **only tries `'webgl2'`** — WebGL 1 was removed in r163 (threejs.org/docs WebGLRenderer) — and throws `THREE.WebGLRenderer: Error creating WebGL context.` when the context is `null` (`node_modules/three/build/three.module.js:16224-16246`). In other words, switching to jsdom **does not** instantiate the renderer; it would fail in the same way (and `ResizeObserver` and `window` would still be missing).

The only "real" route would be `gl` (headless-gl) + jsdom: the package implements conformant WebGL 1.0.3 and experimental WebGL2 through `createWebGL2Context` (not tested against the 2.0 conformance suite — stackgl/headless-gl README), requiring a native build, a patch to the canvas `getContext`, a `ResizeObserver` polyfill, and a `requestAnimationFrame` stub for `setAnimationLoop`. Heavy, fragile machinery for testing a scoring rule — rejected.

**Recommendation: (a).** It mirrors the repo's existing approach to detectors (pure logic in small classes, tested in `node` with fixtures) and directly satisfies the review comment in about 30 lines.

---

## 3. Proposed regression test

File: `tests/trackScore.test.ts`, following the style of `tests/kinematics.test.ts` (Vitest imports, `describe`/`it`, direct instantiation of the pure class). The values below were verified in Node:

```ts
import { describe, expect, it } from 'vitest';
import { TrackScore } from '../src/games/track/trackScore';

const DT = 1 / 60; // Fixed GameLoop step (src/games/core/GameLoop.ts:48)

describe('track score', () => {
  it('turns many sub-point ticks into visible points', () => {
    // Review rule: each step adds less than one point, but the score must grow.
    const score = new TrackScore();
    for (let i = 0; i < 60; i += 1) score.advance(DT, 0.32); // +0.323 per tick
    // The old code (Math.round per tick) would end at 0; the correct value is about 19.4.
    expect(score.display).toBe(19);
  });

  it('shows the first point after a few sub-point ticks', () => {
    const score = new TrackScore();
    for (let i = 0; i < 3; i += 1) score.advance(DT, 0.32);
    expect(score.display).toBe(0); // 0.97 — still below the floor
    score.advance(DT, 0.32);       // 1.29 — crosses the first visible point
    expect(score.display).toBe(1);
  });

  it('keeps the idle trickle at minimum speed', () => {
    const score = new TrackScore();
    for (let i = 0; i < 12; i += 1) score.advance(DT, 0);
    expect(score.raw).toBeCloseTo(1, 10); // 5 pts/s ÷ 60 ticks × 12
  });

  it('applies the hurdle bonus on top of the fractional total', () => {
    const score = new TrackScore();
    for (let i = 0; i < 60; i += 1) score.advance(DT, 0.32); // 19,4
    score.hurdleCleared();
    expect(score.raw).toBeCloseTo(119.4, 10);
    expect(score.display).toBe(119);
  });

  it('clamps the hurdle penalty at zero and keeps floor semantics', () => {
    const score = new TrackScore();
    for (let i = 0; i < 60; i += 1) score.advance(DT, 0.32); // 19,4
    score.hurdleHit();
    expect(score.raw).toBe(0); // 19,4 − 35 → max(0, ·)
    score.hurdleCleared();
    score.hurdleHit();
    expect(score.display).toBe(65); // 100 − 35, fronteira inteira exata
  });
});
```

Design notes: `expect(score.display).toBe(19)` is safe because the raw value is 19.4 — the 0.4 margin cannot be crossed by ULP error. Avoid cases whose analytical expectation is an exact integer (see §1: 240 ticks at `speed01 = 0` yield `floor = 19`, not 20).

---

## 4. Sanity check of the remaining score logic (TrackGame)

- **`Math.max(0, score − 35)` with a fractional score** (`TrackGame.ts:111`): correct. It subtracts from the raw value and clamps at zero — the score cannot become negative (ticks only add, `hurdleCleared` only adds, and the penalty clamps). Same semantics as the old code.
- **Label format** `String(Math.floor(score)).padStart(5, '0')` (`TrackGame.ts:126-127`): it cannot produce `"-0001"` because the score is never negative. Above 99,999, `padStart` does not truncate — the label grows, which is acceptable for an arcade game.
- **NaN**: it could only enter through non-finite `speed01` or `dt`. `dt` is the `GameLoop` constant `1/60` (`GameLoop.ts:48`), and `speed01` comes from `event.speed01` (`CadenceTracker` already clamps it to `[0,1]` via `clamp`, `src/kinematics/cadenceTracker.ts:36`) or from `Math.min(1, speed01 + 0.15)` on the keyboard path (`TrackGame.ts:90`) — NaN would require a malformed event. If it becomes `NaN`, `Math.floor(NaN)` → label `"00NaN"` — cosmetic junk, no crash. A one-line guard (`if (!Number.isFinite(event.speed01)) return;` in `onAction`, `TrackGame.ts:81`) is optional hardening, not required by the review.
- **Out of scope**: the condition for "clearing a hurdle" (`z > 0.2`, `jumpTime > 0.15 || runner.y > 0.45`, `TrackGame.ts:108-110`) did not change in this PR — but it is the next test candidate if option (b) is adopted in the future.

## 5. TennisGame — verdict

**No bug.** Tennis scoring is integer-valued by construction: `this.score += 1` for each point won (`src/games/tennis/TennisGame.ts:66`), and `publishHud` prints the integer directly with `padStart(2, '0')` (`TennisGame.ts:74`). There is no fractional accumulation or `Math.round` on an increment below 1 — the defect fixed in track does not exist here. A `grep` for `Math.round|Math.floor` in `src/` confirms that the only uses are the correct HUD `Math.floor` (`TrackGame.ts:126`), lane selection (`TrackGame.ts:121`), `median` (`src/kinematics/math.ts:10`), and UI formatting (`GameCanvas.tsx:55`, `CameraPip.tsx:36`). No new tennis test is needed in this PR.

## 6. Other diff changes that could use tests (assessment)

`git diff main...HEAD --stat`: 12 files; besides scoring, most of the diff is the `PoseClient` split (165 lines rewritten), a slimmer worker protocol, `useModule: true` in the worker, copying only the module variant of WASM, and `immutable` headers on Vercel.

- **`PoseClient` (`src/cv/poseClient.ts`)** — testable in Node with stubs, moderate effort. In the `node` environment, `import.meta.env.BASE_URL` resolves (Vitest injects `import.meta.env`); `vi.stubGlobal` would be needed for `Worker` (a fake class that emits `onmessage` with `READY`/`ERROR`/`POSE`), `location` (`location.origin`, used in `poseClient.ts:11-16`), `window` (the 30-second timeout's `setTimeout`, `poseClient.ts:132`, controllable with `vi.useFakeTimers`), and `fetch` (for `warmVisionAssets`, `poseClient.ts:34-37`). Testable behavior includes: `init()` idempotency through `initPromise` (lines 43-48), `beginCapture` is a no-op before `ready` (line 52), fatal `ERROR` → `dispose()` (line 116), `pauseCapture` clears `busy` (lines 77-85), and `dispose` posts `DISPOSE` + `terminate()` + resets `initPromise` (lines 87-97). **Assessment:** this is real logic rewritten in the PR, but it is orchestration glue; AGENTS.md describes the CV path as manually verified ("The CV worker path has no automated coverage — verify camera flow manually"), and covering the capture loop would require increasingly broad stubs (`createImageBitmap`, `requestAnimationFrame`/`requestVideoFrameCallback`, `HTMLMediaElement.HAVE_CURRENT_DATA`). **Suggestion: optional, low priority** — if added, limit it to the `init`/`beginCapture`/`pauseCapture`/`dispose` state machine with a roughly 50-line `FakeWorker`; do not attempt the frame path. This is not required to address the review comment.
- **`pose.worker.ts` (`useModule: true`, `pose.worker.ts:12`)** — testable only with a real worker; would require Vitest Browser Mode or Playwright (neither is in the repo). `docs/analise-de-gargalos.md` already recommends an `INIT` smoke test — outside the scope of the `node` suite.
- **`scripts/copy-mediapipe-wasm.mjs`** — a Node script (could run in Vitest), but it is exercised on every `prebuild`/`predev` and fails noisily; marginal value.
- **`actionPipeline.ts` (removal of `kinematicsMs`) and `protocol.ts`/fixtures (type slimming)** — structural changes, not rule changes; existing tests already consume `.events` (`tests/kinematics.test.ts:83,94`) and `tsc -b` covers type compatibility.
- **`vercel.json` / README / AGENTS.md** — configuration and documentation; no test needed.

---

## Sources

- Vitest, *Test Environment* — `node` is the default environment; `jsdom`/`happy-dom` emulate browser APIs through packages: https://vitest.dev/guide/environment.html
- three.js, *WebGLRenderer* — "This renderer uses WebGL 2… WebGL 1 is not supported since r163": https://threejs.org/docs/pages/WebGLRenderer.html
- Local three 0.187 code: `node_modules/three/build/three.module.js:16224-16246` — only tries `getContext('webgl2')` and throws `THREE.WebGLRenderer: Error creating WebGL context.` if it gets `null`.
- jsdom, open issue *Implement WebGL* (#3617) — `canvas.getContext('webgl')` returns `null` in jsdom: https://github.com/jsdom/jsdom/issues/3617
- headless-gl (`gl`) — conformant WebGL 1.0.3; experimental WebGL2 through `createWebGL2Context`, without validation against the 2.0 conformance suite: https://github.com/stackgl/headless-gl
- Repo rule: AGENTS.md — "Detectors in `src/kinematics/` must stay pure (no DOM/Three.js imports)" and "Add a test for every new detector behavior or gameplay rule change".
