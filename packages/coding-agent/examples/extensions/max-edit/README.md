# Max Edit Example

Best-of-N editing as an optional pi extension pack.

## What it does

- Registers a `max_edit` tool
- Adds `/max-edit <task>`
- Generates multiple proposal-only candidates
- Runs an automatic selector pass
- Applies the chosen proposal only after validation

## How it works

1. The main session calls `max_edit`
2. Candidate subprocesses run `pi --mode json` with only read/search/discovery tools plus proposal tools
3. Candidates record edits through `propose_edit` and `propose_write`
4. A selector subprocess chooses the best candidate
5. The winning proposal is validated and then applied to the real workspace

The candidate subprocesses never mutate the worktree directly.

## Files

- `index.ts` — tool and command orchestration
- `proposal-tools.ts` — proposal-only tools loaded in candidate subprocesses
- `utils.ts` — proposal parsing, selector parsing, validation, and apply helpers

## Notes

- Default candidate count is `3`
- Selection is automatic
- The pack does not run tests after apply in v1
- Failed validation stops the apply step before any files are written
