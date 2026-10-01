# Changelog

## [Unreleased]

### Added

- The `/init` extension (`src/extensions/init/`): the `/init` command asks the model to analyze the codebase and create `PI.md` (pi's counterpart of Claude Code's `CLAUDE.md`) at the root of the current working directory — or, when `PI.md` already exists, to review it and suggest improvements instead of overwriting. A `before_agent_start` handler also auto-loads `<cwd>/PI.md` into every agent run by appending it to the system prompt's context files, so upstream renders it through the same `<project_instructions>` block as `AGENTS.md`. Registered by both the CLI wrapper and the SDK entry.

### Changed

- The pi-plus sources split into three packages: this package (`@pi/plus`) is now the shared override core consumed by `@pi/plus-cli` (builds the `pi-plus` npm artifact — the `pipi` CLI) and `@pi/plus-api` (builds the `pi-plus-sdk` npm artifact). The artifact history moved to `packages/plus-cli/CHANGELOG.md`; SDK history lives in `packages/plus-api/CHANGELOG.md`. The source-mode loader and the CLI build moved to `packages/plus-cli`; the shared esbuild redirect plugin lives here at `build/redirect-plugin.mjs` and the core redirect table at `loader/redirects.mjs`.
- The extension barrel (`src/extensions/index.ts`) now exports exactly the nine non-TUI registers shared with the SDK; the CLI-only registers (`plain-tools`, `tab-title`) moved to `packages/plus-cli/src/extensions/`, and `/cd` (`src/extensions/cd/`) moved here from the CLI package so SDK hosts get the working-directory switch too.
