# Work package 09 — LaneSnapshot settled-but-unplaced tools

## Status and baseline

- Repository: `earendil-works/pi`
- Branch at handoff creation: `dev`
- Baseline commit: `d14d6b22327d545d6a253f932165b63e48d7f9c8`
- The user reported the worktree clean immediately before this handoff.
- This document began as an implementation handoff after conversation compaction and now records the implemented design. It is not itself the normative harness specification; `packages/agent/docs/harness.md` remains normative.

## Goal

Keep every started or settled-but-unplaced tool call visible in `LaneSnapshot.operation.runningTools` until its immutable `toolResult` entry is placed in the transcript.

The intended projection is:

```text
planned         → not yet represented in runningTools
effect_pending  → runningTools(status: "running")
outcome_ready   → runningTools(status: "settled")
completed       → transcript toolResult entry
```

For each call after it becomes presentation-active, `runningTools` and placed transcript entries must not have a gap or overlap. Placement is a source-prefix flush, not an all-tools barrier. Remove a call from `runningTools` on its own `entry_added`, never on `turn_end`.

## Original bug

A call disappeared between real-effect completion and source-ordered tree placement:

1. `packages/agent/src/harness/runtime/reducer.ts`: `tool_end` spliced the call out of `runningTools`.
2. `packages/agent/src/harness/runtime/lane.ts`: `captureLaneSnapshot()`, `case "tools"`, projected only `effect_pending` calls and skipped `outcome_ready` calls.
3. The finalized result was already durable at `pendingEntry(resultEntryId)`, but a fresh/reconnected snapshot could not display it.
4. It reappeared only after `entry_added` placed the immutable `toolResult` entry.

For a parallel batch `[A, B, C]`, if B settles while A remains pending, B may stay `outcome_ready` until A is ready. If A is already placed, B can place without waiting for C. Therefore clearing everything at `turn_end` is wrong: early-placed results would temporarily exist in both `transcript` and `runningTools`.

## Confirmed current architecture

Mini does **not** replicate structural object deltas.

- `packages/coding-agent/src/experimental/mini/worker/lane-service.ts` sends one initial full snapshot and then forwards individual `HarnessEvent` objects.
- `packages/coding-agent/src/experimental/mini/tui/session.ts` folds those events through `reduceLaneSnapshot()`.
- Reconnect/rebase fetches another complete snapshot.
- `tool_update` currently carries a complete replacement progress result, not a nested diff.

Implemented durable tool flow in `packages/agent/src/harness/runtime/drive/tools.ts`:

```text
prepare
→ before_tool
→ intent commit (effect_pending + effective args), then tool_start
→ execute/update/checkpoint
→ after_tool
→ finalize
→ publishToolOutcome staging commit (pendingEntry + outcome_ready), then tool_end
→ materializeReady prefix placement
→ entry_added
```

All real, immediate synthetic, cancellation, and recovery outcomes converge through `publishToolOutcome()`.

`Lane.settleOperation()` supports commit-bound events. It commits, publishes process-local state, constructs the event batch, and the public operation awaits delivery. In parallel execution, `materializeReady()` is scheduled only after the outcome-completion promise resolves. Consequently, `tool_end` is delivered after staging and before placement.

## Agreed event contract change

Do **not** add `tool_result_ready` or `tool_outcome_ready`.

Instead, redefine harness `tool_start`/`tool_end` as tool-call processing/result lifecycle events rather than exclusively real external-effect lifecycle events.

### Fresh executed call

```text
intent commit
→ tool_start
→ tool_update*
→ execute/finalize
→ TX[pendingEntry + outcome_ready + cleanup]
→ tool_end
→ source-ordered placement
→ entry_added
```

### Fresh synthetic call

```text
TX[pendingEntry + outcome_ready]
→ tool_start
→ tool_end
→ source-ordered placement
→ entry_added
```

The staging transaction's post-commit event batch contains `tool_start` followed by `tool_end`, so a watcher cannot observe either lifecycle event without the authoritative staged state.

Fresh synthetic calls include:

- unknown tool;
- argument preparation or validation failure;
- `before_tool` denial or invalid replacement arguments;
- genuine assistant `length`/truncated call handling;
- cancellation while still `planned` or after intent but before effect admission.

### Recovery

Historical lifecycle events are not replayed.

- A restored `effect_pending` call is already represented by the initial snapshot.
- Safe replay emits recovery-tagged `tool_start` from the checkpoint-clear commit and `tool_end` from the later outcome-staging commit.
- Unsafe interruption synthesis may emit a recovery-tagged `tool_end` without a newly emitted `tool_start`; the initial snapshot supplied the running row.
- A call already restored as `outcome_ready` appears as settled in the initial snapshot and needs no replayed end event before placement.

### Meaning of `tool_end`

After this change, `tool_end` means:

> The complete final tool result is durably staged and the call is `outcome_ready`.

It becomes the authoritative reducer transition from running to settled. It must be emitted **after** the staging commit, not before it.

The old distinction between actually executed and synthetic results was encoded by omitting lifecycle events. There is no in-repo runtime consumer requiring that distinction. If preserving it is desired, discuss adding an explicit field such as `execution: "executed" | "synthetic"`; this field was discussed but **not agreed**, so do not add it silently.

## LaneSnapshot type

Change `LaneSnapshot.operation.runningTools` in `packages/agent/src/harness/agent-harness.ts` to use one `result` field for both progress and final output. Do not retain a separate `partialResult` field in the snapshot.

Prefer a discriminated union so invalid combinations are unrepresentable:

```ts
type SnapshotTool =
  | {
      status: "running";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: AgentToolResult<unknown>; // latest complete progress snapshot
    }
  | {
      status: "settled";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: AgentToolResult<unknown>;  // complete finalized result
      isError: boolean;
    };
```

The user explicitly agreed to the discriminated union.

`tool_update.partialResult` may remain named `partialResult` in the event API; the reducer assigns it to the snapshot row's unified `result` field.

The current mini transport sends semantic events, not structural deltas, so `tool_end` still carries the complete final result even if it equals the latest update. Unifying the snapshot field is still the correct state model.

## Exact reducer behavior

File: `packages/agent/src/harness/runtime/reducer.ts`

### `tool_start`

- Resolve the operation with `matchingOperation(snapshot, event.runId)`.
- Upsert by `toolCallId`; do not blindly push.
- Set `status: "running"`, `toolName`, `args`.
- Clear stale settled-only fields if replacing an existing row.
- Preserve no stale final result. A newly started/replayed call may receive later `tool_update` values.

Upsert is required because a watch may capture durable `effect_pending` state before the buffered `tool_start` event is delivered.

### `tool_update`

- Use `matchingOperation(snapshot, event.runId)`, not `snapshot.operation` directly.
- Find the matching row.
- For a running row, replace `result` with `event.partialResult`.
- Ignore wrong-operation or missing rows.

### `tool_end`

- Resolve with `matchingOperation(snapshot, event.runId)`.
- Find the existing row by batch-local `toolCallId`; only one tool batch is presentation-active at a time.
- Replace it with `status: "settled"`, preserving its arguments and using `event.result` and `event.isError`.
- This naturally removes the provisional interpretation of the old `result`; there is no separate `partialResult` to delete.
- The finalized result remains displayed until placement.

`tool_end` does not carry arguments and cannot create a row. Fresh synthetic `tool_start` and `tool_end` are emitted together after the staging commit, eliminating the old capture/event gap. Unsafe recovery relies on the initial snapshot's running row.

### `entry_added`

If `event.entry` is a message whose role is `toolResult`, remove the matching batch-local `toolCallId` from `snapshot.operation?.runningTools`, then apply the transcript update. Harness events are serialized, trusted, emitted exactly once, and not historically replayed, so neither duplicate-entry handling nor cross-batch identity is needed.

Do not clear tool rows on `turn_end`.

## Exact authoritative capture behavior

File: `packages/agent/src/harness/runtime/lane.ts`, `captureLaneSnapshot()`, `case "tools"`.

The assistant entry is already loaded once. For each batch call:

### `planned`

Skip. It has not become presentation-active yet.

### `completed`

Skip. Its `toolResult` entry must already be in the captured transcript.

### `effect_pending`

- Validate that `assistant.message.content[sourceIndex]` is the matching `toolCall` block.
- Read `operationToolArgs(operationId, turnId, sourceIndex)`; it is required for effect-pending calls.
- Read optional `pendingToolOutput(operationId, resultEntryId)`.
- Project:

```ts
{
  status: "running",
  toolCallId: block.id,
  toolName: block.name,
  args: persistedArgs,
  ...(checkpoint === undefined ? {} : { result: checkpoint })
}
```

### `outcome_ready`

- Validate the source tool-call block.
- Read `pendingEntry(call.resultEntryId)`.
- Require a message payload with role `toolResult`.
- Validate staged `toolCallId` and `toolName` against the source block.
- Read `operationToolArgs(...)` when present.
- Use `persistedArgs ?? block.arguments`. Immediate synthetic calls may never have written `operationToolArgs`, and this absence is legal only for the outcome-ready projection.
- Reconstruct the canonical `AgentToolResult` from the staged `ToolResultMessage` and the durable call termination flag as needed.
- Project `status: "settled"`, `result`, and `isError`.

The event and capture representations must normalize the final result identically so folding through `tool_end` equals a later authoritative snapshot. Pay attention to optional `details`, `usage`, `addedToolNames`, and `terminate`; do not rely on incidental object-property presence differences.

A missing or mismatched staged result for `outcome_ready` is presentation corruption and must fault snapshot capture.

## Runtime event production changes

Primary file: `packages/agent/src/harness/runtime/drive/tools.ts`

Related helpers: `packages/agent/src/harness/execution/tools.ts` and `packages/agent/src/harness/runtime/drive/tool-placement.ts`.

### Internal outcome shape

Current:

```ts
type ToolOutcome = { message: ToolResultMessage<unknown>; terminate: boolean };
```

Extend/refactor it so post-commit event production has the complete canonical final result and `isError`, without lossy reconstruction. It must retain enough data for:

- staged `ToolResultMessage`;
- `tool_end.result`;
- `tool_end.isError`;
- durable/effective `terminate` after cancellation normalization.

Synthetic helpers currently return `ToolResultMessage` directly. Refactor carefully so synthetic outcomes also carry the canonical result data. Do not invent `details` in the transcript: existing unknown/invalid synthetic results deliberately omit message details.

### Commit-bound `tool_start`

For fresh execution, `publishToolIntent()` attaches `tool_start` to the commit that persists effective arguments and changes the call to `effect_pending`. The public operation awaits delivery before admitting `executeToolCall()`, preserving `tool_start → tool_update*` without requiring each update callback to await delivery.

For a fresh synthetic call that never writes effect intent, `publishToolOutcome()` attaches `tool_start` before `tool_end` in the outcome-staging commit's event batch. It reports the source block arguments.

For safe recovery, the checkpoint-clear commit emits recovery-tagged `tool_start` using persisted effective arguments. Do not emit a fresh start for an already-restored unsafe `effect_pending` call; its initial snapshot is the baseline.

### Post-commit `tool_end`

Remove the current pre-staging `tool_end` emission from `performToolInvocation()`.

`publishToolOutcome()` attaches `tool_end` to the same staging command's `events` callback. The event carries:

- `runId`, `turnId`, `toolCallId`, `toolName`;
- canonical final `result`;
- `isError`;
- cancellation-normalized durable `terminate`;
- `recovery: true` where applicable.

Arguments belong to `tool_start` and are not repeated on `tool_end`. Event data describes the state actually committed, especially cancellation forcing `terminate: false`.

Because `Lane.command()` awaits retained event delivery and `runParallel()` schedules materialization from the outcome-completion promise, the required order is:

```text
staging commit
→ tool_end delivery
→ source-ready message lifecycle
→ placement commit
→ entry_added
```

### Call sites to audit

Every `publishToolOutcome()` call must supply the source tool call and recovery context correctly:

- immediate outcome in `startToolInvocation()`;
- cancellation after intent but before execution;
- normal `performToolInvocation()` completion;
- safe replay completion;
- unsafe recovery interruption;
- sequential cancellation of `planned`;
- sequential cancellation of `effect_pending`.

Also audit the synchronous `AbortRequested` path inside `performToolInvocation()`: a call with durable intent must still have coherent start/end presentation even if effect admission fails immediately.

## Mini and other presentation consumers

### Mini

File: `packages/coding-agent/src/experimental/mini/tui/view.ts`, `MiniTui.apply()`.

For each `runningTools` row:

```text
status running:
  markExecutionStarted()
  if result exists: updateResult({...result, isError:false}, true)

status settled:
  do not call markExecutionStarted()
  updateResult({...result, isError}, false)
```

The final result remains visible while awaiting placement. After `entry_added`, transcript synchronization supplies the immutable `ToolResultMessage` and the row is no longer in `runningTools`.

### Other shared consumer

Apply equivalent handling in:

- `packages/coding-agent/src/experimental/client-tui-chat.ts`

Read `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` before editing to confirm `updateResult(result, isPartial)` semantics.

## Tests

### Reducer tests

File: `packages/agent/test/harness/runtime/reducer.test.ts`

Add a parallel batch event-fold test with calls 0, 1, 2:

1. Establish all three as running.
2. Call 2 settles before call 0.
3. Call 0 settles and is placed while call 1 still runs.
4. Call 1 settles.
5. Placement flushes calls 1 and 2 in source order.
6. After every settlement and placement event, assert each presentation-active call appears in exactly one of:
   - `operation.runningTools`; or
   - transcript `toolResult` entries.
7. Assert call 2 remains present with `status:"settled"` and its final result while blocked by earlier calls.
8. Assert each `entry_added` removes only its matching active row.

Add focused coverage for:

- `tool_update` from a stale/wrong `runId` does not mutate the current operation;
- `tool_start` upserts rather than duplicates a row captured from durable intent;
- `tool_end` settles the existing batch-local row.

### Capture/watch tests

File: `packages/agent/test/harness/runtime/watch.test.ts`

Construct a durable tools state containing:

- `planned` (omitted);
- `effect_pending` with checkpoint (`status:"running"`, checkpoint exposed as `result`);
- `effect_pending` without checkpoint;
- real `outcome_ready` with persisted effective args;
- synthetic `outcome_ready` without `operationToolArgs`, falling back to source block arguments;
- completed call represented only by a transcript entry where practical.

Assert staged settled content, `isError`, arguments, and absence of duplicates. Add missing/mismatched `pendingEntry` corruption assertions.

### Runtime tool tests

File: `packages/agent/test/harness/runtime/drive-tools.test.ts`

Update/add ordering assertions proving:

- real: `intent commit < tool_start < tool_update* < staging commit < tool_end < entry_added`;
- immediate synthetic: `staging commit < tool_start < tool_end < entry_added`, no tool effect and no `after_tool`;
- planned cancellation gets coherent start/end;
- unsafe recovery uses initial snapshot plus recovery-tagged end without replaying effects;
- B can emit post-commit end and remain settled while A blocks placement;
- source-order placement remains unchanged;
- a crash after staging cannot replay the call.

The baseline normative tests/documentation required `tool_end` before staging; the implementation reverses those expectations deliberately.

### Type/event catalog tests

Audit:

- `packages/agent/test/harness/types.test.ts`
- `packages/agent/src/harness/telemetry.ts`

No new event name is added. `tool_end` omits arguments and its semantics change.

### Mini regression

After unit tests, run the real mini abort smoke test used previously:

- execute exactly `sleep 20`;
- send Escape after about two seconds;
- assert `Command aborted` and elapsed time appear;
- assert raw ANSI contains `toolErrorBg` (`48;2;60;40;40`);
- verify the durable session contains an `isError:true` tool result and operation status `aborted`.

Also exercise a parallel batch where a later tool finishes first and verify its final result remains visible until in-order placement.

## Documentation changes

Read both documents completely before editing:

- `packages/agent/docs/harness.md` (normative)
- `packages/agent/docs/tool-durability.md`

The implementation updates baseline statements that required:

- `tool_end` before staging;
- `tool_start`/`tool_end` only for real effects;
- synthetic outcomes emitting no lifecycle;
- `outcome_ready` being omitted from `runningTools`;
- snapshot field `partialResult`.

Important known locations from the baseline:

- `harness.md` §3.8 around lines 784–796;
- `harness.md` §5.4 `LaneSnapshot` around lines 1101–1134;
- `harness.md` §5.5 events around lines 1140–1158;
- `harness.md` tool phases around lines 1214–1224;
- `harness.md` conformance requirements around lines 1386–1400;
- `tool-durability.md` finalization around lines 255–280;
- `tool-durability.md` snapshots/events around lines 568–584;
- `tool-durability.md` test requirements around lines 671–679.

The revised docs must state:

- `tool_end` is post-staging durability evidence for a final result;
- fresh synthetic outcomes receive start/end lifecycle;
- recovery events are not historically replayed;
- `outcome_ready` remains projected as settled until placement;
- `entry_added` moves settled presentation into transcript;
- the unified snapshot `result` is provisional when running and final when settled.

Do not modify the separate `response.ts`/`tool-placement.ts` recovery `turn_end` discrepancy unless separately requested.

## Files to reread completely after compaction

Core/specification:

1. `packages/agent/docs/harness.md`
2. `packages/agent/docs/tool-durability.md`
3. `packages/agent/src/harness/agent-harness.ts`
4. `packages/agent/src/harness/runtime/reducer.ts`
5. `packages/agent/src/harness/runtime/lane.ts`
6. `packages/agent/src/harness/runtime/drive/tools.ts`
7. `packages/agent/src/harness/runtime/drive/tool-placement.ts`
8. `packages/agent/src/harness/execution/tools.ts`
9. `packages/agent/src/harness/runtime/types.ts`
10. `packages/agent/src/harness/session/types.ts`
11. `packages/agent/src/harness/events.ts`
12. `packages/agent/src/harness/telemetry.ts`

Tests:

13. `packages/agent/test/harness/runtime/reducer.test.ts`
14. `packages/agent/test/harness/runtime/watch.test.ts`
15. `packages/agent/test/harness/runtime/drive-tools.test.ts`
16. `packages/agent/test/harness/types.test.ts`
17. Relevant test helpers imported by those files.

Mini/presentation:

18. `packages/coding-agent/src/experimental/mini/tui/session.ts`
19. `packages/coding-agent/src/experimental/mini/worker/lane-service.ts`
20. `packages/coding-agent/src/experimental/mini/shared/protocol.ts`
21. `packages/coding-agent/src/experimental/mini/tui/view.ts`
22. `packages/coding-agent/src/experimental/client-tui-chat.ts`
23. `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

Before editing, run `git status --short` and inspect current diffs because other Pi sessions may share the worktree.

## Validation commands

From repository root, after changes:

```bash
cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/runtime/reducer.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/runtime/watch.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/runtime/drive-tools.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/types.test.ts
cd "$(git rev-parse --show-toplevel)"
npm run check
```

Do not run `npm test`, the full Vitest suite, or `npm run build` unless requested.

If a delegated review is used, repository policy requires:

```text
--provider anthropic --model claude-fable-5
```

Keep extensions enabled.

## Non-goals

- No generic structural-delta transport for mini.
- No optimization to avoid the final result crossing the wire once in `tool_end` and again in `entry_added`.
- No change to source-prefix placement semantics.
- No clearing on `turn_end`.
- No change to tool effect replay/durability rules.
- No change to `after_tool`: it still runs only for actual fresh/safely replayed effects under its existing cancellation contract.
- No work on the separate recovery `turn_end` discrepancy between `response.ts` and `tool-placement.ts`.
- No backward-compatibility layer unless the user explicitly asks for one.
- Do not commit unless the user asks.
