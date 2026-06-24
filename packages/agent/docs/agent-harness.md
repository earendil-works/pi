# AgentHarness lifecycle

`AgentHarness` is the orchestration layer above the low-level agent loop. It owns session persistence, runtime configuration, resource resolution, operation locking, and extension-facing mutation semantics.

This document describes the current direction and implemented behavior. Some extension/session-facade details are planned and called out explicitly.

## Ultimate lifecycle goal

Harness listeners and hooks should be able to close over the `AgentHarness` instance and call public harness APIs from any event where those APIs are documented as allowed. Those calls must not corrupt in-flight turn snapshots, reorder persisted transcript entries, lose pending writes, deadlock settlement, or leave the harness in the wrong phase.

The intended rule is:

- structural operations remain rejected while busy
- queue operations are accepted at documented turn-safe points
- runtime config setters update future snapshots without mutating the current provider request
- session writes made while busy are durably queued and flushed in deterministic order
- getters return latest harness config, not in-flight snapshots
- listeners/hooks currently receive no facade; if they close over the raw harness and call settlement APIs such as `waitForIdle()` during the active run, they can deadlock. A future facade should expose `runWhenIdle()` instead.

`AssistantMessageStream` already decouples provider transport streaming, such as SSE or websocket reads, from downstream event consumption. The harness can therefore await listeners, extension hooks, persistence, and save-point work without blocking the provider transport reader or reintroducing ad hoc event queues. Lifecycle code should prefer explicit awaited sequencing at harness boundaries over fire-and-forget hook/event settlement.

A final lifecycle hardening pass should prove these guarantees with a broad listener/hook reentrancy test suite.

## Error handling

The current split is:

- low-level capabilities and helpers use `Result<TValue, TError>` where expected failures are contained and must not throw, such as `ExecutionEnv`, filesystem/shell operations, shell-output capture, resource loading, and compaction helpers
- high-level mutation/orchestration APIs such as `Session` and `AgentHarness` reject/throw instead of returning bare results that can be ignored
- public `AgentHarness` failures are normalized to `AgentHarnessError` where practical; subsystem errors are preserved as `cause`

Harness events observe committed state. Public mutators validate required input and persistence before committing when practical, then await notifications. If a hook or subscriber fails after commit, the state change is not rolled back and the public method rejects with `AgentHarnessError` code `"hook"`.

## State model

The harness separates state into four categories.

### Harness config

Harness config is the latest runtime configuration set by the application or extensions:

- model
- thinking level
- tools
- active tool names
- resources
- stream options
- system prompt or system prompt provider

Getters return harness config. They do not return the snapshot used by an in-flight provider request.

Setters update harness config immediately, including while a turn is in flight. Changes affect the next turn snapshot, not the currently running provider request.

`setResources()` accepts concrete resources and emits `resources_update` on every call with shallow-copied current and previous resources. Applications own loading/reloading resources from disk or other sources and should call `setResources()` with new values.

`getResources()` returns shallow-copied current resources. It is a live config read, not the last turn snapshot.

### Turn snapshot

A turn snapshot is the concrete state used for one LLM turn. It is created by `createTurnState()` and contains:

- persisted session messages
- resolved resources
- resolved system prompt
- model
- thinking level
- all tools
- active tools
- stream options
- derived session id

Static option values are used directly. System-prompt provider callbacks are invoked once per `createTurnState()` call. All logic for that turn uses the same snapshot.

Resource arrays are shallow-copied when a snapshot is created. Individual skill and prompt-template objects are not deep-copied.

Stream options are shallow-copied when a snapshot is created. `headers` and `metadata` maps are shallow-copied; their values are not deep-copied. Credentials from `getApiKeyAndHeaders()` are resolved per provider request so expiring tokens can refresh, but the configured stream options and derived session id come from the current turn snapshot.

### Session

The session contains persisted entries only. Session reads return persisted state and do not include queued writes.

Session storage implementations must persist leaf changes as `leaf` entries. `setLeafId()` is not an in-memory-only cursor update; it appends a durable entry whose `targetId` is the active tree leaf or `null` for root. Reopening storage must reconstruct the current leaf from the latest persisted leaf-affecting entry.

### Pending session writes

Session writes requested while an operation is active are queued as pending session writes. Pending writes are based on session-entry shapes without generated fields (`id`, `parentId`, `timestamp`).

Pending session writes are always persisted. They are flushed at save points, at operation settlement, and in failure cleanup.

A public pending-writes/session-facade API is planned but not implemented yet.

## Operation phases

The harness has an explicit phase:

```ts
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

Structural operations require `phase === "idle"` and synchronously set the phase before the first `await`:

- `prompt`
- `skill`
- `promptFromTemplate`
- `compact`
- `navigateTree`

Starting another structural operation while the harness is not idle rejects with `AgentHarnessError` code `"busy"`.

The following operations are allowed during a turn where appropriate:

- `steer`
- `followUp`
- `nextTurn`
- `abort`
- runtime config setters

Phase/settlement semantics are still provisional and need a full lifecycle pass.

## Turn execution

`prompt`, `skill`, and `promptFromTemplate` follow the same flow:

1. Assert idle and set phase to `"turn"`.
2. Create a turn snapshot with `createTurnState()`.
3. Derive invocation text from that snapshot.
4. Execute the turn with `executeTurn()`.

`skill` and `promptFromTemplate` resolve their resource from the same snapshot that is passed to the turn. They do not resolve resources separately.

`steer`, `followUp`, and `nextTurn` accept text plus optional images and create user messages internally. `nextTurn` messages are inserted before the new user message on the next user-initiated turn.

Queue modes are live, not turn-snapshotted:

- `getSteeringMode()` / `setSteeringMode()`
- `getFollowUpMode()` / `setFollowUpMode()`

Changing a queue mode during a run affects the next queue drain. Queue drains happen at safe points.

## Save points

A save point occurs after an assistant turn and its tool-result messages have completed.

At a save point the harness:

1. flushes pending session writes after the agent-emitted messages for that turn
2. creates a fresh turn snapshot if the low-level loop may continue
3. applies the fresh context/model/thinking-level/stream-options/session-id state before the next provider request

This lets model, thinking level, tool, resource, stream option, and system prompt changes made during a turn affect the next turn in the same run, while never mutating an in-flight provider request. Because provider transport reading is already decoupled by `AssistantMessageStream`, save-point work and hook settlement can be awaited directly to keep transcript/session ordering deterministic. The loop callbacks are not recreated at save points.

The low-level loop converts harness `ThinkingLevel` to provider `reasoning` at the provider boundary:

- `"off"` -> `undefined`
- all other thinking levels pass through

No state refresh is needed on `agent_end` except flushing leftover pending session writes and clearing the operation phase. The exact `settled` event timing is still under review.

If the system-prompt callback throws while starting `prompt`, `skill`, or `promptFromTemplate`, the operation rejects with `AgentHarnessError` and the harness returns to idle. If it throws from the save-point snapshot created by `prepareNextTurn`, the low-level agent run records an assistant error message.

## Hooks and events

The target hook system is described in [hooks.md](./hooks.md).

Summary:

- `AgentHarness` emits typed hook events and consumes typed results.
- A single hooks implementation owns registration, cleanup, provenance, and result reducers.
- Observational and mutation hooks use one event-specific `on()` API; the event result type determines whether a handler may return a result.
- Result-producing events are reduced by typed reducer tables; app-specific hooks add reducers only for app-specific result-producing events.
- Hook registration provenance is sidecar metadata on the registration. Resource and tool provenance belongs on app-specific concrete value types.
- Hook context should be a plain object of facades, not raw internals or late-bound getter mazes.

Event payloads describe what is happening. Harness getters describe latest config for future snapshots. Hook and listener settlement should be awaited in lifecycle order where possible; transport backpressure is handled below the harness by `AssistantMessageStream`, so the harness does not need a separate async event queue merely to keep SSE or websocket reads flowing.

## Planned session facade

Extensions should eventually interact with a harness-scoped `HarnessSession` facade rather than the raw session. The facade should wrap the internal session and enforce harness pending-write ordering semantics. Once this exists, hooks and event listeners can receive a context that exposes the full `AgentHarness` plus the session facade without giving direct access to unordered raw session writes.

Planned read semantics:

- reads delegate to persisted session state
- reads do not include queued pending writes

Planned write semantics:

- idle: persist immediately
- busy: enqueue as pending session writes

A planned diagnostics API may expose pending writes explicitly:

```ts
getPendingWrites(): readonly PendingSessionWrite[]
```

Agent-emitted messages are persisted on `message_end` to preserve transcript ordering. Pending extension/session writes flush after those messages at save points.

## Abort

Abort is allowed during a turn. It aborts the low-level run and clears steering/follow-up queues.

Abort does not clear `nextTurn` messages. Messages queued with `nextTurn()` survive abort and are inserted before the user message on the next user-initiated turn.

Abort does not discard pending session writes. Pending writes flush at the next save point if reached, at `agent_end`, or in operation failure cleanup.

Abort barrier semantics still need an audit.

## Compaction and tree navigation

Compaction and tree navigation are structural session mutations.

They are allowed only while idle and are not queued. They operate on persisted session state. The next prompt creates a fresh turn snapshot.

Branch summary generation is part of the tree navigation operation.

Auto-compaction and retry decision points are not implemented in `AgentHarness` yet.

## Test organization

Harness tests should stay focused by area instead of growing one large catch-all file.

Current structure:

- `packages/agent/test/harness/agent-harness.test.ts`: core lifecycle and public API behavior.
- `packages/agent/test/harness/agent-harness-stream.test.ts`: stream options and provider hook semantics.

Preferred future structure:

- `agent-harness-resources.test.ts`: resource snapshot/loading semantics.
- `agent-harness-tools.test.ts`: tool registry getters, active-tool semantics, and update events.
- `agent-harness-lifecycle.test.ts`: phase/save-point/settled/reentrancy behavior.

Use the `pi-ai` faux provider (`registerFauxProvider`, `fauxAssistantMessage`) for deterministic harness/provider tests. Faux response factories can inspect `StreamOptions`, invoke `options.onPayload`, and return scripted assistant messages without real provider APIs or network access.

Harness coverage is configured separately from the default package test run:

```bash
npm run test:harness
npm run coverage:harness
```

`coverage:harness` runs `test/harness/**/*.test.ts` and reports coverage for `src/harness/**/*.ts` plus the non-harness runtime files it directly exercises (`src/agent.ts` and `src/agent-loop.ts`) into `coverage/harness`. Type-only dependencies such as `src/types.ts` are not included because they have no meaningful runtime coverage.

## Implementation todo

This list tracks the remaining work before treating `AgentHarness` as migration-ready. Active/planned items are ordered from easiest to hardest. Completed items are archived at the bottom.

### 1. Add explicit tool registry read/update semantics

Status: In progress

Done:

- Added `setTools(tools, activeToolNames?)`.
- Added `setActiveTools(toolNames)`.
- Invalid active tool names reject with `AgentHarnessError`.
- Added generic app tool shape via `AgentHarness<TSkill, TPromptTemplate, TTool>`.
- Exported `QueueMode` from core types.
- Added `AgentHarnessOptions.steeringMode` and `followUpMode`.
- Added live `getSteeringMode()` / `setSteeringMode()` and `getFollowUpMode()` / `setFollowUpMode()`.
- Added `getTools()` and `getActiveTools()`.
- Added `tools_update` observability events, including active-tool-only updates.
- Active tool changes are persisted as branch-scoped `active_tools_change` entries.
- Duplicate tool names and duplicate active tool names reject.

Remaining:

- None.

Notes:

- Observability design: [observability.md](./observability.md)

### 2. Design per-`AgentHarness` model registry

Status: Planned

Done:

- Current `setModel()` behavior is preserved.

Remaining:

- Decide how applications supply the model registry.
- Decide whether the harness stores concrete `Model` objects, model references, or both.
- Validate model selection against the registry.
- Define model change semantics during active turns and save points.

### 3. Full `AgentHarness` lifecycle/state pass

Status: In progress

Done:

- Removed constructor `void syncFromTree()`, `syncFromTree()`, `liveOperationId`, and `shell()`.
- Added `createTurnState()`, `applyTurnState()`, and `executeTurn()`.
- Added explicit `phase` in place of boolean idle state.
- Save points refresh context, model, thinking level, stream options, and session snapshot state.
- Pending session writes use session-entry shapes without generated fields.
- Pending session writes flush at save points, settlement, and failure cleanup.
- `steer`, `followUp`, and `nextTurn` create user messages from text plus optional images.
- `nextTurn` messages are inserted before the new user prompt.
- Structural compaction/tree operations restore phase with `finally`.
- Public harness failures normalize subsystem causes to `AgentHarnessError`.
- Pending session writes flush one-by-one and are not dropped on failure.
- Queue drains roll back if queue-update notification fails.
- `message_end` persistence happens before subscriber notification.
- `abort()` signals cancellation before notifications and still waits for idle through notification errors.
- Idle model/thinking/tool updates validate and persist before committing in-memory state.
- `setLeafId()` persists durable `leaf` entries so tree navigation survives storage reopen.

Remaining:

- Finalize phase/idle semantics.
- Audit whether `settled` can fire too early.
- Make session writes inside `settled` callbacks deterministic.
- Audit follow-up behavior around `agent_end`.
- Implement auto-compaction decision point.
- Implement retry handling.
- Verify `before_agent_start` hook semantics against coding-agent.
- Decide whether `before_agent_start` needs more turn info such as tools/tool snippets.
- Document or change runtime config event timing while busy.
- Audit `abort()` barrier semantics.

### 4. Implement generic hook/event extension mechanism

Status: Designed in [hooks.md](./hooks.md), not implemented

Done:

- Removed `AgentHarnessContext`.
- Hooks receive only event payloads.
- `emitHook(event)` derives the hook type from `event.type`.
- Provider request/payload hooks have ordered transform semantics.

Remaining:

- Add `HookEvent`, `ResultOf`, registration options with generic source metadata, and the single `AgentHarnessHooks` implementation.
- Move result chaining out of `AgentHarness` into reducer functions.
- Type-check base harness reducers so every result-producing `AgentHarnessEvent` has reducer semantics.
- Make `AgentHarness` accept and expose the concrete hooks instance with constructor inference for app-specific hooks.
- Define the initial harness/context facades exposed through hook context.
- Preserve current provider hook behavior, including stream option patch deletion semantics.
- Add parity tests for reducer semantics: transform chaining, patch chaining, early block/cancel, cleanup, source metadata, and typed app-specific reducer coverage.

Notes:

- Hook design: [hooks.md](./hooks.md)

### 5. Spike semi-durable harness/session recovery

Status: Planned

Done:

- Wrote durability design: [durable-harness.md](./durable-harness.md)

Remaining:

- Decide whether session owns all durable harness state or whether any sidecars are needed for large blobs.
- Define durable entries for queues, pending writes, operations, turns, provider requests, and tool calls.
- Define resume requirements for app-provided tools, models, extensions, resources, hooks, and auth providers.
- Define conservative recovery policy for unfinished agent turns, provider requests, tool calls, compaction, and tree navigation.
- Prototype reducer-based recovery from session entries.
- Decide whether interrupted operations append user-visible messages or only internal operation entries.

Notes:

- Provider streams are not resumable; recovery should restart from durable boundaries or mark operations interrupted.
- Unfinished tool calls are unsafe to retry unless tools declare idempotent/retry-safe behavior.

### 6. Final lifecycle hardening suite

Status: Planned

Done:

- None.

Remaining:

- Add broad listener/hook reentrancy tests across relevant events.
- Test runtime config setters from low-level lifecycle events and harness events.
- Test runtime config observability for model, thinking, resources, tools, active tools, and stream options.
- Test resource/tool/model/thinking/stream-option updates during active turns and save points.
- Test session writes from listeners and hooks, including `settled` writes.
- Test queue operations from turn events, tool events, and provider hooks.
- Test rejected structural operations while busy.
- Test abort from listeners/hooks.
- Test getter behavior during active operations.
- Test deterministic ordering of agent-emitted messages and pending listener writes.
- Test no deadlocks when async listeners call harness APIs and await them.
- Test phase cleanup through success, provider error, hook error, abort, compaction, and tree navigation.

### 7. Later coding-agent migration plan

Status: Planned

Done:

- None.

Remaining:

- Map coding-agent resources to sourced loaders.
- Keep app-level resource dedupe/provenance outside the harness.
- Adapt extension loading to the future hook/session facade.
- Preserve UI/session behavior outside core.
- Move coding-agent stream/auth/retry/header behavior onto harness stream configuration and provider hooks.

---

## Completed implementation todo

### 8. Remove `Agent` dependency from `AgentHarness`

Status: Done

Done:

- `AgentHarness` calls `runAgentLoop()` directly.
- Harness owns run lifecycle, abort controller, queue draining, provider stream config, event reduction, session persistence, pending write flushing, and save-point snapshots.
- Harness tests cover prompt construction, queue draining, abort behavior, save-point refresh, pending write ordering, awaited listener settlement, tool hooks, and provider stream wrapping.

Remaining:

- None.

Notes:

- Broader listener/hook reentrancy coverage is tracked in item 6.

### 9. Finish curated provider/stream configuration

Status: Done

Done:

- Added curated `AgentHarnessOptions.streamOptions`, `getStreamOptions()`, and `setStreamOptions()`.
- Stream options, headers, metadata, and derived session id are snapshotted per turn.
- Harness-owned stream wrapper calls `streamSimple()` and keeps lifecycle-owned `signal` and `reasoning` from the low-level loop.
- `getApiKeyAndHeaders()` resolves credentials per provider request.
- `before_provider_request`, `before_provider_payload`, and `after_provider_response` hooks are implemented.
- Stream option patching supports explicit field deletion and ordered hook chaining.
- `agent-harness-stream.test.ts` covers forwarding, auth merge, hook patching/deletion/chaining, payload hooks, and busy/save-point snapshot behavior.

Remaining:

- None.

### 10. Complete low-level `Result` cleanup

Status: Done

Done:

- Added generic `Result<TValue, TError>` plus helpers.
- Updated `ExecutionEnv` and `NodeExecutionEnv` to return typed results for filesystem/process operations.
- Split filesystem and shell capabilities.
- Moved JSONL session storage/repo onto filesystem picks instead of direct Node imports.
- Added `ExecutionEnv.appendFile()` for streaming append use cases.
- Updated skill and prompt-template loaders to consume `ExecutionEnv` results.
- Updated shell output capture to return a result and use `ExecutionEnv`, including full-output spill via `appendFile()`.
- Removed `NodeExecutionEnv` from browser-safe root exports.
- Replaced `Buffer` usage in generic truncation utilities with runtime-neutral UTF-8 handling.
- Converted compaction and branch-summary helpers to typed result returns.
- Added `readTextLines()` so JSONL metadata loading reads only the header line.
- Removed no-op abort handling from Node filesystem methods where cancellation is not meaningful.
- Mapped filesystem errors crossing the session boundary to typed `SessionError`.
- Added typed branch-summary errors and cause-aware public harness error normalization.
- Resource loaders report structured diagnostics for non-`not_found` filesystem failures.
- Expanded `NodeExecutionEnv` tests for file operations, exec errors, aborts, callbacks, timeouts, and shell-output spill.

Remaining:

- None.

Notes:

- Keep low-level capability/helper APIs non-throwing where they return `Result`.
- Keep session storage/repo/session APIs throwing typed `SessionError`.
- Keep public structural harness failures normalized to `AgentHarnessError`.
- Keep Node-specific APIs isolated under `src/harness/env/nodejs.ts`, Node-backed storage/session implementations, or explicit Node-only entry points.
- Audit generic harness utilities for Node globals as APIs are added.
- Audit package exports so browser/generic imports do not pull Node-only modules.
- Keep expanding `ExecutionEnv` and shell-output contract tests as APIs evolve.
