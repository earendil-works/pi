# ai — Unified LLM API

Streaming LLM abstraction across multiple providers. No internal dependencies — this is the foundation package.

## Structure
```
src/
  types.ts         # Api union, StreamOptions, Model, Message, Content types
  stream.ts        # Provider dispatch: SimpleStreamOptions → provider-specific stream
  context.ts       # Context/token management, message truncation
  models.ts        # Model registry, discovery, built-in model definitions
  providers/       # One file per LLM provider (see providers/AGENTS.md)
  utils/           # OAuth flows, token helpers
scripts/
  generate-models.ts  # Fetches model catalogs from providers → models.generated.ts
```

## Where to Look
| Task | Location |
|------|----------|
| Add LLM provider | `src/providers/` + `src/types.ts` + `src/stream.ts` |
| Fix streaming bug | `src/stream.ts` → provider file |
| Change message format | `src/types.ts` |
| Update model list | `scripts/generate-models.ts` |
| OAuth/auth issues | `src/utils/oauth/` |

## Anti-Patterns
- NEVER add provider-specific logic to `stream.ts` — belongs in provider file
- NEVER skip test files when adding a provider (see root AGENTS.md checklist)
- NEVER convert to top-level imports in `env-api-keys.ts`, `openai-codex-responses.ts`, `utils/oauth/openai-codex.ts` — breaks browser/Vite builds
- `models.generated.ts` is auto-generated — never edit manually, run `npm run generate-models`

## Commands
```bash
# Run specific test
npx tsx ../../node_modules/vitest/dist/cli.js --run test/stream.test.ts
```
