# Mission Architecture: `always-on-agent-v1`

## Summary

Implement `mu always-on` as a separate always-on supervisor around a durable task system.

The approved v1 shape is:

- append-only JSONL ledgers under `~/.mu/agent/always-on/`
- one global default agent for untargeted commands
- provider/model/thinking level stored durably per always-on agent
- per-work-item provider/model/thinking override when the invocation explicitly requests a different execution tuple
- first-class work items with optional one-off or recurring schedules
- event wake on new work + periodic reconciliation tick
- Mu itself executes each due work item as an independent run/thread
- jobs are the primary object; Mu threads are execution history

The durable truths are the task system facts and run lifecycle facts, not synthetic chat ticks.

## Boundaries

### `packages/coding-agent/src/always-on/*`
- Own the new always-on domain.
- Own append-only ledgers for agent facts, work-item facts, and run facts.
- Own global-default resolution plus explicit agent/workspace targeting.
- Own supervisor wake loop, reconciliation tick, file watching, and run claiming.
- Own schedule parsing, due-occurrence derivation, and occurrence-key deduplication.
- Own follow-up creation and job/run inspection projections.

### `packages/coding-agent/src/main.ts`
- Own `mu always-on ...` CLI parsing and wiring.
- Own the human-facing command surface for create/send/schedule/jobs/runs/follow-up/status/thread.
- Keep command behavior narrow and explicit.

### Existing Mu runtime and sessions
- Reuse Mu for execution instead of introducing a second agent runtime.
- Reuse session persistence and thread lookup semantics for each run.
- Keep each run as its own Mu session/thread with a linked `sessionId`.
- Keep changes to `packages/agent/*` minimal and additive; only add seams if the new supervisor truly cannot be implemented with existing runtime entrypoints.

### Test surface
- Unit tests must cover ledger derivation, default-agent resolution, schedule occurrence derivation, occurrence deduplication, and follow-up lineage.
- Integration tests must cover immediate send-to-run behavior, restart/recovery, and linked Mu session creation.
- XTUI verification must cover the user-facing CLI paths and visible terminal output for create/send/schedule/jobs/runs/follow-up/status.

## Abstractions

Prefer these primary abstractions:

- `AgentConfig` — stable worker identity and workspace/model defaults
- `WorkItem` — durable requested work with optional schedule, lineage links, and execution-tuple override
- `Run` — one execution of one work item with one Mu `sessionId` and one effective provider/model/thinking tuple

Authoritative storage is append-only fact streams, not mutable summaries:

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

Derived views should stay small and explicit:

- resolve the global default agent and explicit targeting overrides
- list open work items
- derive the next due scheduled occurrence
- derive whether a scheduled occurrence has already run
- derive job lineage and related thread/session ids
- derive visible status from locks + ledgers + session history

Do not introduce separate durable inbox/outbox/wake/state ledgers.

## Tradeoffs

### Chosen design: separate supervisor + Mu per-run sessions
- Keeps the always-on control plane outside the TUI.
- Reuses existing Mu runtime, session storage, and thread tooling.
- Makes each execution legible and resumable as a real Mu thread.
- Avoids one giant long-lived conversation becoming the only source of truth.

### Chosen design: append-only JSONL ledgers
- Auditable and grep-friendly.
- Easy to inspect and repair locally.
- Good fit for a single-user local always-on worker.
- Avoids introducing a database before correctness is proven.

### Chosen design: event wake + periodic reconciliation tick
- New work should wake the supervisor immediately when possible.
- The periodic tick exists as a safety net for missed file-watch events and due schedule scans.
- Keeps the LLM out of the idle loop.

### Rejected design: synthetic chat tick as primary durable state
- Makes the model poll for work instead of the supervisor deriving work from facts.
- Spends model turns to learn that nothing changed.
- Blurs the boundary between control-plane wakeups and actual user work.

### Rejected design: separate inbox/outbox/wake/state ledgers
- Adds duplicated state and more synchronization surfaces.
- Encourages write-managed summaries instead of derived views.
- Makes restart/recovery reasoning harder, not easier.

### Rejected design: one persistent thread per agent
- Couples unrelated jobs together.
- Makes follow-ups and history less explicit.
- Weakens inspectability and correctness around independent runs.

## What Matters Most

1. Reliable always-on worker behavior with no lost accepted work.
2. No duplicate execution of the same scheduled occurrence.
3. Correct provider/model/thinking configuration for each always-on agent.
4. Correct override precedence when a work invocation explicitly requests a different provider/model/thinking tuple.
5. Deterministic handling of missed recurring occurrences, overlap, and restart recovery.
6. Clear linkage between job → run → Mu thread/session.
7. Simple local operability: inspect ledgers, inspect runs, inspect threads.
8. Deterministic verification using fake clocks, temp config dirs, and real CLI surface checks.

## Approved Design Decisions

- Keep the supervisor separate from the existing Mu TUI/runtime.
- Use append-only JSONL ledgers under `~/.mu/agent/always-on/`.
- Optimize for simplicity and auditability over lowest latency.
- Context for work items is `workspace path + free-text instruction`.
- Use live context at execution time.
- Support both one-off and recurring schedules.
- Notify on completion and blocker.
- Jobs are independent, but must point to past jobs and threads when helpful.
- Auto-generate `agentId` on create when omitted.
- The first created agent becomes the global default automatically; later changes require explicit `set-default`.
- Show generated `agentId` after create and in list/status output.
- Treat provider, model, and thinking level as first-class always-on agent configuration, not incidental runtime state.
- Allow `send`, `schedule`, and `follow-up` to specify an explicit provider/model/thinking tuple for that work item.
- When a work item specifies an execution tuple, that override wins over the agent default for that run only.
- If a follow-up does not restate the execution tuple, it inherits the prior job/run's effective tuple.
- If multiple recurring occurrences were missed while the supervisor was down, only the latest missed occurrence is run on restart.
- If a recurring occurrence becomes due while the current run is still active, queue exactly one pending follow-on occurrence after the current run finishes.
- If the supervisor crashes after `run_started`, restart creates a replacement run and marks the old run abandoned/errored.
- Always-on execution must exclude tools that require live human feedback, including `ask_user`.
- For this mission's real end-to-end validation, the approved primary execution target is `openai-codex / gpt-5.4 / medium`.

## Out of Scope

- Generic remote database or broker integration.
- Distributed multi-host locks or leader election.
- A remote webhook service or cloud scheduler.
- A second agent runtime distinct from Mu.
- A single immortal Mu conversation per agent.
- User-visible background polling by the model when no work is due.
