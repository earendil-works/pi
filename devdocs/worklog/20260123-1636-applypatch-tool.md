# Worklog: apply_patch tool implementation (2026-01-23)

- Added apply_patch runner module + tool wrapper, updated characterization harness.
- Registered ApplyPatch in tools registry + prompt descriptions + CLI legacy tool mapping.
- Added ApplyPatch tool characterization test against golden master.
- Verified: npx vitest --run packages/coding-agent/src/tools/apply-patch.tool.test.ts
- Verified: npm run check
