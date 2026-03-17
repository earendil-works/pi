# packages/coding-agent

## Purpose
Package root for `@mariozechner/pi-coding-agent` -- the `pi` CLI coding agent with read, bash, edit, write tools, session management, extension system, and interactive/print/RPC modes.

## Technology
TypeScript, ESM, npm package. Build: `tsgo` + asset copy. Test: `vitest`. Binary: Bun compile.

## Contents
- `package.json` - Package manifest (v0.59.0), CLI binary `pi`, exports main + hooks
- `README.md` - User documentation, provider setup, CLI usage
- `CHANGELOG.md` - Version history
- `tsconfig.build.json` - Build TypeScript configuration
- `tsconfig.examples.json` - TypeScript configuration for examples
- `vitest.config.ts` - Vitest test configuration
- `src/` - Source code (see `src/agentic_instructions.md`)
- `test/` - Test suite
- `docs/` - Extended documentation
- `examples/` - Extension and SDK examples
- `scripts/` - Build helper scripts

## CRUD Entry Points
- **Build**: `npm run build` (tsgo + chmod + copy-assets)
- **Binary**: `npm run build:binary` (Bun compile)
- **Test**: `npx vitest run` or `npx vitest run test/<specific>.test.ts`
- **Run from source**: `npx tsx src/cli.ts`
