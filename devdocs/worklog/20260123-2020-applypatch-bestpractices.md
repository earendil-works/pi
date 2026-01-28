# Worklog: apply_patch best-practice matching

- Added matching helpers (confusables, invisibles, unescape, whitespace normalization, indentation, fuzzy) and extended seekSequence tracing.
- Added matching characterization scenarios (invisible chars, whitespace normalization, unescape, fuzzy) and regenerated golden fixture.
- Ran: npx vitest --run packages/coding-agent/src/tools/apply-patch.matching.golden.test.ts (pass).
- Ran: npx vitest --run packages/coding-agent/src/tools/apply-patch.golden.test.ts (pass).
- Ran: npm run check (passed; biome auto-fixed 1 file).
