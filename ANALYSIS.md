# Analysis: Azure OpenAI Responses multi-turn reasoning failure under `store: false`

## Symptom

Multi-turn conversations against Azure OpenAI Responses (reasoning-capable models)
fail on turn 2 with:

```
400 Item with id 'rs_...' not found. Items are not persisted when `store`
is set to false. Try again with `store` set to true, or remove this
item from your input.
```

Reported via `@flue/sdk`, but the root cause is in `pi-ai`.

## What I confirmed

- `packages/ai/src/providers/openai-responses.ts` hardcodes `store: false`.
- `packages/ai/src/providers/azure-openai-responses.ts` does not set `store`;
  it delegates to the Azure deployment default. When `reasoning` is configured
  it already requests `include: ["reasoning.encrypted_content"]`, which is the
  correct handshake for stateless replay.
- `packages/ai/src/providers/openai-responses-shared.ts` captures the reasoning
  item on `response.output_item.done` via `JSON.stringify(item)` and replays
  it verbatim on the next turn. The round-trip is complete **only when the
  stream event's `item` actually carries `encrypted_content`**.
- The `openai` SDK's `ResponseReasoningItem` declares
  `encrypted_content?: string | null`, so the field is optional even inside
  `response.output_item.done`. In practice, Azure OpenAI reasoning models
  populate `encrypted_content` reliably on the final `response.completed`
  event's `response.output[]`, but may leave it unset on intermediate
  `response.output_item.done` events. When that happens, `pi-ai` stores a
  reasoning signature with only the `id` and the summary. On replay under
  `store: false`, the server has no stored item and no encrypted payload to
  verify, so it returns the 400 above.
- Codex WebSocket flow in `openai-codex-responses.ts` is independent: it
  already hardcodes `store: false` because ChatGPT Codex rejects `store: true`
  and uses connection-scoped `previous_response_id` continuity. I did not
  touch it.

## What I changed

Minimal, non-breaking:

1. `packages/ai/src/providers/openai-responses-shared.ts`
   In the `response.completed` handler, walk `response.output[]` and, for
   each reasoning item that carries `encrypted_content`, merge it into the
   matching stored `thinkingSignature` by `id` when the stored copy is
   missing `encrypted_content`. This makes capture robust against deployments
   that only finalize `encrypted_content` on `response.completed`.

2. `packages/ai/src/types.ts`
   Added `SimpleStreamOptions.store?: boolean` as an opt-in pass-through.

3. `packages/ai/src/providers/openai-responses.ts`
   Added `OpenAIResponsesOptions.store?: boolean`. `buildParams` now uses
   `options?.store ?? false`; the default is unchanged.
   `streamSimpleOpenAIResponses` forwards `store`.

4. `packages/ai/src/providers/azure-openai-responses.ts`
   Added `AzureOpenAIResponsesOptions.store?: boolean`. `buildParams` sets
   `params.store = options.store` only when the caller provided a value,
   preserving today's "let the server decide" default.
   `streamSimpleAzureOpenAIResponses` forwards `store`.

`openai-codex-responses.ts` is untouched.

## Tests

`packages/ai/test/azure-openai-responses-reasoning-replay.test.ts` adds four
tests that mock the `AzureOpenAI` client and queue stream events per turn:

1. Happy path: `encrypted_content` present on `response.output_item.done`
   round-trips through replay. (passed before the fix, still passes)
2. Regression repro: `encrypted_content` present only on `response.completed`;
   without the fix, turn 2 replay loses it. (failed before, passes now)
3. `store: true` option is forwarded to the Azure request body.
4. When `store` is not provided, the Azure payload still omits the field.

`npm run check` passes. Full `vitest --run` skips networked suites and
leaves only Ollama-hook timeouts that are unrelated to these changes.

## Rationale for picking this combination over other options

- Option (a) semantic capture fix is the one that makes real user traffic
  succeed without any caller change; it is the primary fix.
- Option (b) `store` flag gives downstream consumers (e.g. Flue) a clean
  opt-in when they want server-side persistence, without flipping defaults
  for everyone else.
- Option (c) stripping reasoning-item ids is not viable: the SDK types the
  `id` field as required, and without `encrypted_content` the server cannot
  validate the item regardless of whether the id is present.

## Backport note for downstream consumers

- If you are on `@flue/sdk` and ran into this bug, you have two clean paths
  once this patch lands:
  - Upgrade `@mariozechner/pi-ai` and rely on the default behavior. The
    `encrypted_content` backfill alone resolves the replay failure on
    deployments that return the field on `response.completed`.
  - Or pass `store: true` through `streamSimple` / provider options if your
    Azure deployment stores responses and you want `previous_response_id`-
    style lookups.
- No code change is required for consumers that were already working under
  OpenAI (non-Azure) Responses.
