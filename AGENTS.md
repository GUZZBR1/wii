# Repository Guidelines

## Project Structure & Module Organization

This workspace currently contains no application source, tests, assets, or documentation tree. Keep new code in clearly named top-level directories that match its purpose (for example, `src/`, `tests/`, `docs/`, and `assets/`). Group modules by feature or responsibility, and place tests near the code or in a matching test directory. Update this guide when the project structure is established.

## Build, Test, and Development Commands

No build system, dependency manifest, or runnable project scripts are present yet. Before adding a toolchain, document its setup and standard commands in the project README and this guide. Use the repository's declared scripts for local development and CI; do not assume a command such as `npm test` applies unless the corresponding configuration exists.

## Coding Style & Naming Conventions

No language or formatter configuration is present. Follow the conventions of the language and framework selected for the project, and add formatter and linter configuration alongside the initial source code. Use descriptive, consistent names; prefer lowercase kebab-case for general file and directory names unless the language ecosystem has a standard convention.

## Testing Guidelines

No test framework or coverage target is configured. Add tests with new behavior and bug fixes, use names that identify the behavior under test, and document the command contributors should run. Keep tests deterministic and independent of external services where practical.

## Commit & Pull Request Guidelines

Git history is unavailable in this workspace, so no existing commit convention can be confirmed. Use short imperative commit subjects (for example, `Add initial project structure`) and keep each commit focused. Pull requests should explain the change and its motivation, link related issues when available, and include screenshots for user-visible interface changes. Note the commands run and any follow-up work.

## Security & Configuration

Keep credentials and machine-specific settings out of version control. Provide an example configuration file with placeholder values when the project needs environment variables, and document required secrets through the project's approved secret-management process.
