---
mode: build
---

# 1. Summary & Recommendation

Add `/always-on` as a built-in TUI mode for Mu.

Recommended v1 design:

- reuse the existing always-on ledgers and supervisor domain as the durable source of truth
- add a shared always-on service layer used by both the existing CLI and the new TUI mode
- keep TUI-owned state minimal: only the current composer mode plus an optional selected agent override
- make plain text in `/always-on` submit an immediate always-on job by default
- expose a small set of mode-specific slash commands for agent selection, scheduling, inspection, follow-up creation, and exit
- expose a small set of mode-scoped always-on tools to the model while the mode is active
- keep the background supervisor as a separate default process owner rather than making the TUI own a second daemon by default

The authoritative truths are still the append-only always-on ledger facts and derived run/thread history. The TUI is a control surface, not a second scheduler.

# 2. What Must be True

- `/always-on` enters an explicit built-in TUI mode.
- The mode is visible in the composer surface, including a distinct meta/border treatment.
- While the mode is active, plain text submission creates an immediate always-on work item instead of a normal chat prompt.
- The mode can optionally target a selected always-on agent override for the current session.
- If no override is selected, the global default always-on agent is used.
- The current always-on ledgers remain the only durable source of truth for agents, jobs, and runs.
- The TUI can inspect current always-on jobs, runs, and linked threads without reading raw JSONL manually.
- The TUI and CLI share one host-side always-on service layer instead of duplicating orchestration logic.
- Mode entry can add mode-scoped always-on tools to the active model/tool surface.
- Mode exit removes those tools and restores the normal chat tool/prompt surface.
- The model-visible always-on tool surface stays small and primitive-oriented.
- The shared service supports one authoritative submission shape that covers:
  - immediate jobs
  - one-off scheduled jobs
  - recurring scheduled jobs
  - follow-up jobs
- Existing always-on scheduling semantics remain intact:
  - one-off jobs run when due
  - recurring jobs run only the latest missed occurrence after downtime
  - overlapping recurring jobs queue at most one follow-on occurrence
- The implementation remains compatible with the existing `mu always-on` CLI behavior.

# 3. What Must Never Happen

- Normal chat mode must never accidentally create always-on jobs.
- Entering `/always-on` must never create a second durable store separate from the existing ledgers.
- The TUI must never own write-managed summaries of jobs, runs, or schedule state that can instead be derived.
- Always-on mode styling must never depend on parsing extension-indicator label text.
- The TUI must never shell out to `mu always-on ...` as its primary integration path when the same behavior can be reached through shared code.
- The same scheduled occurrence must never run twice because of TUI mode behavior.
- Mode-scoped always-on tools must never remain available after mode exit.
- The v1 implementation must never require the TUI to be the default always-on daemon owner.
- The design must never broaden into a second mission/control framework inside the TUI.

# 4. Inputs / Outputs

## Input surface

- `/always-on`
- plain text while `/always-on` is active
- mode-specific slash commands, likely including:
  - `/always-on`
  - `/always-on-exit`
  - `/always-on-agent`
  - `/always-on-schedule`
  - `/always-on-jobs`
  - `/always-on-runs`
  - `/always-on-thread`
  - `/always-on-follow-up`

## Shared service primitives

- `readSnapshot()`
- `submit(spec)`
- `createAgent(input)`
- `setDefaultAgent(input)`
- `readThread(runId)`

## Submission shape

```ts
type AlwaysOnSubmissionSpec =
  | { kind: "immediate"; instruction: string; agentId?: string }
  | { kind: "once"; instruction: string; at: string; agentId?: string }
  | { kind: "recurring"; instruction: string; cron: string; timezone?: string; agentId?: string }
  | { kind: "follow_up"; instruction: string; parentWorkItemId: string; agentId?: string }
```

## Mode-local state

```ts
type ComposerMode = "chat" | "always-on"

type AlwaysOnModeSessionState = {
  selectedAgentId?: string
}
```

## Success outputs

- visible TUI confirmation with job/run ids where applicable
- updated derived job/run/thread views
- correct mode label/border/meta state
- correct mode-scoped tool availability

## Failure outputs

- clear error when no always-on agent/default exists
- clear error when schedule input is invalid
- clear error when a referenced job/run/agent does not exist
- clear error when model/provider credentials are missing at execution time

# 5. Edge Cases

- Enter `/always-on` with no always-on agents configured.
- Enter `/always-on` with no global default agent configured.
- User switches model while always-on mode is active.
- User leaves always-on mode while there is partially prepared slash-command input.
- User submits plain text while the main chat agent is already streaming.
- User creates a follow-up without specifying a valid parent job.
- Selected agent override becomes invalid because the underlying agent was disabled.
- Scheduled jobs are created from the TUI while the external supervisor is not currently running.
- The TUI inspects runs created by a supervisor that was started outside the TUI.

# 6. Constraints

- Reuse the existing always-on domain modules instead of replacing them.
- Prefer one shared service layer over parallel CLI and TUI orchestration code.
- Prefer explicit TUI mode state over indicator-string heuristics.
- Prefer derived job/run/thread views over stored summaries.
- Keep TUI-owned state minimal and session-local.
- Keep the always-on tool surface primitive-oriented rather than subcommand-shaped.
- Keep the v1 scheduler lifetime separate by default; the TUI may inspect and enqueue work without becoming the background daemon owner.
- No `any` types.
- Do not run `npm run dev`.
- Final implementation verification must include `npm run check`.
- UI verification should use XTUI for the real terminal surface.

# 7. Definition of Done

- `/always-on` appears in the TUI slash-command surface.
- Entering `/always-on` changes the composer surface in a visible, testable way.
- Plain text in `/always-on` submits an immediate always-on job and shows a visible confirmation.
- Exiting `/always-on` restores normal chat semantics.
- The shared always-on service is used by both CLI and TUI entry points.
- Mode-scoped always-on tools appear only while the mode is active.
- The tool surface remains small and primitive-oriented.
- Existing scheduling semantics remain green under targeted tests.
- XTUI verification proves the visible mode entry, submission, inspection, and exit flows.
- `npm run check` passes.

# 8. What needs to be done to deliver the spec

- extract a shared always-on service layer from the current CLI-oriented orchestration code
- add explicit built-in TUI mode state for `/always-on`
- generalize tool/prompt refresh so it can respond to mode as well as model
- add mode-specific slash commands and overlays
- add a small set of mode-scoped always-on tools
- add targeted red tests for mode entry/exit, plain-text submission behavior, and mode-scoped tool availability
- add XTUI coverage for the visible always-on mode surface
- keep the existing always-on scheduler tests green while integrating the TUI mode
