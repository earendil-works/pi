# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Keep work scoped to the `/mission-reset` feature and its direct verification surfaces.
3. Implement one vertical slice at a time:
   - red test / failing verification
   - smallest code change
   - green verification
   - update mission state
4. Preserve append-only mission history.
5. Do not encode reset as fake experiment success.
6. Keep XTUI verification runnable from a controlled fixture workspace.
7. If blocked, record the blocker precisely in `PROGRESS.md` and mark the relevant task `blocked`.
8. Do not mark the mission complete until both automated verification and XTUI verification are green.
