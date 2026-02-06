# Pin: ApplyPatch undo support in /undo

## Goal
Make `/undo` revert file changes made via the `ApplyPatch` tool (in addition to `Edit` and `Write`), with the same safety guarantees (hash verification; session-scoped undo data).

## Constraints
- Keep changes tight; no unrelated refactors.
- No new `any` types in production code.
- Must be test-driven and verified locally.
- Must run `npm run check` at repo root before finishing.

## Current state (facts)
- `/undo` currently reverts `Edit` + `Write` tool operations only.
- GPT models swap `Edit`/`Write` to `ApplyPatch`, so `/undo` currently does not revert file changes in GPT sessions.
- `ApplyPatch` tool currently returns `details: { parsed }` only; it does not persist undo payload.

## Current state (after changes)
- `ApplyPatch` tool now stores undo payload in toolResult `details.undo.entries` (before snapshots + after hash for hash-verified undo).
- `/undo` now uses a shared `undoFileOperations()` helper that supports `Edit`, `Write`, and `ApplyPatch`.
- TUI strips `details.undo` after saving toolResult messages (session-enabled mode), relying on lazy load from the session JSONL.

## Plan (slices)
1) Add undo payload (before snapshots + after hashes) to `ApplyPatch` tool result details; unit test it.
2) Add `ApplyPatch` support to `/undo` using the stored undo payload (with lazy load from session file); unit test behavior including hash-mismatch guard.
3) Strip `ApplyPatch` undo payload from in-memory messages after saving (like Edit/Write), run full coding-agent tests, then run root `npm run check`.

## Verification
- `npm run test -w @kennyfrc/mu-coding-agent`
- `npm run check` (repo root)
