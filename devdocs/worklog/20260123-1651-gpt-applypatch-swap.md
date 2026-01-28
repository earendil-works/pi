# Worklog: GPT ApplyPatch swap (2026-01-23)

- Added tool-selection helper to swap Edit -> ApplyPatch for GPT models.
- Wired tool selection into main startup + TUI model switching with system prompt rebuild.
- Updated system prompt guidelines to account for ApplyPatch.
- Added tool-selection tests.
- Updated GPT swap to remove Write alongside Edit.
- Verified: npx vitest --run packages/coding-agent/src/tools/tool-selection.test.ts
- Verified: npm run check
