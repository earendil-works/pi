# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `MILESTONES.json`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Keep exactly one task active at a time. Update `TASKS.json` and `PROGRESS.md` after every iteration.
3. Implement one vertical slice at a time:
   - establish or update deterministic harness fixtures
   - write the red test / failing verification
   - implement the smallest code change
   - run the green verification
   - refactor only after the slice is proven green
4. Prefer fake clocks, temp config dirs (`MU_CODING_AGENT_DIR`), temp workspaces, and controlled process restarts over flaky time-based sleeps.
5. Treat append-only ledgers plus linked Mu sessions as the only durable truth. Do not add inbox/outbox/wake/state sidecar files unless the mission is blocked without them.
6. Keep the supervisor separate from the existing Mu TUI/runtime. Reuse Mu sessions and thread semantics instead of inventing a second transcript format.
7. Keep tick as a wake mechanism only. Do not use the model as the primary idle polling loop.
8. For user-facing CLI behavior, use XTUI or equivalent terminal-surface verification and capture evidence in the milestone evidence paths.
9. Every milestone gate task requires the milestone verification contract in `MILESTONES.json` to be green before the task can be marked `done`.
10. If review findings require code changes, add explicit fix tasks, mark the current gate task `blocked`, and record the blocker plus evidence path in `PROGRESS.md`.
11. Do not mark the mission complete until targeted tests, restart/recovery checks, surface verification, and `npm run check` are all green.
12. If mission harness files change, rerun `node ~/.mu/agent/docs/scripts/mission-validator.mjs devdocs/missions/always-on-agent-v1` before continuing.
