# Codex-Style Harness as Pi Extensions Plan

This document tracks Codex harness/runtime mechanisms and how to reproduce their logic using Pi's extension system. The goal is **not** to copy Codex source or make Pi core identical to Codex. The goal is to build an extension-shaped harness layer that uses Pi extension APIs to observe, queue, orchestrate, persist, and replay agent activity in a Codex-inspired way.

Design stance:

- Prefer **extensions as the delivery unit**.
- Use existing Pi capabilities first: `pi.on`, `pi.registerTool`, `pi.registerCommand`, `pi.sendMessage`, `pi.sendUserMessage`, `pi.appendEntry`, `pi.events`, `ctx.ui`, `ctx.sessionManager`, and tool overrides.
- Do not fight Pi's current `AgentSession` ownership. The harness extension should initially be an **observer/orchestrator/recorder/wrapper layer**, not a replacement runtime.
- Add small core extension seams only when an extension cannot faithfully express the behavior.

Priority levels:

- **P0 Extension spine**: Needed for a useful Codex-style harness extension prototype.
- **P1 Required**: Needed for robust extension-level parity in normal prompt/tool/abort/compact flows.
- **P2 Important**: Improves correctness/reliability; can be staged after the P0/P1 extension is usable.
- **P3 Optional**: Advanced feature; implement only after the harness extension is stable.
- **P4 Defer**: Codex-specific or product-specific; defer unless explicitly needed.

Implementation feasibility:

- **Extension-native**: Can be implemented with current extension APIs.
- **Extension-wrapper**: Can be implemented by wrapping/overriding tools or mapping Pi events into local state.
- **Extension-shadow**: Can be approximated by extension-owned state, but Pi core remains authoritative.
- **Needs seam**: Requires a small core API addition for full behavior.

## P0 Extension Spine

These are the first target. They form the Codex-style harness logic, implemented as a Pi extension layer.

| Mechanism | Codex purpose | Extension-shaped implementation | Feasibility | Priority |
|---|---|---|---|---|
| Typed submission queue (`Submission` / `Op`) | Normalize external actions into typed operations before handling. | Define extension-local `HarnessOp` types. Convert `input`, extension commands, tool events, session events, and explicit API calls into queued ops. Expose `submit(op)` inside the extension and optionally via `pi.events`. | **Extension-native** | **P0** |
| Background `submission_loop` | Single async loop dispatches user input, interrupts, approvals, compaction, shutdown, etc. | Start an extension-owned async loop on `session_start`. It drains `HarnessOp[]`, updates harness state, emits harness events, and calls Pi APIs such as `sendUserMessage`, `sendMessage`, `compact`, or UI prompts. | **Extension-native** | **P0** |
| Queue-pair API (`submit` / event stream) | Clients submit ops and receive async runtime events. | Provide `submit(op)` plus a local event emitter. Mirror important events through `pi.events.emit(...)`, `pi.sendMessage(...)`, and `pi.appendEntry(...)`. | **Extension-native** | **P0** |
| Harness session state | Owns Codex-like state, services, events, task metadata, and persistence for the extension. | Create `HarnessSessionState` reconstructed from `ctx.sessionManager.getBranch()` custom entries on `session_start`. Treat Pi `AgentSession` as authoritative, and the harness state as a derived/control layer. | **Extension-shadow** | **P0** |
| Task abstraction | Represents regular turns, compaction, shell flows, approval flows, or extension-triggered workflows under one state model. | Define extension-local `HarnessTask` records with `taskId`, `kind`, `turnId`, `status`, `abortController`, timestamps, and pending waiters. Update them from Pi lifecycle events. | **Extension-shadow** | **P0** |
| Active turn state | Tracks currently running turn, active task, queued input, cancellation, and completion. | Maintain `activeTurn?: HarnessActiveTurn`. Populate from `agent_start`, `turn_start`, `message_*`, `tool_*`, `turn_end`, `agent_end`, `input`, and abort/shutdown events. | **Extension-shadow** | **P0** |
| Turn state | Stores pending input, approvals, tool outcomes, tool counts, token baseline, and turn-local flags. | Define `HarnessTurnState`. Update from `input`, `tool_call`, `tool_result`, `tool_execution_*`, `message_end`, and `turn_end`. Persist snapshots as custom entries. | **Extension-shadow** | **P0** |
| Tool router/registry split | Separates tool discovery, exposure, dispatch policy, and execution. | Build a harness registry from `pi.getAllTools()` plus extension-registered tools. Track active tools via `pi.getActiveTools()` / `pi.setActiveTools()`. For controlled tools, register wrappers or override built-ins. | **Extension-wrapper** | **P0** |
| Tool orchestrator | Centralizes preflight, approval, policy, execution strategy, and result rewriting. | Use `tool_call` for preflight approval/block/mutation and `tool_result` for result rewriting. For tools needing full execution control, override built-in tools and call underlying operations through wrappers. | **Extension-wrapper** | **P0/P1** |
| Append-only harness log | Persists event stream for replay/reconstruction. | Use `pi.appendEntry("codex-harness:event", event)` for sequenced events. Include `seq`, `sessionId`, `turnId`, `taskId`, timestamp, event type, and payload. Replay from custom entries on `session_start`. | **Extension-native** | **P0/P1** |

## Full Mechanism Inventory

| Mechanism | Purpose | Extension-shaped approach | Feasibility | Priority |
|---|---|---|---|---|
| Typed submission queue (`Submission` / `Op`) | Normalize actions before runtime handling. | Extension-local `HarnessOp` queue fed by Pi events, commands, and explicit extension calls. | Extension-native | **P0** |
| Background `submission_loop` | Central dispatcher for queued ops. | Async queue loop created by the extension on `session_start`; torn down on `session_shutdown`. | Extension-native | **P0** |
| Queue-pair API | Submit ops and publish events. | `submit(op)` plus `pi.events` and custom message/event entries. | Extension-native | **P0** |
| Harness session state | Keep Codex-like session state. | Reconstruct from branch entries and maintain extension-owned state. | Extension-shadow | **P0** |
| Task abstraction | Give workflows uniform lifecycle. | Extension-local `HarnessTask` records updated from Pi events. | Extension-shadow | **P0** |
| Active turn state | Track active turn and cancellation. | Derived from `agent_start`, `turn_start`, tool events, `turn_end`, and `agent_end`. | Extension-shadow | **P0** |
| Turn state | Store turn-local queues/waiters/metrics. | Extension-owned `HarnessTurnState`, persisted as custom entries. | Extension-shadow | **P0** |
| Tool router/registry split | Decouple tool discovery and dispatch policy. | Registry built from `pi.getAllTools()`; wrappers for tools requiring orchestration. | Extension-wrapper | **P0** |
| Tool orchestrator | Preflight, approval, policy, result rewriting. | `tool_call` + `tool_result` middleware; override/wrap tools for full control. | Extension-wrapper | **P0/P1** |
| Append-only harness log | Persist ordered runtime events. | `pi.appendEntry("codex-harness:event", ...)` with sequence numbers. | Extension-native | **P0/P1** |
| Durable turn context snapshot | Freeze per-turn model, cwd, active tools, thinking level, and prompt metadata. | Write `codex-harness:turn-context` custom entries at `before_agent_start` or `turn_start`. Use `ctx.model`, `ctx.cwd`, `pi.getActiveTools()`, `pi.getThinkingLevel()`, and `ctx.getSystemPrompt()`. | Extension-native | **P1** |
| Turn lifecycle events | Emit started/completed/aborted with IDs and timing. | Derive from Pi `agent_start`, `turn_start`, `turn_end`, `agent_end`, `ctx.abort`, and `session_shutdown`; persist harness lifecycle events. | Extension-shadow | **P1** |
| Item lifecycle events | Track assistant/tool/user item start/end separately. | Map `message_start/update/end` and `tool_execution_*` into harness item events. | Extension-native | **P1** |
| Graceful abort protocol | Cancel active work, record interrupted marker, emit abort event. | Wrap `ctx.abort()` / extension command abort. Record a custom interrupted marker. Full Esc ownership may need a core seam if extension must be first-class abort owner. | Extension-shadow / Needs seam | **P1** |
| Same-turn steering validation | Avoid delivering injected input to the wrong turn. | Include `expectedTurnId` in extension `submit({ type: "steer" })`. Compare with extension `activeTurn.turnId` before calling `pi.sendUserMessage(..., { deliverAs: "steer" })`. | Extension-native | **P1** |
| Idle pending work auto-start | Start a turn when work arrives while idle. | If `ctx.isIdle()` and op has `triggerTurn`, call `pi.sendUserMessage` or `pi.sendMessage({ triggerTurn: true })`. | Extension-native | **P1** |
| Out-of-band waiters | Track pending approvals/input/tool responses. | Store waiters in `HarnessTurnState`. Resolve them from UI callbacks, commands, or tool results. | Extension-native | **P1** |
| Tool call runtime | Control concurrency, cancellation, and dispatch source. | For wrapper/override tools, implement per-tool queues and abort-aware execution. For non-wrapper tools, observe only. | Extension-wrapper | **P1** |
| Approval cache | Remember “allow for session” decisions. | Persist decisions with `pi.appendEntry("codex-harness:approval", ...)`; replay on `session_start`. | Extension-native | **P1** |
| Sandbox manager | Select sandbox/execution backend and support escalation. | Implement in wrapped tools through custom operations (`createBashTool`, read/write/edit operation overrides, sandbox extension examples). Full built-in coverage requires tool overrides. | Extension-wrapper | **P1** |
| Rollout reconstruction | Rebuild harness state from persisted log. | Replay custom harness entries from `ctx.sessionManager.getBranch()`. Use Pi session messages as source of truth for LLM history. | Extension-native | **P1** |
| Durable flush/materialize barrier | Ensure log entries are persisted before later actions. | `await pi.appendEntry(...)` before emitting follow-up messages/actions. True cross-entry atomicity with core message writes may need a seam. | Extension-native / Needs seam | **P1** |
| Replacement-history compaction checkpoint | Preserve compacted state for replay. | On `session_before_compact` / `session_compact`, append harness checkpoint metadata and optional replacement summary. Use Pi's compaction entry as source of truth. | Extension-native | **P1** |
| Pre/mid-turn auto-compaction | Compact before or during long turns. | Use `ctx.getContextUsage()` and `ctx.compact()` from events such as `turn_end`, `message_end`, or tool stages. True pre-sampling insertion may require a seam. | Extension-native / Needs seam | **P1/P2** |
| Pending input inspection hooks | Accept/block/enrich queued input. | Implement inside harness queue before calling `pi.sendUserMessage`. Optionally expose `pi.events` hook points for other extensions. | Extension-native | **P2** |
| Permission request hook | Allow extension policies to answer approval prompts. | Add harness-local event `codex-harness:permission_request`; handlers respond before UI prompt. | Extension-native | **P2** |
| Exec policy amendment | Persist approved command/network rules. | Store approval rules as custom entries; apply in `tool_call` or wrapped tools. | Extension-native | **P2** |
| Tool argument diff consumer | Convert streamed argument deltas into structured events. | Limited to `message_update` stream events if provider exposes partial tool calls. Full argument-diff API may need a seam. | Needs seam | **P2** |
| Dynamic tool response ops | Support async external responses. | Register dynamic tools and resolve via extension-managed promises/commands. | Extension-native | **P2** |
| Thread rollback replay | Replay log and drop recent user turns. | Use `/tree`, `ctx.navigateTree`, or fork commands for user-visible history movement; harness log can mark rollback but Pi tree remains authoritative. | Extension-shadow | **P2** |
| Context diff baseline | Persist initial context and later diffs. | Store system prompt/options snapshot and later diffs in harness entries for audit; Pi still sends full prompt as designed. | Extension-shadow | **P2** |
| Previous-turn settings | Remember model/thinking/tools/realtime-like state. | Store turn context snapshots and recover latest on session start. | Extension-native | **P2** |
| Model downshift compaction | Compact before switching to smaller context model. | Wrap model-changing commands/shortcuts where possible; use `ctx.compact()` before `pi.setModel()`. Full Ctrl+P interception may need keybinding integration. | Extension-native / Needs seam | **P2** |
| Model client session | Reuse turn-scoped provider transport/session. | Mostly core/provider-level; extension can only set stream options via hooks. | Needs seam | **P2** |
| Stream retry + fallback events | Surface retry/fallback lifecycle. | Use `before_provider_request` / `after_provider_response` for visibility; fallback control is provider/core-level. | Needs seam | **P2** |
| Token/rate-limit event state | Persist usage and rate-limit observations. | Record message usage at `message_end`; record response headers at `after_provider_response` when available. | Extension-native | **P2** |
| Stop hook continuation | Continue instead of ending when stop policy asks. | At `agent_end`, call `pi.sendUserMessage(..., { deliverAs: "followUp" })` or `pi.sendMessage(..., { triggerTurn: true })`. Exact pre-end continuation may need a seam. | Extension-native / Needs seam | **P2** |
| After-agent abort hook | Abort completion based on post-agent policy. | Approximate by sending corrective follow-up or custom message; exact abort-before-complete needs a seam. | Needs seam | **P2** |
| Session configured event | Emit initial session metadata. | On `session_start`, write and emit `codex-harness:session_configured`. | Extension-native | **P2** |
| Agent status watch | Track pending/running/idle/aborted status. | Maintain status from lifecycle events; publish through `pi.events` and optional status widget. | Extension-native | **P2** |
| Thread lifecycle contributors | Thread/session start/resume/stop callbacks. | Use `session_start`, `session_shutdown`, `session_before_*`, and harness-local events. | Extension-native | **P2** |
| Runtime config reload layer | Reload extension/resources/config state. | Use `ctx.reload()` from commands and rebuild harness state on `session_start`/`resources_discover`. | Extension-native | **P2** |
| Inter-agent mailbox | Deliver agent messages into current/next turns. | Implement with `pi.sendMessage` / `pi.sendUserMessage` and `deliverAs`. Subagents can be tools/commands/extensions. | Extension-native | **P3** |
| Managed network approval | Approve blocked network domains and persist rules. | Implement only for wrapped tools/proxies. General network enforcement requires sandbox/proxy support. | Extension-wrapper / Needs seam | **P3** |
| Tool search / discoverable tools | Search/defer app-scoped tools. | Extension can register a search tool and dynamically activate tools. | Extension-native | **P3** |
| Code-mode worker | Nested code/tool runtime. | Implement as custom tool or subagent extension if needed. | Extension-native | **P3** |
| Server model mismatch warning | Warn when actual server model differs. | Only possible if provider response exposes the data. | Needs seam | **P3** |
| Model verification events | Surface server verification data. | Provider/core-level unless headers/payload expose it. | Needs seam | **P3** |
| Environment manager | Select per-turn runtime environment. | Implement through tool operation overrides, custom flags, and wrapped commands. | Extension-wrapper | **P3** |
| MCP manager / elicitation | Manage MCP servers and elicitation. | Can be extension-level integration later; not required for P0. | Extension-native/P3 | **P3** |
| Shell snapshot / unified exec | Shell state and background process management. | Implement in custom/wrapped bash tools if needed. | Extension-wrapper | **P3** |
| Rollout/inference/tool trace | Structured tracing. | Persist custom trace events and optionally write files. | Extension-native | **P3** |
| Analytics/telemetry metrics | Detailed metrics. | Extension can append metrics entries or send external telemetry. | Extension-native | **P3** |
| Multi-agent v2 / AgentControl | Spawn/wait/message subagents. | Build as extension tools using subprocess `pi`, SDK, or internal message queues. | Extension-native/P3 | **P3/P4** |
| Guardian automated reviewer | Automated approval reviewer. | Implement as approval policy extension later. | Extension-native | **P4** |
| Memory citations/thread memory mode | Track memory citations and memory eligibility. | Extension-specific memory system. | Extension-native | **P4** |
| Realtime conversation handoff | Audio/realtime bridge. | Not needed for extension harness prototype. | Needs seam | **P4** |
| Goal runtime | Long-running goal state. | Can be extension-level state machine later. | Extension-native | **P4** |
| Attestation provider | Environment/request attestations. | Not needed initially. | Needs seam | **P4** |

## P0 Implementation Plan as Extensions

### 1. Create a harness extension package

Suggested layout:

```text
.pi/extensions/codex-harness/
  index.ts
  ops.ts
  queue.ts
  state.ts
  events.ts
  tools.ts
  orchestrator.ts
  log.ts
  replay.ts
```

The extension owns a `HarnessRuntime` object per Pi session. It is created on `session_start` and shut down on `session_shutdown`.

### 2. Define extension-local op and event types

Examples:

```ts
type HarnessOp =
  | { type: "input"; text: string; source: string; deliverAs?: "steer" | "followUp" | "nextTurn" }
  | { type: "turn_started"; turnId: string }
  | { type: "message_started"; messageId: string; role: string }
  | { type: "tool_call"; turnId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_result"; turnId: string; toolCallId: string; toolName: string; result: unknown }
  | { type: "abort"; reason: string }
  | { type: "compact"; reason: string }
  | { type: "shutdown"; reason: string };
```

Events should be persisted as custom session entries with monotonic `seq` values.

### 3. Feed the queue from Pi extension events

Map Pi events into harness ops:

- `input` -> `input`
- `before_agent_start` -> turn/task preparation
- `agent_start` -> task/agent start
- `turn_start` -> turn start
- `message_start/update/end` -> item/message lifecycle
- `tool_execution_start` -> tool execution lifecycle
- `tool_call` -> preflight orchestration
- `tool_result` -> postprocess orchestration
- `tool_execution_end` -> execution completed
- `turn_end` -> turn completed
- `agent_end` -> task completed
- `session_before_compact` / `session_compact` -> compaction ops/checkpoints
- `session_shutdown` -> shutdown op

### 4. Implement shadow session/task/turn state

The extension should maintain:

- `HarnessSessionState`
  - session id/file
  - current status
  - sequence counter
  - active turn
  - task map
  - approval cache
  - tool registry snapshot
- `HarnessTask`
  - id, kind, status, started/completed timestamps
  - current turn id
  - abort controller if extension-owned
- `HarnessTurnState`
  - turn id
  - messages/items observed
  - pending inputs
  - tool calls/results
  - approval waiters
  - context snapshot

This state is reconstructed from custom entries on `session_start`.

### 5. Build a tool registry snapshot

On startup and when tools change:

- read `pi.getAllTools()`
- read `pi.getActiveTools()`
- record source info, active state, descriptions, and schemas
- optionally expose a command to inspect the harness registry

For tools requiring Codex-style control, register wrapper tools or override built-ins.

### 6. Implement first tool orchestrator pass

Use `tool_call` as preflight:

- assign/lookup tool policy
- check approval cache
- ask user through `ctx.ui.confirm()` if needed
- mutate input if policy says so
- block with reason if denied
- persist `permission_request`, `approval_decision`, and `tool_call_preflight` events

Use `tool_result` as postprocess:

- persist result
- rewrite content/details/isError if policy says so
- optionally return `terminate`
- record tool result event

For full execution control, implement wrapper tools that call underlying operations and run the orchestrator internally.

### 6a. First controlled tools: shell command and apply_patch

The first P0 tool work should focus on two Codex-style controlled tools because they exercise the most important harness behavior: permission decisions, cancellation, mutation safety, output shaping, and replayable audit events.

#### `shell_command` / Pi `bash` wrapper

Purpose:

- Route shell execution through the harness orchestrator.
- Centralize approval, command policy, timeout, abort behavior, output truncation, and logging.
- Record each command with enough context to audit or replay the session.

Extension-shaped approach:

1. Start with a `tool_call` policy for Pi's built-in `bash`.
2. Add approval cache entries keyed by normalized command or policy category.
3. Record `shell_command_requested`, `approval_decision`, `shell_command_started`, and `shell_command_completed` harness events.
4. Use `tool_result` to normalize/truncate output and mark policy errors consistently.
5. When stronger control is needed, override `bash` with a wrapper built from Pi's exported bash tool helpers/operations, then run the orchestrator inside the wrapper before executing.

Initial policy examples:

- Ask before destructive commands (`rm`, `sudo`, chmod/chown, package installs, network commands if desired).
- Auto-allow read-only commands (`pwd`, `ls`, `git status`, `rg`, `cat` with truncation rules).
- Deny or require explicit approval for commands outside `ctx.cwd`.
- Apply output truncation and record whether truncation happened.

#### `apply_patch` / file mutation wrapper

Purpose:

- Route file mutations through one safe mutation path.
- Avoid parallel write races.
- Persist exact patch intent and outcome.
- Provide a Codex-like patch tool shape even if implemented with Pi `edit`/`write` operations underneath.

Extension-shaped approach:

1. Register a custom `apply_patch` tool or wrap `edit`/`write` with a shared mutation orchestrator.
2. Normalize target paths relative to `ctx.cwd` and strip a leading `@` from path-like inputs.
3. Use `withFileMutationQueue()` for every target file so parallel tool calls cannot overwrite each other.
4. Validate that patch hunks match current file content before writing.
5. Persist `apply_patch_requested`, `file_mutation_started`, `file_mutation_completed`, and `file_mutation_failed` harness events.
6. Return concise LLM-facing output with details containing changed files, failed hunks, and truncation/debug metadata.

Initial policy examples:

- Ask before writing outside project root or protected paths.
- Block writes to `.env`, secrets, lockfiles, or generated files unless explicitly allowed by policy.
- Keep exact old/new text in persisted details when size permits; hash or truncate large hunks.
- Treat partial application as failure unless the tool explicitly supports multi-edit partial success.

These two tools should be implemented before broader tool-router work because they define the practical policy and persistence contract for the rest of the harness extension.

### 7. Implement append-only harness log

Use custom session entries:

```ts
pi.appendEntry("codex-harness:event", {
  version: 1,
  seq,
  timestamp: new Date().toISOString(),
  sessionId,
  turnId,
  taskId,
  type,
  payload,
});
```

Rules:

- Always append before triggering follow-up work.
- Include enough IDs to replay order and group events by turn/task.
- Use Pi messages/session tree as authoritative LLM history; use harness log as runtime audit/reconstruction layer.

### 8. Add commands for debugging and control

Initial commands:

- `/harness-status` - show current state
- `/harness-log` - inspect recent events
- `/harness-approvals` - list approval cache
- `/harness-clear-approvals` - clear approval cache
- `/harness-replay` - rebuild state from branch and compare with live state

## Core Seams to Consider Later

The P0 extension prototype should avoid core changes. If exact behavior becomes necessary, consider small seams later:

1. Tool wrapper API that can wrap every tool, including tools from other extensions, without overriding each one.
2. A persistence flush API for ordering custom entries relative to core message writes.
3. A first-class abort event/handler so extension-owned state can observe Esc/Ctrl+C before teardown.
4. Provider stream lifecycle hooks that expose retry/fallback and tool argument deltas.
5. Runtime-owner API only if the extension prototype eventually needs to replace the built-in loop.

## Recommended Implementation Order

### Phase 1: P0 extension prototype

1. Create `codex-harness` extension package.
2. Define `HarnessOp`, `HarnessEvent`, queue, and event log.
3. Map Pi lifecycle events into the queue.
4. Maintain shadow session/task/turn state.
5. Persist and replay harness events.
6. Build tool registry snapshots.
7. Implement basic tool preflight/postprocess orchestrator.
8. Add debug commands.

### Phase 2: P1 robustness

1. Persist turn context snapshots.
2. Add approval cache and approval UI.
3. Add same-turn steering validation for extension-injected messages.
4. Add graceful abort markers.
5. Add wrapper/override tools for controlled execution paths.
6. Add compaction checkpoint entries.
7. Add replay validation tests/examples.

### Phase 3: P2 parity

1. Pending input inspection hooks.
2. Context baseline/diff audit entries.
3. Token/rate-limit event recording.
4. Stop-continuation behavior through follow-up messages.
5. Model downshift compaction flow where extension controls model changes.
6. Runtime reload/reconstruction hardening.

### Phase 4: P3/P4 advanced extensions

1. Subagent/mailbox extension.
2. Network/sandbox extension.
3. Tool search/discoverability extension.
4. Telemetry/trace exporter.
5. Guardian-style approval reviewer.
6. Memory/goal systems.

## Core Recommendation

Start with an **extension-level Codex harness emulator**:

1. **Observe** Pi lifecycle events.
2. **Queue** them as typed harness ops.
3. **Maintain** shadow session/task/turn state.
4. **Orchestrate** tools through `tool_call` / `tool_result` and wrappers.
5. **Persist** an append-only harness log with `pi.appendEntry()`.
6. **Replay** that log on session start.

Do not try to replace `AgentSession` first. Make the extension useful as an audit/control/orchestration layer, then add small core seams only where extension APIs cannot express the required behavior.
