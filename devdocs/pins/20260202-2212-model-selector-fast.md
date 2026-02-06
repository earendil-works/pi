## Goal
Make `/model` in the TUI open in <=100ms by removing session-history scanning from the hot path while preserving usage-based sorting.

## Constraints / Non-goals
- Usage stats must be stored under mu config (~/.mu/agent/...), not in the git workspace.
- Sorting must remain (recency + frequency via existing `compareModelUsage`).
- Must not depend on scanning `~/.mu/agent/sessions/<workspace>/*.jsonl` on `/model` open.
- Must run `npm run check` at repo root after code changes.

## Current State
- Implemented per-workspace snapshot file: `.model-usage-stats.json` in the workspace session dir under mu config.
- Session start + model change now record usage to the snapshot.
- `loadModelUsageStats()` now prefers snapshot (and seeds from legacy `.model-usage-cache.json` if present) without scanning session JSONL files.

## Plan (high level)
1. Add per-workspace snapshot file `.../.model-usage-stats.json` and functions to read/write it.
2. Update `SessionManager.startSession` + `saveModelChange` to record usage into snapshot.
3. Update `loadModelUsageStats` to prefer snapshot (and optionally seed from legacy `.model-usage-cache.json`) and avoid scanning.
4. Verify with vitest + a local bench + root `npm run check`.

## Next Step
None. Implementation complete.

## Verification
- `npx tsx packages/coding-agent/test/bench-model-selector.ts`
- `npm test -w @kennyfrc/mu-coding-agent`
- `npm run check`
