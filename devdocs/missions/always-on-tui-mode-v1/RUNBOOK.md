# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `MILESTONES.json`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Keep exactly one task active at a time. Update `TASKS.json` and `PROGRESS.md` after every meaningful step.
3. Do not begin implementation work until the current milestone's red harness exists.
4. Prefer the simplification rule order:
   - question the requirement
   - delete before improving
   - simplify the surviving design
5. Treat the append-only always-on ledgers as the only durable source of truth.
6. Do not add write-managed TUI summaries of jobs, runs, schedules, or follow-up lineage when those views can be derived.
7. Keep TUI-owned state minimal and session-local.
8. Reuse the existing always-on domain behavior through one shared service layer. Do not shell out from the TUI to `mu always-on ...` as the primary control path.
9. Prefer one primitive-oriented submission shape over many narrow helper functions.
10. For implementation work, go red → green → refactor.
11. For each milestone gate, collect all listed evidence files before marking the gate task done.
12. Use XTUI for visible terminal verification when the milestone changes the user-facing TUI surface.
13. Run `node ~/.mu/agent/docs/scripts/mission-validator.mjs devdocs/missions/always-on-tui-mode-v1` after every mission-harness edit.
14. Run `npm run check` only after the implementation slices for the active milestone are green enough to justify the broader validation cost.
15. Do not run `npm run dev`.
