---
mode: build
---

# 1. Summary & Recommendation

Add `/mission-reset <mission-path>` to the coding agent.

The command should accept an explicit optimize mission path and append a durable control event to that mission's `EXPERIMENTS.jsonl`:

```json
{
  "type": "control",
  "kind": "resume-reset",
  "timestamp": 1760000000000,
  "note": "Manual resume reset"
}
```

The mission runner should treat this event as a barrier that clears prior convergence and blocked-stop state for subsequent resume attempts.

# 2. What Must be True

- `/mission-reset` is registered as a built-in slash command.
- The command requires exactly one mission path argument.
- The path is resolved using the same mission path conventions as existing mission commands.
- The command only succeeds for optimize missions.
- The command appends exactly one control event to `EXPERIMENTS.jsonl`.
- Existing experiment rows remain untouched.
- A converged optimize mission can run again after reset.
- A blocked optimize mission can run again after reset.
- Real `keep` results continue to mean successful experiments, not administrative actions.
- The user gets a clear success message and a clear failure message on invalid input.

# 3. What Must Never Happen

- Prior `EXPERIMENTS.jsonl` lines must never be rewritten.
- Build-mode missions must never accept reset.
- Reset must never be encoded as fake `keep`, fake metrics, or fake run data.
- Control events must never be counted as experiments.
- The command must never silently create a missing mission.
- The command must never auto-run the mission as a side effect.

# 4. Inputs / Outputs

## Input
- Slash command: `/mission-reset <mission-path>`

## Success Output
- Append one control event line to `<mission-dir>/EXPERIMENTS.jsonl`
- Show confirmation that includes:
  - resolved mission path
  - event kind `resume-reset`
  - guidance that `/mission-resume <mission-path>` can now be used

## Failure Output
- Clear error for:
  - missing path
  - mission not found
  - malformed mission files
  - build-mode mission
  - missing or unusable experiment history

# 5. Edge Cases

- Mission already converged from three consecutive non-keeps.
- Latest real experiment is `blocked`.
- History contains malformed JSONL lines.
- History contains existing `config` records.
- Mission has no real experiment results yet.
- User runs reset twice in a row.
- Path is provided with relative, absolute, or supported shorthand form.

# 6. Constraints

- Keep the implementation narrow and local to missions + TUI command handling.
- Do not add any `any` types.
- Keep `EXPERIMENTS.jsonl` as the single durable source of truth.
- Prefer derived state over new stored reset bookkeeping.
- Verification must include a real interactive path using XTUI.

# 7. Definition of Done

- New mission slash command `/mission-reset` exists.
- A fixture optimize mission can be driven into a halted state.
- Running `/mission-reset <fixture-path>` appends one `control/resume-reset` event.
- After reset, `/mission-resume <fixture-path>` no longer exits immediately due to the previous convergence/blocked state.
- Build-mode reset attempts fail clearly.
- Targeted automated tests cover parser/runner semantics and command behavior.
- XTUI verification demonstrates the real command path end to end.

## Verification Contract

### Red checks
- A converged optimize fixture mission resumes with `iterations: 0` before reset.
- A blocked optimize fixture mission resumes with immediate blocked behavior before reset.
- Build-mode fixture mission incorrectly accepts reset before implementation.

### Green checks
- After appending `control/resume-reset`, the converged fixture mission can execute again.
- After appending `control/resume-reset`, the blocked fixture mission can execute again.
- Reset is rejected for build-mode missions.
- Control events are ignored as experiment outcomes and only used as barriers.

### XTUI checks
- Launch the real CLI in a controlled fixture workspace.
- Inject `/mission-reset <fixture-path>` via XTUI.
- Assert the confirmation message appears.
- Assert the fixture mission's `EXPERIMENTS.jsonl` gains the expected control event.

# 8. What needs to be done to deliver the spec

- Add a fixture optimize mission suitable for deterministic halt/resume tests.
- Add a fixture build mission for rejection tests.
- Add mission-history parsing support for `type: "control"` and `kind: "resume-reset"`.
- Update mission runner convergence/blocking derivation to honor the control barrier.
- Add slash command registration and execution handling.
- Add automated tests for:
  - history parsing
  - barrier semantics
  - reset append behavior
  - slash command handling
- Add XTUI harness coverage that runs the real CLI, injects `/mission-reset`, and verifies the resulting history.

## Test Fixture Requirements

- A real mission fixture under `devdocs/missions/...` for interactive XTUI verification.
- Synthetic test fixtures under the relevant test directories for targeted automated tests.
- Fixture histories must include at least:
  - converged optimize case
  - blocked optimize case
  - build-mode rejection case
