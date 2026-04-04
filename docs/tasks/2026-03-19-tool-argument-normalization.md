# Tool Argument Normalization

## What

Repaired a shared tool-validation edge case so malformed model arguments like `".pattern"` are normalized to `pattern` when the tool schema clearly expects the undotted key.

## Why

The failure was showing up as a `find` tool error, but the `find` schema itself was valid. The actual problem was that some model outputs occasionally emit a leading dot in a property name, which caused validation to reject the call before the tool could run.

## Changed

- updated `packages/ai/src/utils/validation.ts`
- added `packages/ai/test/tool-argument-validation.test.ts`
- updated `packages/coding-agent/README.md`
- updated `packages/coding-agent/examples/extensions/README.md`
- added `packages/coding-agent/examples/extensions/profile-switcher/README.md`

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/tool-argument-validation.test.ts`
- `npm run check`
