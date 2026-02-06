# Worklog: 20260203-2146-thinking-compat

- Created pin for thinking/reasoning cross-provider compatibility work.

- Slice 1:
  - Updated `packages/ai/src/providers/anthropic.ts` and the runtime JS (`packages/ai/src/providers/anthropic.js`) so signature-less thinking blocks are sent as `{ type: "thinking", thinking }` for Synthetic endpoints, and as tagged text (`<thinking>...</thinking>`) for official Anthropic.
  - Added `packages/ai/test/cross-provider-thinking.test.ts` verifying both behaviors.
  - Verified: `npx vitest run -c packages/ai/vitest.config.ts packages/ai/test/cross-provider-thinking.test.ts`

- Slice 2:
  - Updated `packages/ai/src/providers/openai-responses.ts` and runtime JS (`packages/ai/src/providers/openai-responses.js`) to preserve thinking blocks without an OpenAI reasoning signature by encoding them as tagged assistant text (`<thinking>...</thinking>`).
  - Extended `packages/ai/test/cross-provider-thinking.test.ts` to verify OpenAI request input includes tagged thinking.
  - Verified: `npx vitest run -c packages/ai/vitest.config.ts packages/ai/test/cross-provider-thinking.test.ts`

- Slice 3:
  - Verified: `npm run check`

- Follow-up:
  - Removed `<thinking>...</thinking>` wrapping from our signature-less thinking fallbacks.
    - Anthropic official fallback now sends plain text (still avoids signature-less thinking blocks).
    - OpenAI Responses fallback now sends plain assistant text.
  - Verified again:
    - `npx vitest run -c packages/ai/vitest.config.ts packages/ai/test/cross-provider-thinking.test.ts`
    - `npm run check`

- Follow-up 2:
  - Generalized signature-less thinking support to *all non-official* Anthropic Messages endpoints (not only Synthetic).
    - Official endpoint detection uses baseUrl hostname `api.anthropic.com`.
  - Verified again:
    - `npx vitest run -c packages/ai/vitest.config.ts packages/ai/test/cross-provider-thinking.test.ts`
    - `npm run check`

- Follow-up 3:
  - For OpenAI Responses, when a cross-provider thinking block has no OpenAI `ResponseReasoningItem` signature, preserve it by sending a synthetic `type: "reasoning"` item with a `summary_text` containing the thinking text.
  - Verified again:
    - `npx vitest run -c packages/ai/vitest.config.ts packages/ai/test/cross-provider-thinking.test.ts`
    - `npm run check`
