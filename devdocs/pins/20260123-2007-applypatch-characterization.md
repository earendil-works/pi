# Pin: apply_patch characterization tests

## Goal
Add characterization (golden master) tests that capture apply_patch matching decisions before best-practice changes.

## Constraints
- No behavior changes yet; only add tracing + tests.
- Output must be deterministic (no absolute temp paths).
- Follow TypeScript no-`any` rule.
- Must run `npx vitest --run <new test>` and `npm run check` after changes.

## Spec/Context Brief
- apply_patch engine lives at `packages/coding-agent/src/tools/apply-patch/engine.ts`.
- Existing golden master only captures summary output; we need detailed trace of matching decisions.
- edit tool and opencode edit tool provide best-practice matching behaviors to apply later.

## Plan Brief
- Add optional tracing hooks to apply_patch engine (parse + seekSequence + replacements + apply).
- Build a characterization harness that runs multiple scenarios and records trace + results.
- Store output in new fixture under `apply-patch/__fixtures__/` and add a golden master test.
- Verify with vitest + repo check.

## Current State
- Added trace hooks to apply_patch engine and created matching characterization harness.
- Generated new fixture `apply-patch.matching.golden.txt` and test passes.
- `npm run check` completed (biome auto-fixed 2 files).

## Next Step
- Ready for review.

## Verification
- `npx vitest --run packages/coding-agent/src/tools/apply-patch.matching.golden.test.ts` (passed)
- `npm run check` (passed; auto-fixed 2 files)
