# packages/agent

## Purpose
Package root for `@mariozechner/pi-agent-core` -- general-purpose agent with transport abstraction, state management, and attachment support.

## Technology
TypeScript, ESM, npm package. Build: `tsgo`. Test: `vitest`.

## Contents
- `package.json` - Package manifest (v0.59.0), depends on `@mariozechner/pi-ai`
- `README.md` - Agent API documentation
- `CHANGELOG.md` - Version history
- `tsconfig.build.json` - Build TypeScript configuration
- `vitest.config.ts` - Vitest test configuration
- `src/` - Source code (see `src/agentic_instructions.md`)
- `test/` - Test suite

## CRUD Entry Points
- **Build**: `npm run build`
- **Test**: `npx vitest run` or `npx vitest run test/<specific>.test.ts`
