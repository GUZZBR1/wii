# Integration Plan: GUZZBR1 Website + Santleme's Nevergear

## Confirmed scope

Keep the website in this repository and use the current `santleme/nevergear` implementation in the `/app` area. Preserve the website's pages and content. The arena uses `src/App.tsx`, `src/games`, `src/cv` and `packages/core`; there will be no second engine under `site/`.

## Execution

1. **Update upstream — complete.** The fetch confirmed `19c2980`, including PR #26 (MediaPipe CPU fallback). Local `main` and the fork's `main` were synchronized by fast-forward.
2. **Integrate running — complete on the integration branch.** PR #24's work is included, preserving coins, countdown, tracking-based pause, ranking and restart, alongside tennis from PR #23. History was preserved through a merge, without rewriting published commits.
3. **Connect the website to the game — complete on the integration branch.** The website was moved to the root app. The `/app` route loads the original arena through `ArenaShell`; exit returns to the website and unmounts the game. The engine/test copy under `site/` was removed. The camera, workers and games keep their original owners; only arena CSS was isolated to avoid affecting other routes.
4. **Consolidate build and deployment — complete on the integration branch.** One `package.json`, lockfile, workflow and `dist` serve both website and arena. Vercel uses the repository root and rewrites direct visits to website routes while preserving asset paths.
5. **Verify — complete; publication in progress.** Run `npm test`, `npm run lint`, `npm run build` and `npm run check:articles`; update PR #25 with the final implementation and evidence.
6. **Clean up branches — after merge into the target.** Preserve branches and worktrees with unintegrated changes. Do not delete branches for open PRs.

## Evidence and limitations

- 369 tests passed with parallelism limited to two workers to avoid concurrency timeouts in the local environment.
- The build and integrity checks passed for all five PT articles, five EN articles and figures.
- Chromium smoke test: direct routes, website → game → website, running/tennis by keyboard, 320 px width, simulated camera stopped on exit, and a delayed permission stream discarded. No JavaScript errors; body styles were identical before and after the arena.
- A physical webcam was not tested; the camera test uses a synthetic stream and a simulated worker.
- Builds retain the large-chunk warning; the website's existing CSS has lint warnings for specificity and `!important`.
- Image-rights follow-ups remain recorded in `public/images/archive/SOURCES.md`.
- Publishing the PR does not mean a merge or production deployment. The account has read-only access to upstream; integration into its `main` depends on the maintainer.
