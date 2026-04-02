# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `MILESTONES.json`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Keep work scoped to the `mu exec` machine-interface mission and its direct verification surfaces.
3. Implement one vertical slice at a time:
   - red test / failing verification
   - smallest code change
   - green verification
   - update mission state
4. Treat the public exec JSON contract as a stable boundary; do not leak raw internal runtime event names.
5. Keep stdout/stderr discipline explicit: JSONL-only stdout in `mu exec --json`, diagnostics on stderr.
6. Prefer explicit, typed event payloads and additive schema evolution.
7. Verification must include a real CLI surface check in addition to targeted tests.
8. If blocked, record the blocker precisely in `PROGRESS.md` and mark the relevant task `blocked`.
9. Do not mark the mission complete until exhaustive public contract verification and `npm run check` are green.
