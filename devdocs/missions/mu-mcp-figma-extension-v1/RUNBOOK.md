# Runbook

1. Read `ARCHITECTURE.md`, `SPEC.md`, `MILESTONES.json`, `TASKS.json`, and `PROGRESS.md` before changing code.
2. Keep exactly one task active at a time. Update `TASKS.json` and `PROGRESS.md` after every iteration.
3. Implement one vertical slice at a time:
   - write or update the red test / failing verification first
   - run the targeted verification and confirm the expected failure when appropriate
   - implement the smallest change that makes the slice pass
   - rerun the targeted verification
   - expand to adjacent verification only after the slice is green
4. Preserve the approved architecture:
   - MCP stays inside the existing extension lifecycle
   - generic runtime stays separate from Figma pilot behavior
   - Mu-native config/import logic replaces Pi-specific assumptions
5. Use deterministic local harnesses before real remote validation whenever possible.
6. Treat real Figma validation as a proof step, not the first debugging surface.
7. If the real Figma path is blocked by auth/client approval, implement and verify explicit truthful degraded behavior rather than faking success.
8. Record evidence at the paths referenced in `MILESTONES.json`.
9. Reserve `blocked` for true external blockers only.
10. Before declaring the mission complete, run `npm run check` and ensure all milestone gate tasks are done.
