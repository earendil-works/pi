# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `TASKS.json`, and `PROGRESS.md` before making code changes.
2. Do not start implementation until the architecture checkpoint is human-approved.
3. Keep work scoped to Morph compaction policy, strategy selection, projection, ratio logic, and direct verification surfaces.
4. Work one vertical slice at a time:
   - failing test or failing executable verification
   - smallest implementation
   - green targeted verification
   - update mission state
5. Keep native replay semantics protected while adding Morph support.
6. Treat dynamic ratio selection as a pure, testable policy function.
7. Use live Morph probes when validating request-shape assumptions; if the behavior is not visible in logs or assertions, it is not proven.
8. Prefer deterministic fixtures for unit and integration tests.
9. Include XTUI verification for the user-facing `/morph-compaction` command path before completing the mission.
10. Do not mark the mission complete until targeted verification, XTUI verification, and `npm run check` are all green.
