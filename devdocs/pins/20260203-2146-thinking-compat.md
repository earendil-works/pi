# Pin: 20260203-2146-thinking-compat

## Goal
Preserve and correctly translate **thinking/reasoning** content when switching between:
- `openai-responses` (OpenAI Responses API)
- `anthropic-messages` (Anthropic Messages API), including non-Anthropic endpoints that implement the same API (e.g. `api.synthetic.new/anthropic`).

## Context / Problem
- Today, cross-provider handoff strips `thinkingSignature` (by design), and then:
  - `anthropic-messages` conversion sends thinking blocks **as plain text** when signature is missing.
  - `openai-responses` conversion **drops** thinking blocks when signature is missing.
- Synthetic’s Anthropic Messages docs specify a “Thinking Content Object” as:
  - `{ type: "thinking", thinking: string }` (no signature mentioned).

## Acceptance Criteria
- When sending history to **Synthetic’s Anthropic Messages** endpoint, prior thinking should be represented as proper `type: "thinking"` blocks (without requiring signature).
- When sending history to **OpenAI Responses**, prior thinking (without a signature) must not be silently dropped; it should be preserved in an equivalent form.
- Existing behavior for official Anthropic (`api.anthropic.com`) remains safe (avoid sending signature-less thinking blocks if that would be rejected).

## Plan (high-level)
1. Anthropic provider: allow signature-less thinking blocks for non-official endpoints; otherwise fall back to tagged text.
2. OpenAI Responses provider: when a `thinking` block has no signature, serialize it into a text message with explicit `<thinking>...</thinking>` delimiters (so it’s preserved, even if not a native OpenAI reasoning item).
3. Add vitest coverage for both directions.

## Current Slice
Slice 3: Run repo-wide check (`npm run check`) and ensure everything still passes.

## Next Verification
- `npx vitest run -c packages/ai/vitest.config.ts packages/ai/test/cross-provider-thinking.test.ts`
- Then `npm run check` at repo root.
