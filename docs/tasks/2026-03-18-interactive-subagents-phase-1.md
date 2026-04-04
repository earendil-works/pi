# Interactive Subagents Phase 1

## What

Added the first local integration slice for interactive subagents in the example `subagent` extension.

## Why

Your current subagent flow already handles autonomous JSON-mode work well. The missing piece was live pane-based iteration and resume support without replacing the existing planner or subagent execution model.

## Changed

- Added `packages/coding-agent/examples/extensions/subagent/cmux.ts` for cmux, tmux, and zellij pane helpers.
- Added `packages/coding-agent/examples/extensions/subagent/session.ts` for session entry counting and assistant-summary extraction.
- Added `packages/coding-agent/examples/extensions/subagent/subagent-done.ts` so pane sessions can shut down cleanly.
- Extended `packages/coding-agent/examples/extensions/subagent/index.ts` with:
  - `set_tab_title`
  - `subagent_resume`
  - `/iterate`
- Added regression coverage in:
  - `packages/coding-agent/test/subagent-extension.test.ts`
  - `packages/coding-agent/test/subagent-session.test.ts`

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/subagent-extension.test.ts`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/subagent-session.test.ts`
- `npm run check`
