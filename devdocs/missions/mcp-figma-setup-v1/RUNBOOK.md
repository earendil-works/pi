# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `MILESTONES.json`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Do not begin implementation until `architecture-approval` is complete.
3. Keep exactly one active task at a time and update `TASKS.json` and `PROGRESS.md` after each slice.
4. Use the default loop for each slice:
   - write or update the failing test first
   - confirm the verification is red when appropriate
   - implement the smallest change
   - run targeted verification
   - refactor only after the slice is green
5. Keep generic MCP runtime work separate from Figma pilot work.
6. Use deterministic local harnesses on `3200-3299` before attempting real Figma validation.
7. For slash/status UX changes, verify with `xtui` and capture evidence in the milestone evidence paths.
8. Never run `npm run dev`.
9. Do not mark a milestone gate task `done` until its `MILESTONES.json` verification contract is green.
10. The mission is complete only after package checks, root `npm run check`, and mission state files all agree.
