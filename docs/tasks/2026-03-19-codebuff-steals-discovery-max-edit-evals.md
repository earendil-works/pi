# Discovery, Max-Edit, and Eval Harness

## What

Implemented the approved Codebuff-inspired scope in `packages/coding-agent`: file-tree-first discovery in core, a best-of-N `max-edit` example extension, and a checked-in manual eval harness.

## Why

`pi` already had extensibility and subagent patterns, but it was missing three high-leverage pieces:

- fast, ignore-aware project discovery before full file reads
- an optional best-of-N edit workflow that does not bloat core
- a repeatable local benchmark loop for tuning extensions and model profiles with evidence

## Changed

- added `packages/coding-agent/src/core/tools/project-tree.ts`
- added `packages/coding-agent/src/core/tools/tree.ts`
- added `packages/coding-agent/src/core/tools/read-subtree.ts`
- updated `packages/coding-agent/src/core/tools/index.ts`
- updated `packages/coding-agent/src/core/tools/find.ts`
- updated `packages/coding-agent/src/core/tools/edit.ts`
- updated `packages/coding-agent/src/core/tools/write.ts`
- updated `packages/coding-agent/src/core/system-prompt.ts`
- updated `packages/coding-agent/src/core/sdk.ts`
- updated `packages/coding-agent/src/core/agent-session.ts`
- updated `packages/coding-agent/src/core/extensions/types.ts`
- updated `packages/coding-agent/src/core/extensions/index.ts`
- added `packages/coding-agent/examples/extensions/max-edit/index.ts`
- added `packages/coding-agent/examples/extensions/max-edit/proposal-tools.ts`
- added `packages/coding-agent/examples/extensions/max-edit/utils.ts`
- added `packages/coding-agent/examples/extensions/max-edit/README.md`
- added `packages/coding-agent/test/agent-session-discovery-tools.test.ts`
- added `packages/coding-agent/test/max-edit-utils.test.ts`
- added `packages/coding-agent/test/max-edit-extension.test.ts`
- added `packages/coding-agent/test/manual-evals/scenarios.ts`
- added `packages/coding-agent/test/manual-evals/run.ts`
- added `packages/coding-agent/test/manual-evals.test.ts`
- updated `packages/coding-agent/test/system-prompt.test.ts`
- updated `packages/coding-agent/test/tools.test.ts`
- updated `packages/coding-agent/README.md`
- updated `packages/coding-agent/CHANGELOG.md`

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/system-prompt.test.ts test/tools.test.ts test/agent-session-discovery-tools.test.ts`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/max-edit-utils.test.ts test/max-edit-extension.test.ts`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/manual-evals.test.ts`
- `npm run check`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/max-edit-utils.test.ts test/max-edit-extension.test.ts test/manual-evals.test.ts`
