# 2026-03-19 Plan Todo Label Truncation Fix

## What

Removed forced 50-character truncation from plan-mode todo labels and taught resumed execution sessions to rebuild todo items from saved plan text instead of trusting stale shortened labels.

Also patched the globally installed `pi` runtime's compiled interactive renderer so `maxLines: null` stops adding `... (widget truncated)` in the live CLI.

## Why

The plan widget was still showing shortened step names like `recruitment ...` even after the widget line-count fix, because plan-mode utilities were truncating todo text before the widget ever rendered it.

Existing execution sessions were worse: they had already persisted the shortened labels in session state, so restarting `pi` kept showing the truncated strings unless the todo list was rebuilt from `planText`.

## Changed

- `packages/coding-agent/examples/extensions/plan-mode/utils.ts`
- `packages/coding-agent/examples/extensions/plan-mode/index.ts`
- `packages/coding-agent/test/plan-mode-utils.test.ts`
- `packages/coding-agent/test/plan-mode-execution-ui.test.ts`
- `/Users/besi/npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js`

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-utils.test.ts test/plan-mode-execution-ui.test.ts`
- `npm run check`
