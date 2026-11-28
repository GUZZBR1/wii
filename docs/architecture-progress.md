# Architectural Refactoring Progress

This is the living record of the product's requested architectural improvement rounds. The work preserves existing behavior and contracts, migrates callers in the same batch, and removes replaced implementations when compatibility allows.

## Initiative status

- **Current branch base:** `origin/main` at `241a8c3`, with PR42 (#42), boxing (#44), menu rotation (#46) and menu polish (#47) integrated; work is in the isolated `refactor/canonical-frame-capture` worktree.
- **Active-state survey:** PR42 and local worktrees/orchestrations were compared; unreviewed local changes were preserved and not copied.
- **Shared checkout state:** local changes outside this worktree are preserved and are not part of this round.
- **Applied skills:** `codebase-design` and `domain-modeling`.
- **Existing glossary/ADRs:** none exist on this base. Create a glossary when a domain term needs clarification; record architectural decisions with lasting trade-offs in `docs/adr/`.

## Architecture map — `origin/main` base

### Main flow

```mermaid
flowchart LR
  Browser[Browser: webcam, storage, DOM] --> Site[src/main.tsx + src/app/App.tsx]
  Site --> ArenaShell[src/components/ArenaShell.tsx]
  ArenaShell --> Arena[src/App.tsx: camera and game orchestration]
  Arena --> AppAdapters[src/cv: local assets and browser adapters]
  AppAdapters --> Core[@nevergear/spatial-core]
  Core --> Workers[Pose and hand module Workers]
  Workers --> MediaPipe[Local MediaPipe WASM and task models]
  Core --> Snapshots[PoseSnapshot / HandSnapshot]
  Arena --> Calibration[src/cv/adaptiveCalibrator.ts]
  Snapshots --> Kinematics[src/kinematics: pure detectors]
  Kinematics --> Events[SportActionEvent / ContinuousControls]
  Events --> GameCanvas[src/ui/GameCanvas.tsx]
  GameCanvas --> Games[src/games: Track and Tennis]
  Games[Track, Athletics, Tennis, Boxing] --> Loop[src/games/core/GameLoop.ts]
```

`src/app/App.tsx` is the website router and page shell; `src/App.tsx` is the camera and arena coordinator. The similar names describe separate modules and are an ongoing source of navigation cost.

### Modules and ownership

| State or rule | Current owner | Readers and important constraints |
| --- | --- | --- |
| Camera stream, UI mode, camera attempt and vision activation | `src/App.tsx` | Starts/stops the browser stream and chooses hand or pose capture. `cameraAttemptRef` invalidates physical camera sessions; `visionActivationRef` invalidates detector activations, including hand→pose→hand. |
| Pose worker, request IDs, capture epoch | `packages/core/src/providers/poseClient.ts` | Owns the pose Worker, frame correlation, capture callbacks and pose protocol. `VideoFramePump` owns scheduling and single-flight; the pose bitmap is transferred to the worker. |
| Hand worker, capture and in-flight frame | `packages/core/src/providers/handClient.ts` | Owns the hand Worker, worker request correlation, resizing and live capture. `processFrame` closes rejected bitmaps and transfers accepted ones; the shared pump owns scheduling and single-flight. |
| App hand adapter | `src/cv/handClient.ts` | Supplies versioned local asset URLs and asset warming. It no longer implements a second capture scheduler. |
| Alternate provider switching | `packages/core/src/runtime/spatialRuntime.ts` | Owns a provider generation. It delegates live capture to providers that support it; each processFrame-only hand activation owns a separate pump. It is exported and tested, but no production caller was found. |
| Calibration and action history | `src/App.tsx`, `src/cv/adaptiveCalibrator.ts`, `src/kinematics/*` | The coordinator owns long-lived instances; pure detectors own their local filters and timing windows. `adaptiveCalibrator.ts` consumes kinematics helpers; the reverse type dependency was removed in round 2 by importing contracts from `@nevergear/spatial-core`. |
| Three.js renderer, fixed-step clock and shared scenery | `src/games/core/GameLoop.ts`, `src/games/core/scenery.ts` | Game instances own their scene objects; shared game primitives live under `games/core` rather than a single sport. |
| Rules and match state | `src/games/track/*`, `src/games/athletics/*`, `src/games/tennis/*`, `src/games/boxing/*` | Pure rules have direct deterministic tests; rendering is owned by each game class. Cross-game imports remain in the backlog for a dedicated ownership pass. |
| Website and menu state | React modules under `src/app`, `src/components`, `src/pages`, `src/ui` | Local UI state stays in React. The language provider owns selected language. |
| Browser persistence | `src/lib/quality.ts`, `src/App.tsx`, `src/i18n.tsx`, legacy `TrackGame.ts` | Local storage holds quality preference, mute, language and obstacle-course records. There is no server-side user store. |

### Contracts, infrastructure, and production constraints

- There is no backend API, authentication service, or remote application data store. The product deploys as static Vite assets; browser permission controls camera access.
- Worker messages and `PoseSnapshot`/`HandSnapshot` types live in `packages/core/src/providers/` and `packages/core/src/types.ts`. `src/cv/protocol.ts` is a one-line re-export used by many app modules; it does not define a competing protocol.
- `src/cv/mediapipeAssets.ts` pins local model hashes and the WASM version. App adapters construct versioned local URLs and warm assets. The workers fetch the local model files; video frames stay on-device.
- `vite.config.ts` maps `@nevergear/spatial-core` to source in app/dev mode. Tests resolve the built workspace package; `pretest` builds it first. This is intentional and verified by the workspace/package setup.
- The browser-facing errors include camera acquisition, worker initialization (30-second timeout), worker errors and GPU-to-CPU fallback. Site article failures are logged at the app error boundary. Developer CV recordings/replays live under `src/cv/diagnostics` and `scripts/`.
- CI (`.github/workflows/ci.yml`) runs `npm ci`, tests, Biome lint, production build and article validation. A scoped Biome override now enforces the purity/import direction of `src/kinematics`; other ownership and dependency rules remain in the backlog.
- There is no shared theme package: site and arena styling have separate CSS entry points. The design system and accessibility contracts remain to be audited before any visual consolidation.

## Round 1 — frame capture

### State and concurrency checklist

| Item | Migration decision/observed state |
| --- | --- |
| Owners | `App` remains the owner of the `MediaStream` and sport. Each provider remains the owner of its Worker, request IDs and protocol. The new pump owns only capture scheduling and backpressure. `SpatialRuntime` remains the owner of provider generation. |
| Readers/writers | `PoseClient`, the `HandClient` adapter and `SpatialRuntime` start/stop capture. Only the pump registers/cancels rVFC/rAF and holds the scheduled processing slot. |
| Lifetime | Each client, or each activation of a legacy runtime adapter, owns one pump. `pauseCapture` cancels scheduled callbacks; `dispose` also shuts down the client/worker. Pausing and resuming the same worker does not reset the temporal sequence. |
| Buffers | The pump does not create or retain an `ImageBitmap`. The provider/adapter creates the copy, closes it if the session becomes stale, and transfers ownership to the Worker through `postMessage`; after transfer, the caller cannot mutate or close the buffer. |
| Invalidation | The pump uses a private generation for scheduler callbacks. `cameraAttemptRef`, `PoseClient.captureEpoch`, the hand session counter and `SpatialRuntime.generation` keep their existing meanings. Each legacy activation gets its own pump, so pending work from one adapter cannot block the next. |
| Commit point | The Worker accepts the frame when `postMessage(FRAME, [bitmap])` returns. The pump slot is released only when that frame's result/error settles or the client is disposed. |
| Ordering/progress | One frame is processed per pump; there is no queue. The next video frame is scheduled but dropped while the slot is busy. A copy/processing error is reported and releases the slot for future frames. |
| Exceptions | `createImageBitmap` and processing failures reach the error callback. The client continues to handle fatal Worker errors. The pump does not silently retry a fatal error. |

### Work and evidence

- [x] Deterministic pre-migration baseline: `npm test -- tests/poseClient.test.ts tests/handClient.test.ts tests/handCapture.test.ts tests/spatialRuntime.test.ts` — 4 files and 17 tests passed; the 5 quality tests passed as well.
- [x] Independent review of three interfaces: capture through a minimal callback, configurable generic pump and interface optimized for the common caller.
- [x] Implement one pump and migrate all three scheduling paths.
- [x] Preserve the public `HandClient.processFrame` method and the `SpatialRuntime` adapter contract for implementations that only provide `processFrame`.
- [x] Add deterministic tests for backpressure, session changes, rAF fallback, errors, reentrant pause and synchronous throws.
- [x] Remove superseded duplicate loops and review callers with a deletion test; the search confirmed that rVFC/rAF for all three paths now appears only in the pump.
- [x] Run the full suite, lint and build; after fixes, the independent review of the two identified risks was complete.

### Verification and result

- Full suite with existing local recordings temporarily linked into the worktree (without copying them): `npm test` — 54 files and 440 tests passed; the link was removed afterward.
- Production build: `npm run build` — passed. Vite still reports the pre-existing warning about chunks over 500 kB.
- Lint: `npm run lint` — exit 0, with 28 existing CSS warnings. The eight changed files passed an isolated Biome run without warnings.
- Articles: `npm run check:articles` — passed (5 PT articles, 5 EN articles and figures in the bundle).
- `git diff --check` — passed.
- An independent review found and led to fixes for two regressions: reentrancy in `PoseClient.beginCapture` and bitmap closure when a runtime adapter throws synchronously. The second review found no other concrete issues.

## Round 2 — kinematics dependency boundary

### Change

- Modules in `src/kinematics` import pose/calibration contracts directly from `@nevergear/spatial-core`, removing their type dependency on the `src/cv/protocol.ts` re-export and, with it, the source cycle with `src/cv/adaptiveCalibrator.ts`.
- A Biome override scoped to `src/kinematics/**` rejects imports from CV/adapters, UI, games, pages, React, Three.js and MediaPipe. It also blocks DOM, video, canvas, worker and animation globals.
- Core imports are limited to data contracts, `OneEuroFilter` and pure detectors already canonical in the package (such as `RotationalFlickDetector`); the mixed barrel is not open to providers and browser runtime code.
- Restricted internal imports use patterns that cover different nesting depths. The rule also blocks reads of the global clock: `kinematicsMs` had no consumers and was removed; `ActionPipeline.reset(timestampMs)` now receives the timestamp from its coordinator.
- The rule uses the installed Biome AST parsers and the lint command run by CI; no dependency or second checking tool was added.

### Verification

- [x] `npx biome lint src/kinematics` passed without warnings.
- [x] Temporary fixtures confirmed that Three.js, relative CV imports at current and nested directory depths, games, DOM globals and the core `PoseClient` export are rejected; the fixtures were removed.
- [x] Full suite with existing local recordings: `npm test` — 54 files and 440 tests passed; temporary links were removed after testing.
- [x] `npm run build` and `npm run check:articles` passed; Biome passed with 28 existing CSS warnings and no warnings in the kinematics folder; `git diff --check` passed.
- [x] Independent review confirmed the nested patterns and explicit clock, with no new findings or false positives.

## Round 3 — late fatal Worker errors

### State and ordering invariants

| Item | Decision/observed state |
| --- | --- |
| Owners | Each `PoseClient`/`HandClient` owns its Worker and `inFlight` state; the Worker owns the Landmarker and decides when inference/fallback has made the Worker unusable. |
| Readers/writers | Workers send frame replies and may later send the fallback-attempt result. Clients read both from the same message queue; a frame reply does not end the Worker's lifecycle. |
| Lifetime | A Worker is considered current only while it still matches `this.worker`; `dispose()` invalidates the client, closes the Worker and releases any pending request. |
| Buffers | The bitmap is transferred through `postMessage(FRAME)` and closed by the Worker. A later fallback error does not return or change bitmap ownership. |
| Invalidation | Recoverable errors still require the current request (`requestId` and `captureEpoch` for pose, `requestId` for hand). A fatal Worker error is not rejected by frame correlation because it describes the Worker's overall health. |
| Commit point | Receiving a fatal error from the still-active Worker shuts down the provider and reports the error, even if `POSE`/`HAND` already released the frame or a later frame is in flight. |
| Progress | On shutdown, the client settles the pending request and stops capture; recoverable errors release only the correlated request and allow future frames to continue. |
| Exceptions | The fatal message preserves status for the UI; the callback is captured before `dispose()`, which clears the internal callbacks. |

### Change and verification

- The latency fallback posts a result (`POSE`/`HAND`) and may fail later while initializing CPU. The audit confirmed that both clients discarded the late fatal error because they required its request to remain `inFlight`. When rebased onto current main, `PoseClient` already invalidated the active Worker; that behavior was preserved and gained an explicit regression test. `HandClient` still discarded the late fatal error.
- Deterministic tests were added that first reproduce the result, start another frame in flight, and then deliver the old fatal error. Both failed on the original batch parent; on current main, the pose case already passed and the hand case required the fix.
- `PoseClient` preserves main's existing behavior and its new regression test; `HandClient` now treats a fatal error as a condition of the active Worker and releases any remaining request. Non-fatal errors retain ID/epoch validation.
- Workers retain their specific protocols and configuration. The audit does not recommend a generic Worker abstraction; whether to extract only the fallback state machine remains open until costs and transitions are compared.
- Full suite: 54 files and 442 Vitest tests passed; the five Node quality tests passed as well. Replays used only existing local JSON files, temporarily linked and removed from the worktree after the run.
- `npm run build`, `npm run check:articles`, `npx biome lint src/kinematics` and `git diff --check` passed. `npm run lint` passed with 28 existing CSS warnings; no new warnings appeared in kinematics.
- Independent review of the case with a newer frame pending found no concrete issues.

## Round 4 — vision activations and camera lifecycle

### Invariants before implementation

| Item | Decision/observed state |
| --- | --- |
| Owners | `App` owns the camera stream and selects the sport; each client owns its Worker and may still be initializing after `pauseCapture()`. |
| Readers/writers | `startCamera`, the screen-change effect and Pose/Hand callbacks/promises read or update camera state. `HandClient` may report an error and then reject initialization. |
| Lifetime | The stream stays live when switching hand↔pose; clients/Workers are reused, and pausing capture does not cancel pending initialization. |
| Buffers | Switching activations does not change `ImageBitmap` ownership or transfer; each provider keeps its current contract. |
| Invalidation | `cameraAttemptRef` continues to invalidate the physical session. `activateVisionMode` advances `visionActivationRef` during transitions and invalidates prior callbacks, catches and capture starts, including the hand→pose→hand cycle. `screenRef` closes the gap before the React effect runs. |
| Commit point | Only callbacks and failures belonging to the still-current activation may change camera state; stream failure still ends the session regardless of sport. |
| Progress | The current activation starts its provider once a stream exists, even if initialization started for a previous sport fails. The React effect is the authority for starting the current session/activation pair. |
| Exceptions | An error from the active provider ends the camera as before; a stale provider error is ignored without stopping tracks or active capture. `getUserMedia`/video failures continue to be reported. |

### Change and verification

- `activateVisionMode` centralizes active-mode changes; `isCurrentVisionActivation` checks the camera attempt, vision generation, active sport and requested screen. The camera session remains attached to the new sport; failures from the old provider are isolated.
- `captureStartedRef` makes the React effect start capture once per `{cameraAttempt, visionActivation}` pair. The effect also runs when `cameraOn` changes, so a screen change during `getUserMedia` still starts the provider for the current screen once the stream is ready.
- `startCamera` starts the provider in parallel with `getUserMedia` but observes its rejection immediately. Only provider failures from the current activation end the camera; stream and video errors continue to end the physical attempt.
- Asynchronous `startHandCapture`/`startPoseCapture` failures from the current activation also end the camera. This covers `PoseClient.init()` rejecting without a status callback; without this rule, the camera stayed on without tracking and no retry.
- Removed `observeEarlyRejection.ts` and its test: the only caller now attaches Promise handling directly when creating it, without retaining a Promise for a later `await`.
- Five deterministic tests cover: hand init error after switching to pose; late fatal hand Worker error; hand error while `getUserMedia` is pending followed by pose startup; hand→pose→hand with an old frame; and pose init rejection without a status callback.
- The first interleaving test and the silent Pose rejection test were run before the fix and failed on the stream/capture assertion, confirming the specific regression signal.
- Full suite with existing local recordings: `npm test` — 54 files and 446 Vitest tests passed; the five Node quality tests passed as well. JSON files were temporarily linked into the worktree, and the link was removed afterward.
- `npm run build`, `npm run lint`, `npm run check:articles`, `npx biome lint src/App.tsx tests/appVisionMode.test.tsx src/kinematics` and `git diff --check` passed. Global lint retains 28 existing CSS warnings; the changed files produce no isolated warnings. The build still reports the chunk warning above 500 kB.
- Final independent review found no issues after fixing the case where Pose initialization rejects without publishing a status.

## Round 5 — isolate legacy work by generation

### Invariants

| Item | Decision/observed state |
| --- | --- |
| Owners | `SpatialRuntime` selects and invalidates providers by `generation`; each pump serializes work for a single legacy-adapter activation. |
| In-flight work | Legacy `processFrame` adapters have no cancellation contract. The runtime ignores their result after a switch and does not wait for the old Promise before advancing to a new generation. |
| Commit | Each hand activation that only uses `processFrame` creates a new pump; `disposeActive()` stops and releases the current pump reference. An old completion releases only its own pump slot. |
| Buffer | The copy created by the runtime remains under the `processFrame` ownership contract; if the generation becomes stale before the call, the runtime closes the bitmap. |

### Change and verification

- Independent review found that the shared pump kept `inFlight` after `stop()`. A legacy adapter with a pending Promise permanently blocked the next generation's adapter.
- The deterministic test reproduced the failure without sleeps: it keeps old `processFrame` pending, switches hand→pose→hand and confirms that the new adapter receives its first frame. The old result is resolved later and remains unpublished.
- The test failed before the fix and passed after creating one pump per legacy activation. `npm test -- tests/spatialRuntime.test.ts tests/videoFramePump.test.ts`: 12 tests passed; the five Node quality tests passed.
- The one-frame-in-flight guarantee remains within each pump, including when restarting the same pump; different generations no longer share a slot.

## Round 6 — ownership of shared scenery

### Change

- `createSkyDome` was implemented in `games/track/scenery.ts` and called by Track, Athletics and Tennis. Its location made the other games depend on the legacy obstacle-course module.
- The implementation moved to `games/core/scenery.ts`; all three games use the shared helper, and `games/track/scenery.ts` keeps only Track-specific objects.
- The other cross-imports remain in the backlog for individual review: `Feedback`, `RunGate` and `MiiRunner` have different semantics and owners, and were not moved based on similar names alone.

### Verification

- `npm test`: 97 Vitest files and 926 tests passed; the five Node quality tests passed as well. Replays used the 14 existing local recordings through a temporary symlink, removed after the run.
- `npm run build`, `npm run check:articles`, focused lint of changed files and `git diff --check` passed. `npm run lint` passed with 35 CSS warnings in unchanged files; the build still reports the chunk warning above 500 kB.
- Two independent reviews of the full diff found no concrete issues; they checked camera lifecycle, generation-based capture and extraction of the scenery helper.

## Round 7 — close gaps found in the PR #49 review

### Changes

- rVFC and rAF callbacks check the generation before clearing a handle or updating `lastVideoTime`. The capture test includes a restart during batched callback delivery and requires `stop()` to cancel the new handle.
- The `noRestrictedImports` rule now blocks both private package subpaths and relative imports into `packages/core/**` from kinematics. The `@nevergear/spatial-core` barrel still allows only the listed contracts.
- A probe with a temporary file confirmed that the private relative import fails and the public `PoseSnapshot` import passes; the temporary fixture was removed.

### Verification and limitation

- The scheduler test failed before the fix and passed afterward. `npm test` passed with 97 Vitest files, 928 tests and five Node tests, using only existing local recordings through a temporary symlink removed at the end.
- `npm run build`, `npm run lint`, `npm run check:articles`, focused lint and `git diff --check` passed. Global lint retains 35 CSS warnings in unchanged files; the build still reports chunks above 500 kB.
- The real webcam check required by `AGENTS.md` has not been done: this environment has no browser installed and no `/dev/video*`. The PR reports this limitation; it needs verification on a machine with a webcam.

## Improvement cycle

Each batch ends with migrated code, a test at the appropriate interface, safe removal of the replaced implementation, regression guardrails where applicable and its own commit. The ordered list and pending decisions live in [architecture-backlog.md](architecture-backlog.md); decisions that meet the ADR criteria belong in `docs/adr/`.
