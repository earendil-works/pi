---
mode: build
---

# 1. Summary & Recommendation

Add `mu always-on` as a correctness-first always-on worker for Mu.

The recommended v1 design is:

- a separate always-on supervisor
- append-only JSONL ledgers under `~/.mu/agent/always-on/`
- one global default agent for untargeted commands
- provider/model/thinking level stored durably per always-on agent
- per-work-item provider/model/thinking override when the invocation explicitly requests a different execution tuple
- durable work items as the primary unit of intent
- event wake on new work + periodic reconciliation tick
- one-off and recurring schedules
- Mu itself executes each due work item as an independent run/thread
- follow-ups create new linked work items instead of forcing all work into one shared thread

The durable truths are jobs and runs. Synthetic ticks are a wake mechanism, not the primary data model.

# 2. What Must be True

- `mu always-on create --workspace <path>` creates a durable always-on agent configuration.
- If `--agent <id>` is omitted on create, Mu auto-generates an `agentId` and prints it.
- An always-on agent durably stores `provider`, `modelId`, and `thinkingLevel` as part of its configuration.
- `mu always-on create` supports explicit provider/model selection and thinking-level selection.
- `mu always-on send`, `schedule`, and `follow-up` support explicit provider/model/thinking overrides for that work item.
- The first created always-on agent becomes the global default automatically if no global default exists yet.
- Later global-default changes require an explicit `mu always-on set-default <agent-id>` command.
- `mu always-on send ...` without an explicit agent id or workspace resolves the global default agent.
- A work item durably stores:
  - target agent
  - instruction text
  - optional workspace override
  - optional execution provider/model/thinking override
  - optional related work-item ids
  - optional related Mu session/thread ids
  - optional schedule
- When a work item includes an execution tuple override, the supervisor uses that override for the resulting run instead of the agent default.
- When a follow-up work item does not restate an execution tuple, it inherits the prior job/run's effective provider/model/thinking tuple.
- Work executes against live workspace context at execution time, not a frozen file snapshot, unless the user explicitly supplied references as part of the work item.
- New work appended while the supervisor is alive wakes it promptly without waiting for the next reconciliation tick.
- The supervisor also performs a periodic reconciliation tick so missed file-watch events and due schedules are still noticed.
- Scheduling supports both:
  - one-off execution at a specific time
  - recurring execution from a cron-like schedule
- If multiple recurring occurrences were missed while the supervisor was down, restart runs only the latest missed occurrence.
- If a recurring occurrence becomes due while the current run is still active, the supervisor queues exactly one pending follow-on occurrence after the current run finishes.
- Each run of a work item creates a distinct Mu session/thread and records its `sessionId`.
- Each run records the effective provider/model/thinking tuple actually used for execution.
- Each run records a durable lifecycle with at least `run_started` and terminal `run_finished` facts.
- If the supervisor crashes after `run_started` but before terminal completion, restart creates a replacement run and marks the old run abandoned or errored.
- Scheduled work deduplicates occurrences so the same occurrence is not run twice across restart/recovery.
- `mu always-on follow-up <job-id> "..."` creates a new linked work item rather than mutating history.
- `mu always-on jobs`, `runs`, `status`, and thread inspection surfaces let a human inspect job/run/thread lineage without reading raw ledgers.
- Existing Mu thread semantics remain usable for run sessions, including `list_threads` and `read_thread` behavior.
- Always-on execution does not expose tools that require live human feedback, including `ask_user`.
- Completion and blocker/needs-user outcomes trigger visible notification behavior.
- Crash/restart preserves accepted work and lets the supervisor resume from ledgers without losing or duplicating due work.
- Real end-to-end validation for this mission may use `openai-codex / gpt-5.4 / medium` as the approved primary execution target.

# 3. What Must Never Happen

- Accepted work must never disappear after a process crash or restart.
- The same scheduled occurrence must never run twice.
- Two supervisors must never actively own the same agent at the same time.
- Send/schedule/follow-up commands must never silently target the wrong workspace or wrong agent.
- Creating a later agent must never silently replace the existing global default.
- The system must never require one immortal Mu conversation as the sole source of truth.
- The model must never be used as the primary idle poller just to learn that no work is due.
- The implementation must never introduce separate durable inbox/outbox/wake/state ledgers when the same facts can be derived from the main ledgers and Mu sessions.
- Follow-up history must never lose the linkage between work item, run, and Mu session/thread.
- `read_thread` / thread inspection must never become unusable for runs created by the always-on system.
- Always-on runs must never invoke `ask_user` or any equivalent live-user-feedback tool.
- The supervisor must never enqueue an unbounded backlog of missed recurring occurrences after downtime.
- A blocked or needs-user run must never be reported as completed.
- Recurring jobs must never silently stop running because one previous run compacted, handed off, or otherwise changed its internal Mu session state.

# 4. Inputs / Outputs

## Input surface

- `mu always-on create --workspace <path> [--agent <id>] --provider <provider> --model <model> [--thinking <level>]`
- `mu always-on agents`
- `mu always-on set-default <agent-id>`
- `mu always-on status [--agent <id>]`
- `mu always-on send [--agent <id>] [--workspace <path>] [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"`
- `mu always-on schedule [--agent <id>] --at <iso-datetime> [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"`
- `mu always-on schedule [--agent <id>] --cron "<expr>" [--timezone <tz>] [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"`
- `mu always-on jobs [--agent <id>]`
- `mu always-on runs <job-id>`
- `mu always-on follow-up <job-id> "<instruction>"`
- `mu always-on thread <run-id>` or equivalent run-to-thread inspection surface

## Success outputs

- Human-readable CLI confirmation with ids and resolved workspace/agent information.
- Append-only facts in the always-on ledgers.
- A Mu session/thread for each run.
- A durable `sessionId` link on each run.
- Completion or blocker notification output.

## Failure outputs

- Clear error when no global default agent exists for an untargeted command.
- Clear error when a provided agent id, job id, or run id does not exist.
- Clear error when schedule syntax is invalid.
- Clear error when the workspace path is missing or unusable at execution time.
- Clear error when model/provider credentials are unavailable at execution time.

## Authoritative ledger facts

The append-only ledgers under `~/.mu/agent/always-on/` are the durable source of truth:

- `agents.jsonl`
  - `agent_created`
  - `agent_disabled`
  - `workspace_default_set`
- `work-items.jsonl`
  - `work_item_created`
  - `work_item_disabled`
- `runs.jsonl`
  - `run_started`
  - `run_finished`

## Derived logical objects

These views are derived from the ledgers and linked Mu sessions:

```ts
type AgentConfig = {
  agentId: string
  workspacePath: string
  provider: string
  modelId: string
  thinkingLevel: string
  enabled: boolean
  createdAt: string
}

type WorkItem = {
  workItemId: string
  agentId: string
  workspacePath?: string
  instruction: string
  executionTarget?: {
    provider: string
    modelId: string
    thinkingLevel: string
  }
  relatedWorkItemIds?: string[]
  relatedSessionIds?: string[]
  schedule?: { kind: "once"; at: string } | { kind: "recurring"; cron: string; timezone?: string }
  createdAt: string
  disabledAt?: string
}

type Run = {
  runId: string
  workItemId: string
  agentId: string
  trigger: "manual" | "schedule"
  scheduledOccurrenceKey?: string
  provider: string
  modelId: string
  thinkingLevel: string
  sessionId: string
  startedAt: string
  finishedAt?: string
  outcome?: "completed" | "blocked" | "needs_user" | "error" | "abandoned"
}
```

## Derived views

Do not store these separately:

- pending queue
- next due scheduled work
- current agent status
- latest job summary
- follow-up lineage summary

Derive them from:

- append-only ledgers
- active lock ownership
- Mu session/thread history

# 5. Edge Cases

- Create a second agent for the same workspace and switch which one is default.
- Send work without an explicit agent id when no global default agent exists.
- Send work from outside the target workspace without an explicit workspace override.
- Schedule a one-off run in the past.
- Recurring work becomes due while the previous run is still active.
- Recurring work spans DST/timezone transitions.
- The supervisor crashes after `run_started` but before `run_finished`.
- The supervisor misses a file-watch event while the process is alive.
- The workspace path no longer exists when a scheduled run becomes due.
- The configured provider/model exists at create time but credentials are missing at run time.
- A follow-up references a prior job whose linked session/thread was compacted or handed off.
- A follow-up references a stale or missing session id.
- A job is disabled after some runs already happened.
- Thread inspection must still work when the run used Mu compaction or session continuation behavior.

# 6. Constraints

- Keep the always-on supervisor separate from the existing Mu TUI/runtime loop.
- Use append-only JSONL ledgers under `~/.mu/agent/always-on/`.
- Reuse Mu itself for execution; do not introduce a second agent runtime.
- Treat provider/model/thinking level as explicit always-on agent configuration and surface it in CLI-visible status/inspection output.
- Treat provider/model/thinking override as explicit work-item configuration and record the effective tuple on each run.
- Use one global default agent for untargeted commands; the first created agent becomes default automatically and later default changes require explicit `set-default`.
- Prefer derived state over extra stored summaries, caches, or sidecar ledgers.
- Keep the v1 scope local-first and single-user; generic remote DB/broker/webhook infrastructure is out of scope.
- Tick is a wake mechanism, not the primary durable abstraction.
- Event wake + reconciliation tick must be deterministic under test.
- If downtime caused multiple missed recurring occurrences, only the latest missed occurrence is eligible to run on restart.
- If a recurring occurrence becomes due while a prior run is still active, only one follow-on occurrence may remain queued.
- Always-on mode must remove tools that require live user feedback, including `ask_user`.
- No `any` types.
- Do not use `npm run dev` as part of verification.
- The approved primary execution target for real end-to-end validation is `openai-codex / gpt-5.4 / medium` unless a narrower test seam is intentionally used.
- Verification must include:
  - targeted automated tests with fake clocks / temp config dirs where possible
  - real CLI surface verification via XTUI
  - final `npm run check`

# 7. Definition of Done

- `mu always-on create` works, auto-generates an id when omitted, and persists the new agent.
- The first created agent becomes the global default automatically, and `set-default` changes the global default explicitly.
- The global default agent can be resolved and inspected, including provider/model/thinking configuration.
- `mu always-on send` creates a durable work item and causes a run to execute against Mu.
- Invocation-time provider/model/thinking overrides work for `send`, `schedule`, and `follow-up` and are reflected in the resulting run metadata and visible CLI output.
- Follow-up without an explicit execution tuple inherits the prior run's effective provider/model/thinking tuple.
- The resulting run records a linked Mu `sessionId` and terminal outcome.
- `mu always-on schedule --at ...` runs once at the right time.
- `mu always-on schedule --cron ...` runs recurring occurrences, runs only the latest missed occurrence after downtime, and does not duplicate the same occurrence across reconciliation/restart.
- The supervisor wakes from:
  - new work append events
  - due schedule scans
  - periodic reconciliation tick
- If a recurring occurrence overlaps an active run, exactly one follow-on occurrence remains queued for that job.
- `mu always-on follow-up <job-id> ...` creates a linked new work item and preserves job/run/thread lineage.
- `mu always-on jobs`, `runs`, `status`, and thread inspection surfaces are usable and correct.
- Completion and blocker outcomes trigger the expected notifications.
- Restart/recovery preserves accepted work, marks interrupted runs abandoned/errored, creates replacement runs when required, and avoids duplicate execution.
- Always-on execution runs without `ask_user` or equivalent live-user-feedback tools.
- `npm run check` is green.

## Verification Contract

### Red checks
- Missing agent-registry/default-resolution behavior is reproduced with targeted failing tests.
- Missing send-to-run lifecycle behavior is reproduced with targeted failing tests.
- Missing schedule/tick/dedup behavior is reproduced with targeted failing tests.
- Missing follow-up/history/thread linkage behavior is reproduced with targeted failing tests.
- Missing execution-tuple override precedence is reproduced with targeted failing tests.
- Missing missed-occurrence, overlap, replacement-run, global-default, and no-ask_user behavior is reproduced with targeted failing tests.

### Green checks
- Targeted agent-registry/default-resolution tests pass.
- Targeted send-to-run lifecycle tests pass.
- Targeted schedule/tick/dedup tests pass.
- Targeted follow-up/history/thread linkage tests pass.
- Targeted execution-tuple override tests pass.
- Targeted missed-occurrence, overlap, replacement-run, global-default, and no-ask_user tests pass.
- Notification-specific tests pass.
- `npm run check` passes.

### CLI / XTUI checks
- In a temp `MU_CODING_AGENT_DIR`, create an agent and verify the generated id plus global default designation appear.
- Send immediate work with an explicit execution tuple override and verify jobs/runs output plus linked Mu session creation.
- Schedule one-off and recurring work and verify terminal output plus latest-missed-only and no duplicate occurrence after reconciliation.
- Create a follow-up from a prior job and verify the new work item links to the prior job/run/thread lineage.

### Restart / recovery checks
- Simulate a crash after `run_started` and before `run_finished`.
- Restart the supervisor and verify the accepted work is not lost.
- Verify the same scheduled occurrence is not duplicated after restart.

# 8. What needs to be done to deliver the spec

- Add a new always-on module set under `packages/coding-agent/src/always-on/` for:
  - ledger IO and derivation
  - default-agent resolution
  - schedule parsing / due-occurrence derivation
  - supervisor loop and lock ownership
  - run lifecycle orchestration
  - follow-up/history projections
- Add CLI parsing/wiring for `mu always-on ...` commands.
- Add deterministic test harness helpers for:
  - temp `MU_CODING_AGENT_DIR`
  - temp workspaces
  - fake transport or controlled Mu execution seams
  - fake clock / timer control
  - restart/recovery simulation
- Ensure at least one end-to-end validation path uses `openai-codex / gpt-5.4 / medium` for real Mu session creation.
- Implement invocation-time provider/model/thinking overrides and explicit precedence over agent defaults.
- Implement global-default selection plus explicit `set-default` mutation semantics.
- Implement missed-occurrence latest-only policy, single pending overlap policy, replacement-run recovery semantics, and no-ask_user tool selection for always-on mode.
- Implement immediate send-to-run behavior with linked Mu sessions.
- Implement one-off and recurring schedules with occurrence-key deduplication.
- Implement event wake plus periodic reconciliation tick.
- Implement jobs/runs/status/thread inspection surfaces.
- Implement follow-up creation with linked prior job/session references.
- Reuse existing Mu thread/session semantics for linked session inspection.
- Reuse existing notification infrastructure for completion/blocker outcomes.
- Add targeted automated tests and XTUI verification evidence for each milestone.
