# Worklog: apply_patch characterization tests

- Started task and created pin/worklog.
- Added apply_patch trace hooks and matching characterization harness + generator + fixture + test.
- Ran: npx tsx packages/coding-agent/src/tools/apply-patch/generate-matching-golden-master.ts.
- Ran: npx vitest --run packages/coding-agent/src/tools/apply-patch.matching.golden.test.ts (pass).
- Ran: npm run check (passed; biome auto-fixed 2 files).
