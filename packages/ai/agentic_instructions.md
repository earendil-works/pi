# packages/ai

## Purpose
Package root for `@mariozechner/pi-ai` -- unified LLM API with automatic model discovery, streaming, and provider configuration for 20+ providers.

## Technology
TypeScript, ESM, npm package. Build: `tsgo`. Test: `vitest`.

## Contents
- `package.json` - Package manifest (v0.59.0), dependencies, build/test scripts
- `README.md` - Provider documentation, setup instructions, API usage
- `CHANGELOG.md` - Version history
- `tsconfig.build.json` - Build TypeScript configuration
- `vitest.config.ts` - Vitest test configuration
- `bedrock-provider.d.ts` / `bedrock-provider.js` - Separate Bedrock entry point to avoid pulling full AWS SDK into main bundle
- `src/` - Source code (see `src/agentic_instructions.md`)
- `test/` - Test suite
- `scripts/` - Model generation scripts

## CRUD Entry Points
- **Build**: `npm run build` (generate models + tsgo compile)
- **Test**: `npx vitest run` or `npx vitest run test/<specific>.test.ts` (from package root)
- **Lint**: `npm run check` (from repo root)
