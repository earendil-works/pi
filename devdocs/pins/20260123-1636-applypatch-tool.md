# Pin: apply_patch tool implementation (2026-01-23)

## Goal
Implement an ApplyPatch tool for pi-coding-agent using the vendored Codex apply_patch binary, and validate behavior against the golden master.

## Constraints
- No `any` types in new TS.
- Use vendored `tools/codex-apply-patch` crate; compile via cargo if binary missing.
- Update tool registry + prompts so the model can call ApplyPatch.
- Keep changes tight; no unrelated refactors.

## Spec/Context Brief
- Tools are defined as AgentTool implementations in `packages/coding-agent/src/tools/*` and registered in `tools/index.ts` + prompts yaml files.
- Golden master is in `packages/coding-agent/src/tools/apply-patch/__fixtures__/apply-patch.golden.txt`, built from a characterization harness.
- ApplyPatch should accept a patch string and run the vendor binary in the current workspace, returning stdout or error output.

## Plan Brief
- Create `apply-patch/runner.ts` with `ensureApplyPatchBinary()` + `runApplyPatchBinary()` returning stdout/stderr/exit code.
- Update `apply-patch/characterization.ts` to use runner for binary execution.
- Add `apply-patch.ts` tool wrapper that calls the runner and returns stdout on success; throw on failure.
- Register tool in `tools/index.ts`, `prompts/tools.yaml`, and `prompts/system.yaml` plus CLI `--tools` legacy mapping.
- Add a vitest that runs the tool through the same characterization harness and compares to the golden master.

## Current state
- ApplyPatch runner + tool wrapper implemented and registered; prompts updated.
- Tool characterization test added and golden master retained.

## Next step
- Await confirmation or move on to any additional ApplyPatch behavior requests.

## Verification
- `npx vitest --run packages/coding-agent/src/tools/apply-patch.tool.test.ts`
- `npm run check`
