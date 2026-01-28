# Pin: apply_patch golden master (2026-01-23)

## Goal
Create a characterization test (golden master) for the upstream Codex apply_patch tool behavior so we can later implement a matching tool in Pi.

## Constraints
- No apply_patch tool exists yet in pi-coding-agent.
- Need deterministic, byte-for-byte output from a reference run.
- Avoid `any` in new TS.
- Keep changes scoped; do not implement the new tool yet.

## Spec/Context Brief
- Upstream Codex provides a Rust apply_patch CLI that applies a custom patch format and prints a summary of file changes.
- We can vendor the apply-patch crate locally and run it against a fixed sandbox to capture output.

## Plan Brief
- Vendor the Codex apply-patch Rust crate into a local tools directory with pinned deps.
- Add a TS characterization harness that runs the vendor binary on a deterministic sandbox patch and prints debug state.
- Save the output as a golden master file and add a vitest that compares live output to the golden file.

## Current state
- No vendor tool or golden master exists.

## Next step
- Create vendor crate + characterization harness + golden master file + test.

## Verification
- Run the new vitest that compares the characterization output to the golden master.
