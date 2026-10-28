---
name: add-llm-provider
description: Checklist for adding a new LLM provider to packages/ai. Covers core types, provider implementation, lazy registration, model generation, the full test matrix, coding-agent wiring, and docs.
---

# Adding a New LLM Provider (packages/ai)

A new provider touches multiple files. Work through these steps in order.

## 1. Core Types (`packages/ai/src/types.ts`)

- Add the provider name to the `KnownProvider` union.
- Only for a new API: add the API identifier to `KnownApi` (e.g. `"bedrock-converse-stream"`) and its options type to `ApiOptionsMap`.

## 2. API Implementation (`packages/ai/src/api/`, only for a new API)

Most providers reuse an existing API such as `openai-completions`; skip this step then.

- `src/api/<api-id>.ts` exports exactly `stream` and `streamSimple`, plus an options interface extending `StreamOptions`.
- Convert messages and tools to the provider format. Read the prompt and tools from the transcript with `getInitialSystemMessage()`, `getCurrentTools()`, and `resolveTranscript()`.
- Parse responses into standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`).
- Add a lazy wrapper `src/api/<api-id>.lazy.ts` (`<name>Api()` via `lazyApi()`) so providers can reference the implementation without importing its SDK.
- Register the lazy wrapper in the builtin API list in `src/compat.ts`.
- Add `export type` re-exports in `src/index.ts` for option types that should be available from the root entry. The `./api/*` subpath export in `package.json` already covers the new module.

## 3. Model Catalog (`packages/ai/catalog/providers/<id>.ts`)

- Add a provider definition with `defineProvider()` and register it in `catalog/providers/index.ts`. Read `packages/ai/catalog/README.md` first.
- For a models.dev provider, use `modelsDevModels()`; set compat defaults per API in `compat` and provider-specific behavior in `finalize`.
- Regenerate with `npm run generate-models` in `packages/ai`. This writes the stable catalog wrapper `src/providers/<id>.models.ts` (exporting `<ID>_MODELS`) that the provider factory imports, and updates `src/models.generated.ts`.

## 4. Provider Factory and Auth (`packages/ai/src/providers/`)

- Create `src/providers/<id>.ts` exporting `<id>Provider()`, which calls `createProvider({ id, name, baseUrl, auth, models, api })`. `name` is the display name shown by `/login` and related UI. See `deepseek.ts` for a minimal example.
- Auth: `envApiKeyAuth()` for standard API keys, a custom `ApiKeyAuth` for ambient credentials (AWS profiles, ADC), `lazyOAuth()` where an OAuth flow exists.
- Pass the lazy API wrapper (e.g. `openAICompletionsApi()`) as `api`; do not statically import API implementation modules.
- Register the factory in `src/providers/all.ts`.
- Add the env var to `src/env-api-keys.ts` so the compat `getEnvApiKey()` finds it.

## 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API impl such as `openai-completions`.
- Add the provider to the broader matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (e.g. GPT and Claude), add at least one pair per family.
- For non-standard auth, create a utility (e.g. `bedrock-utils.ts`) with credential detection.

## 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: add default model ID to `defaultModelPerProvider`.
- `src/cli/args.ts`: add env var documentation.
- `docs/providers.md`: add setup instructions, env var, and `auth.json` key.

## 7. Documentation

- `packages/ai/README.md`: add to providers table, document options/auth, add env vars.
- `packages/ai/CHANGELOG.md`: add entry under `## [Unreleased]`.
