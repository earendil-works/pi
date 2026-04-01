# Runbook

1. Read `ARCHITECTURE.md` first. Do not override approved boundaries, abstractions, tradeoffs, or priorities.
2. Read `SPEC.md`, `TASKS.json`, `MILESTONES.json`, and `PROGRESS.md` before starting each iteration. Treat them as the source of truth.
3. Work exactly one task at a time.
4. Update the current task status only when its stated validation or gate evidence is actually satisfied.
5. For any milestone gate, follow the internal verifier rule in `SPEC.md`: spawn an independent verifier agent, wait for its result, and save its PASS/FAIL findings as mission evidence before marking the gate task done.
6. If the verifier reports issues, add follow-up fix tasks or keep the gate task blocked in practice; do not advance by hand-waving.
7. After each meaningful iteration, update `TASKS.json` and `PROGRESS.md` so the mission state stays accurate.
8. Run the mission validator after any harness-file change: `node ~/.mu/agent/docs/scripts/mission-validator.mjs devdocs/missions/spawn-agent-independent-verifier`.
9. Do not run `npm run dev`.
10. Before mission completion, run `npm run check`.
