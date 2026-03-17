# packages/tui

## Purpose
Package root for `@mariozechner/pi-tui` -- Terminal UI library with differential rendering for efficient text-based applications.

## Technology
TypeScript, ESM, npm package. Build: `tsgo`. Test: `vitest`.

## Contents
- `package.json` - Package manifest (v0.59.0), dependencies (chalk, koffi, marked)
- `README.md` - TUI API documentation
- `CHANGELOG.md` - Version history
- `tsconfig.build.json` - Build TypeScript configuration
- `vitest.config.ts` - Vitest test configuration
- `src/` - Source code (see `src/agentic_instructions.md`)
- `test/` - Test suite

## CRUD Entry Points
- **Build**: `npm run build`
- **Test**: `npx vitest run`
