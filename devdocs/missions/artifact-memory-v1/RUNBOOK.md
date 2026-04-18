# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `MILESTONES.json`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Keep work scoped to artifact-memory v1 and its direct verification surfaces.
3. Implement one vertical slice at a time:
   - red test / failing verification
   - smallest code change
   - green verification
   - update mission state
4. Treat append-only memory entries as the only authoritative source of truth.
5. Derive workspace projections from authoritative entries; do not introduce a write-managed index as source of truth.
6. Keep automatic memory writes limited to the approved durable artifact-producing tool completions.
7. Explicit user-requested memory interactions should go through the memory-tool boundary.
8. Verification must include real `mu exec --json` fresh-session checks in addition to targeted tests.
9. If blocked, record the blocker precisely in `PROGRESS.md` and mark the relevant task `blocked`.
10. Do not mark the mission complete until all milestone gates and `npm run check` are green.
