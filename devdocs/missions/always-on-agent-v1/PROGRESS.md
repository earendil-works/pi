# Progress

## Status
- ready

## Next Smallest Step
- Establish deterministic temp `MU_CODING_AGENT_DIR` / workspace fixtures and add red tests for agent creation plus global-default resolution.

## Notes
- Architecture is approved: separate supervisor, append-only JSONL ledgers, Mu per-run sessions, one global default agent with explicit `set-default`, event wake plus reconciliation tick, jobs as the primary object, provider/model/thinking as first-class agent configuration, invocation-time execution tuple overrides, latest-missed-only recurrence, single-overlap queuing, replacement-run recovery, no ask_user tools, and follow-up tuple inheritance.
- The v1 scope is local-first and correctness-focused: create/send/schedule/jobs/runs/follow-up/status/thread commands, immediate and scheduled work, and completion/blocker notifications.
- Generic remote broker/webhook infrastructure is out of scope for this mission.
- Live context is used at execution time; work items may still point to prior jobs and prior Mu sessions for lineage.
- The approved primary real-run validation target is `openai-codex / gpt-5.4 / medium`.
- The verification contract requires deterministic tests, restart/recovery checks, visible CLI/XTUI checks, and final `npm run check`.
