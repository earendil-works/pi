# Pin: apply_patch best-practice matching

## Goal
Implement best-practice matching in apply_patch (confusable normalization, invisible chars, unescape, whitespace normalization, indentation flexibility, fuzzy match) with updated characterization tests.

## Constraints
- Preserve existing apply_patch golden master output for baseline scenario.
- Keep tracing deterministic for golden master fixture.
- No `any` types.

## Current State
- Added matching passes and trace lines in `apply-patch/engine.ts`.
- Added new scenarios in `apply-patch/matching-characterization.ts` and regenerated fixture.
- Matching and baseline golden tests pass.
- `npm run check` passed (biome auto-fixed 1 file).

## Next Step
- Ready for review.

## Verification
- `npx vitest --run packages/coding-agent/src/tools/apply-patch.matching.golden.test.ts`
- `npx vitest --run packages/coding-agent/src/tools/apply-patch.golden.test.ts`
- `npm run check`
