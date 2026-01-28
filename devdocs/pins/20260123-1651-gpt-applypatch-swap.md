# Pin: GPT ApplyPatch swap (2026-01-23)

## Goal
Dynamically replace Edit with ApplyPatch for GPT models, updating tool list and system prompt when models change.

## Constraints
- No new `any` types.
- Keep non-GPT behavior unchanged.
- Update TUI model switching to refresh tool list + system prompt.

## Current state
- Tool selection now swaps Edit/Write -> ApplyPatch for GPT models and refreshes on model change.
- System prompt rebuilds with updated tool list.
- Tool-selection tests added.

## Next step
- Await confirmation or adjust GPT detection rules if needed.

## Verification
- npx vitest --run packages/coding-agent/src/tools/tool-selection.test.ts
- npm run check
