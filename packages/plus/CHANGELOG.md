# Changelog

## [Unreleased]

### Changed

- The pi-plus sources split into three packages: this package (`@pi/plus`) is now the shared override core consumed by `@pi/plus-cli` (builds the `pi-plus` npm artifact — the `pipi` CLI) and `@pi/plus-api` (builds the `pi-plus-sdk` npm artifact). The artifact history moved to `packages/plus-cli/CHANGELOG.md`; SDK history lives in `packages/plus-api/CHANGELOG.md`. The source-mode loader and the CLI build moved to `packages/plus-cli`; the shared esbuild redirect plugin lives here at `build/redirect-plugin.mjs` and the core redirect table at `loader/redirects.mjs`.
- The extension barrel (`src/extensions/index.ts`) now exports exactly the seven non-TUI registers shared with the SDK; the CLI-only registers (`cd`, `plain-tools`, `tab-title`) moved to `packages/plus-cli/src/extensions/`.
