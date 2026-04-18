# Architecture Proposal

## Summary

Add `/always-on` as a built-in TUI mode that reuses the existing always-on ledger/scheduler domain instead of building a second always-on app inside the TUI.

The mode should:

- enter a distinct TUI interaction state
- let plain text submit immediate always-on jobs
- expose a small set of mode-specific slash commands
- expose a small set of mode-scoped always-on tools to the model
- keep the append-only always-on ledgers as the only durable source of truth

## Proposed Boundaries

- **Always-on domain layer** stays authoritative for:
  - agent registry
  - work items
  - runs
  - scheduling and reconciliation semantics
- **Shared always-on service layer** serves both CLI and TUI:
  - read snapshot
  - submit work
  - manage agents/defaults
  - inspect threads
- **TUI layer** owns only:
  - whether the current session is in `chat` or `always-on` mode
  - optional selected always-on agent override for the session
  - overlays and slash-command routing
- **Supervisor lifetime** remains separate by default:
  - the TUI can inspect and enqueue work
  - the existing supervisor process remains the default background wake/sleep owner

## Key Abstractions

### `AlwaysOnService`

One shared host-side API used by both CLI and TUI.

Preferred primitives:

- `readSnapshot()`
- `submit(spec)`
- `createAgent(input)`
- `setDefaultAgent(input)`
- `readThread(runId)`

### `AlwaysOnSubmissionSpec`

One authoritative submission shape rather than many narrow helpers.

Expected variants:

- `immediate`
- `once`
- `recurring`
- `follow_up`

### `ComposerMode`

Explicit TUI mode instead of inferring mode from extension-indicator labels.

Expected variants:

- `chat`
- `always-on`

## Tradeoffs

### Accepted

- Add a real TUI mode instead of faking one through extension indicators.
- Add mode-scoped always-on tools in phase 1, but keep them deep and minimal.
- Reuse the existing scheduler/ledger semantics instead of inventing TUI-owned durable state.

### Rejected

- TUI shelling out to `mu always-on ...` as its primary control path.
- TUI owning a second scheduler daemon by default.
- Persistent selected job/run/thread state in the TUI session.
- One tool per CLI subcommand.

## What We Are Optimizing For

- maximum model-driven automation inside `/always-on`
- low duplication between CLI and TUI
- one durable source of truth
- additive extension path for future always-on workflows

## Alternatives Considered

### 1. Wrap the existing CLI from the TUI

- Pro: less initial refactoring
- Con: duplicates parsing/output logic, weak typing, poor test seams

### 2. Implement always-on as an extension-only mode

- Pro: smaller initial product diff
- Con: current extension APIs do not own real mode/tool selection semantics cleanly

### 3. TUI-owned daemon + dashboard

- Pro: richer single-process experience
- Con: adds durable/process state the TUI does not need to own in v1

## Approval Recorded

Recorded human choices from the specification checkpoint:

- plain text in `/always-on` should submit an immediate always-on job by default
- CLI and TUI should share a common always-on service/controller layer
- phase 1 should include both the TUI mode and new always-on tools
- priority is maximum model-driven automation

Refined simplification applied after approval:

- keep the shared service and mode-scoped tools
- minimize TUI-owned state to mode + optional selected agent override
- keep the supervisor as a separate default background owner
