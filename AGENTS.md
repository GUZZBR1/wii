# Repository Guidelines

## Project Structure & Module Organization

Nevergear Web Sports Arena — a Vite + React 19 + TypeScript browser arcade with Athletics, Tennis, Boxing, and a three-sport Iron Man challenge. Body pose from the webcam drives the sports; Boxing also supports keyboard controls. No backend; deploy is a static `dist/` on Vercel.

Site and game UI text is bilingual (Portuguese and English). `src/i18n.tsx` prefers a saved choice, then the browser's first supported language, and falls back to English. `docs/` is maintained in English. Published research articles have separate language sources under `src/data/articles-en/` and `src/data/articles-pt/`.

### Language and localization

- Write all developer-facing project text in English, including documentation, agent instructions, research notes, code comments, diagnostics, and tool messages. Keep established Portuguese filenames when renaming them would break links; the file contents still belong in English.
- Site and game text shown to players must be available in Portuguese and English. Use `useLang()` / `tr()` in React and `gameText()` or the game's language setter in game code; add regression coverage for new language behavior.
- Keep state and protocol values language-neutral. Translate display text at the UI boundary so tracking and gameplay logic never depend on localized labels.

- `packages/core/` — `@nevergear/spatial-core`, the headless perception package the app is built on: pose/hand workers (`providers/pose.worker.ts`: MediaPipe Pose Landmarker in a module Web Worker, GPU→CPU fallback), the warm-worker clients (`providers/poseClient.ts`: `init` / `beginCapture` / `pauseCapture` / `dispose`, one frame in flight), the worker protocols and snapshot types (`providers/poseProtocol.ts`, `types.ts`), the 1-Euro filter (`filters/oneEuroFilter.ts`), pose replay, and the hand/gesture and spatial-runtime modules. Built to `dist/` by `npm run build:core`; outside tests the app resolves the package source through the Vite alias in `vite.config.ts`, while tests resolve the built `dist/` (which is why `pretest` builds core first).
- `src/cv/` — the app's thin pose wiring over `@nevergear/spatial-core`: `poseClient.ts` / `handClient.ts` (subclasses injecting local asset URLs and warming them), `delegate.ts` (CPU by default, `?delegate=gpu`), `protocol.ts` (one-line re-export of core types), `adaptiveCalibrator.ts` (implicit online calibration), and `mediapipeAssets.ts` (versioned local WASM/model URLs and asset warm-up; pinned versions and hashes live in `src/lib/mediapipe.ts`). `diagnostics/` contains developer tools, enabled in development or with `?debug` / `?fotos`: `poseRecorder.ts`, `recordingScript.ts`, `photoTrail.ts`, and `flags.ts`.
- `src/kinematics/` — pure, testable detectors over `PoseSnapshot`. `handCursor.ts` / `handSwipe.ts` drive the menu hand cursor and sideways swipe; `actionPipeline.ts` produces `SportActionEvent`s and effort signals; `torsoVertical.ts` is the shared upper-body channel (shoulders required, hips not); intensity drives Athletics, swing detection drives Tennis, and punch, guard, dodge, and footwork detectors drive Boxing. Bounce, walk, jump, cadence, and lane-posture detectors serve the legacy obstacle course.
- `src/games/` — `core/GameLoop.ts` (fixed 1/60 timestep, Three.js renderer, disposal helpers) plus Athletics, Tennis, Boxing, and the legacy `track/` obstacle course. Shared modules in `games/core/` include the run gate, HUD envelope, and vertex-color utilities. Athletics and Tennis are body-controlled; Boxing supports body and keyboard input.
- `src/perception.ts` — owns the frame-to-game chain: adaptive calibration, `ActionPipeline`, context classification, tracking state, pose overlay, and engine setters. `App.tsx` owns camera lifecycle, recordings, audio, and screens.
- `src/data/articles-en/` and `src/data/articles-pt/` — published article Markdown in both languages; Portuguese figure sources live alongside the Portuguese articles.
- `src/ui/` — `GameCanvas` (lazy-loads a game per sport), `CameraPip` (video PiP + overlay), `PoseOverlay` (2D skeleton draw).
- `tests/` — Vitest, synthetic pose fixtures, and deterministic detector tests. `tests/recordings/` (gitignored, personal data) holds optional real recordings used by track, tennis, and boxing replay tests; those tests skip when recordings are absent, including in CI.
- `scripts/` — `copy-mediapipe-wasm.mjs` (prebuild/predev): pins tasks-vision, copies only the **module** WASM variant to `public/mediapipe/wasm-<version>/`, verifies the model SHA-256 against `SHA256SUMS`, and checks that pins in `src/lib/mediapipe.ts` match (version-addressed URLs make `immutable` caching safe). `research-figures/` generates article figures: Portuguese output goes to `src/data/articles-pt/figures/`, English output to `docs/research/figures/en/`. Manual browser tools include `pose-bench.html`, `hand-bench.html`, `dropout-bench.html`, and the pose-replay trio (`pose-replay.html`, `pose-replay.ts`, `poseReplaySession.ts`, `poseReplayVideo.ts`).
- `public/mediapipe/` — three tracked models (filenames carry their hash): `pose_landmarker_lite.<sha8>.task`, `pose_landmarker_full.<sha8>.task`, `hand_landmarker.<sha8>.task` + WASM files (gitignored, generated by the script).
- `docs/` — start at `docs/README.md` (index) and `docs/jogos-pelo-corpo.md` (current games, technique, measurements, what is left). Older analysis notes: `analise-de-gargalos.md` (bottleneck audit), `auditoria-mediapipe.md` + `pesquisa-pipeline-cv.md` (MediaPipe/CV deep-dive — read before touching the pose pipeline).

## Build, Test, and Development Commands

```bash
npm ci            # install (Node 24 LTS / npm 11, see .nvmrc)
npm run dev       # vite dev server (predev copies MediaPipe WASM)
npm test          # vitest run
npm run build     # tsc -b && vite build
npm run preview   # serve dist/
npm run lint      # biome lint .
npm run format    # biome format --write .
```

Camera access needs HTTPS in production; `localhost` works in development. Athletics and Tennis use body input; Boxing supports body and keyboard controls. The legacy obstacle course is outside the menu and also has keyboard controls.

## Coding Style & Naming Conventions

- TypeScript strict (`tsconfig.json`); Biome 2.x is the linter/formatter (`biome.json`) — run `npm run lint` before committing.
- Detectors in `src/kinematics/` must stay pure (no DOM/Three.js imports) so tests keep working with synthetic fixtures.
- Game code owns its Three.js objects: dispose via `disposeObjectTree` (`src/games/core/GameLoop.ts`).
- Worker protocol changes go through `packages/core/src/providers/poseProtocol.ts` (re-exported by `src/cv/protocol.ts`) — keep `WorkerRequest`/`WorkerReply` and `PoseSnapshot` in sync with `packages/core/src/providers/pose.worker.ts` and `packages/core/src/providers/poseClient.ts`.
- TypeScript modules are camelCase (`poseClient.ts`, `trackScore.ts`); classes and React components are PascalCase (`PoseClient`, `GameCanvas.tsx`, `TrackGame.ts`). Scripts, docs, and config files are kebab-case (`copy-mediapipe-wasm.mjs`).

## Testing Guidelines

- `npm test` runs `tests/**/*.test.{ts,tsx}` under Vitest (node environment). Add a test for every new detector behavior or gameplay rule change.
- While iterating, run only the tests that cover the touched module (`tests/trackScore.test.ts` for track scoring, etc.); the final gate stays the full suite plus `npm run lint && npm run build`.
- The CV worker fallback path has automated coverage (`tests/poseWorkerFallback.test.ts`, `tests/poseClient.test.ts`), but the real camera flow does not — `vite` serves a real browser worker; verify camera flow manually (`npm run dev` → ENABLE CAMERA → TRACKING) and measure per-frame latency with `scripts/pose-bench.html` (`npm run build && cp scripts/pose-bench.html dist/bench.html && npm run preview` → `/bench.html`).

## Change Philosophy

The guiding style draws on *The Tao of Programming*, KISS, and YAGNI: make behavior, ownership, and invariants easy to see, and choose the smallest complete design. These are simplicity heuristics, not a contest to minimize line count.

- **No code golf.** A short diff is useful when it reduces concepts and makes the design easier to understand. Collapsing branches or hiding control flow does not help.
- **Avoid routine docs-only and whitespace-only changes.** A requested update to repository instructions is a valid standalone change when it materially improves how the project is developed or reviewed.
- **Benchmark performance claims.** Measure old and new behavior on a representative workload and report setup, baseline, and percentiles — `scripts/pose-bench.html` measures end-to-end per-frame latency in the real worker (frame post → POSE reply, inference plus worker comm) for CV claims. Profile before optimizing; weigh a marginal speedup against maintainability, memory, and latency cost.
- **Keep changes reviewable and independently useful.** Give each PR one clear purpose, keep it based on `main`, green on `npm test && npm run lint && npm run build`, and independent of other open PRs. A prerequisite refactor is welcome when it is a clear improvement by itself.

What's welcome:

- **Bug fixes** with a regression test that fails before the fix and passes afterward.
- **Features** with regression coverage proportional to their implementation and maintenance cost.
- **Refactors** that clearly improve readability, ownership, or invariants. Whitespace churn or moving functions without a better design are not wins.
- **Non-brittle, deterministic tests** — no `setTimeout` races in assertions.
- **Dead-code removal** after checking real callers (fields, flags, and helpers with no consumer).

## State and Concurrency Changes

Before changing shared state or worker↔main boundaries (`packages/core/src/providers/poseProtocol.ts`, `packages/core/src/providers/poseClient.ts`, `packages/core/src/providers/pose.worker.ts`, camera lifecycle in `App.tsx`, `GameLoop` timing), write down: state owner, readers and writers, object lifetime, buffer aliases, invalidation epochs/generation tokens (`cameraAttemptRef`, frame seq), commit points, ordering guarantees, progress requirements, and exception policy. Keep this proportional to the change — the checklist is not a reason to add tokens without need.

- A stale-work check at publication does not undo mutations made earlier — `stale()` cannot un-resolve a late `getUserMedia`; stop the late stream's tracks at the boundary instead.
- Make concurrency regressions deterministic: control the interleaving with resolvable promises or fake timers paused before the shared mutation — not `setTimeout` sleeps.
- Structured clone and transferables don't make data immutable: a transferred `ImageBitmap` is neutered, not frozen. State whether frame buffers are copied, transferred, or promised not to change while in use.
- Give every generation/revision token a distinct invalidation meaning; do not add a counter when an existing epoch already covers that change.
- Extract a collaborator only when its inputs, outputs, and state ownership become clearer — a helper that still reaches into and mutates its parent's state has not created a useful boundary.

## Commit & Pull Request Guidelines

Short imperative subjects (`Add initial project structure`), one logical change per commit. PRs explain the change and motivation, link issues when available, and list the commands run for verification. Always open pull requests against `santleme/wii` (`upstream`) targeting `main` (from the `GUZZBR1` fork branch), rather than `GUZZBR1/wii` (`origin`), unless explicitly asked otherwise.

## Security & Configuration

- Video is processed on-device; nothing is uploaded. The MediaPipe runtime may phone performance metrics to Google — disclosed in README/THIRD_PARTY_NOTICES.
- No secrets in this repo. Machine-specific config belongs in `~/.config`, never in project files.
