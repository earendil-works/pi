# Assistant partial durability — implementation handoff

This document specifies durable partial assistant messages for ordinary assistant generation and deferred-response polling. It builds on:

- bound typed value/list addresses from `values.md`;
- `AssistantMessageFrame`, `AssistantMessageFrameEncoder`, and `reduceAssistantMessageFrames()` from `@earendil-works/pi-ai`;
- the assistant intent/effect/settlement state machine in `harness.md`.

The design persists compact replayable stream frames without making them operation-state authority and without storing a growing full partial message on every update.

## Goals

1. Reconstruct the latest committed partial assistant message after process loss.
2. Preserve provider stream order without repeated full-snapshot write amplification.
3. Avoid provider backpressure from storage commits.
4. Reuse pi-ai's canonical frame conversion and reduction semantics.
5. Preserve current public assistant event ordering.
6. Keep operation `effect_pending` state authoritative for recovery.
7. Delete all partial frames atomically with normal or synthetic response settlement.

## Non-goals

- Inferring provider completion from frames.
- Persisting terminal `done`/`error` events separately from response settlement.
- Exactly-once provider requests.
- Public frame cursors or a frame-persistence event.
- Generic batching, timers, coalescing, or flush APIs.
- Persisting structural summary-generation streams.
- Persisting arbitrary provider SDK events or repeated full `partial` snapshots.

## Storage

Built-in address constructor in `session/values.ts`:

```ts
export const pendingAssistantFrames = (
  operationId: string,
  responseEntryId: string,
) => list<AssistantMessageFrame>(
  "pi.pending.assistant_frame",
  `${operationId}:${responseEntryId}`,
);
```

The procedure binds one exact address for ordinary generation or a deferred poll:

```ts
const frames = pendingAssistantFrames(operationId, responseEntryId);
```

`responseEntryId` is already reserved in assistant/deferred `effect_pending` state. No frame count, cursor, or list identity is stored in operation state, and later list operations receive only `frames`—never another key.

Each list element is one `AssistantMessageFrame`. The storage transaction's global write sequence orders frames. The list is auxiliary:

- missing is valid;
- it does not prove request admission, completion, success, or failure;
- it never selects the restart point;
- base restore does not read it.

## Frame contract

Create one pi-ai encoder per provider stream and feed it every event in order:

```ts
const encoder = new AssistantMessageFrameEncoder();
const frame = encoder.encode(event);
```

`partial` is the provider's shared live response-so-far helper, not an event-time snapshot. The encoder keeps per-open-block counters and trims text/thinking delta prefixes already represented by an advanced block-start snapshot. It temporarily buffers only the raw JSON prefix needed to synchronize an already-advanced tool call, then emits one checkpoint and resumes compact deltas. It never clones the growing full message on every event.

- `start` produces an empty-content metadata frame;
- a non-terminal event produces zero or one frame;
- covered queued deltas produce no frame;
- terminal `done` and `error` produce no frame because final response settlement is separate;
- a setup `error` before `start` is valid and produces no frames;
- text/thinking/tool end frames contain the authoritative completed block value;
- completed tool-call arguments remain unvalidated against a tool schema.

Do not define a second harness frame codec or reducer. Persistence stores the exported pi-ai value directly; hydration calls `reduceAssistantMessageFrames()`.

Provider event blocks may interleave. Encoding and reduction rely on `contentIndex`, never block contiguity. Text and ordinary thinking blocks must be empty when `*_start` is published and then append only through matching deltas until end; redacted thinking may be complete at start and emit no deltas. Streaming tool calls start with empty arguments and emit their complete raw JSON through deltas; a provider that starts with complete arguments must emit a cumulative delta prefix that parses to that snapshot at an event boundary before later argument deltas.

## Fresh stream scheduling

The simplest scheduling is deliberate: one list-append transaction per converted frame, enqueued without awaiting storage in the provider loop.

For every `start` or update event:

```text
encode the event against the per-stream frame encoder
→ when a frame is returned, synchronously enqueue invocation-fenced appendList(frames, frame)
→ attach the ordinary harness-fault observer to the returned promise
→ replace process-local latestFrameWrite promise reference
→ emit and await the existing message_start/message_update event
→ consume the next provider event
```

`appendList()` is called synchronously for each returned frame, so all frame mutations enter the Session line in provider-event order. The procedure does not await each write. Every promise is immediately observed for fault propagation before the latest reference replaces its predecessor. Covered queued events allocate no durable frame or write. Encoder state is proportional to open block count plus the unsynchronized prefix of an active tool-call JSON stream; it retains no second full assistant message. Model output limits bound queued frame bytes to bounded output plus frame/transaction overhead.

The event side retains existing behavior: `AssistantStreamObserver.start/update` awaits `events.emit()` for every event. There is no separate latest event-delivery promise because no assistant event delivery remains outstanding when the provider loop advances.

When the provider stream settles:

```text
stop frame admission
→ await latestFrameWrite when present
→ run after_response
→ emit message_end
→ classify and commit final response settlement
```

The Session mutation line is FIFO, so completion of `latestFrameWrite` implies every earlier append completed. There is no array of promises, timer, batcher, active/waiting state, coalescer, or public/internal flush method.

A failed frame append faults the harness before `after_response` starts. The complete final response remains process-local and does not commit after a storage fault.

## Normal settlement

Every assistant response settlement that used a frame list deletes that exact list in the same transaction as the immutable response entry, usage, tip, and next operation state:

```text
TX[
  insert response entry R,
  insert usage U,
  setValue(branchTip(lane), R),
  deleteList(frames),
  setValue(operationState(operationId), classified next state)
]
```

This applies to:

- successful assistant responses;
- provider `error`/`aborted` responses;
- valid deferred responses;
- deferred poll responses.

`after_response` may transform the final response before settlement. Frames preserve provider-stream observation, while the immutable entry remains the post-hook canonical result.

A crash after the final frame append but before settlement still restores `effect_pending`; frames do not turn a complete-looking draft into a settled response.

## Unknown-outcome generation recovery

An orphaned assistant generation `effect_pending` has no surviving provider stream. Activation:

1. constructs `frames = pendingAssistantFrames(operationId, responseEntryId)` from current typed state and reads bounded pages from that exact address;
2. reduces frame values with `reduceAssistantMessageFrames()`;
3. constructs a harness-owned synthetic assistant response under the already-reserved response ID;
4. preserves reconstructed partial content and safe message identity metadata when frames exist;
5. sets `stopReason: "error"`, zero usage, and an explicit interruption/unknown-outcome `errorMessage`/diagnostic;
6. commits the synthetic response, zero-usage row, frame-list deletion, tip, and ordinary retry/failure state atomically.

Required warning meaning:

```text
The provider request was interrupted. The preceding content is the latest
committed partial response; newer live output may be missing, and the external
request outcome is unknown.
```

If no start frame committed, the harness constructs the same synthetic error with empty content from the captured model/API identity.

The synthetic response follows ordinary assistant error classification:

- attempts remain → insert the error response and enter the ordinary retry-wait/next-attempt path;
- cap reached → insert it and terminal-fail the operation in the same settlement transaction.

Error responses remain durable transcript history but are omitted from later provider context by the existing projection rule. Partial tool calls inside the interrupted error response never execute.

Recovery does not run `after_response`: there is no trustworthy complete provider result to transform.

## Cancellation

A live cancelled provider stream settles through its ordinary final `aborted` response. All accepted frames are awaited first, and normal settlement deletes the list.

For restored cancelled assistant/deferred `effect_pending`, cancellation reconciliation:

- reduces available frames;
- constructs a synthetic `aborted` response preserving the committed partial content;
- uses zero usage and the existing reserved IDs;
- atomically inserts the response and deletes the frame list;
- starts no provider request and runs no response hook.

Cancellation wins classification even if reduced content appears complete.

## Deferred polling

A deferred poll that returns an `AssistantMessageEventStream` uses the same `pendingAssistantFrames(operationId, responseEntryId)` address constructor.

- normal pending/ready/error settlement deletes the poll's frame list;
- restored cancellation synthesizes an aborted response from frames;
- an unknown restored poll without a permit remains suspended and may expose its durable partial in snapshots;
- when a poll permit replaces the unknown poll with fresh reserved response/usage IDs, that intent transaction deletes the abandoned old frame-list address;
- the replacement poll starts a fresh list under its fresh response ID.

Frames never change poll-number rules.

## Structural generation scope

Structural summary-generation streams remain process-local. They do not emit public assistant-message lifecycle and may span multiple nested provider requests before one structural publication. Existing attempt-level retry and usage recovery remains authoritative.

Do not store their intermediate text at a `pendingAssistantFrames(...)` address in this slice. If structural partial diagnostics become a requirement, add a separate explicitly scoped consumer rather than silently reusing transcript-assistant semantics.

## Snapshots and reconnect

`LaneSnapshot.streamingMessage` means the latest observed partial assistant message, not proof that a provider stream is currently attached.

Precedence:

1. newest process-local partial while a live stream is owned;
2. otherwise, for assistant/deferred `effect_pending`, the value reduced from committed frame pages;
3. otherwise absent.

A restored lane may therefore be `suspended` with a non-undefined `streamingMessage`. The field remains outside `transcript`; only `entry_added` moves a complete response into transcript history and clears the partial.

Snapshot hydration constructs the exact bound frame address from trusted typed operation state and enforces the assistant consumer's total frame/page budget. It does not scan arbitrary lists or perform a broad semantic restore audit.

Reconnect replays no historical `message_start` or `message_update` events. The snapshot carries the durable partial. Recovery later emits the ordinary recovery-tagged synthetic message lifecycle for the response it actually settles.

## Events

A started generation retains this live event ordering:

```text
message_start
→ message_update*                 each listener delivery awaited by provider loop
→ await latest frame write
→ after_response
→ message_end
→ atomic response settlement + frame-list delete
→ entry_added
→ usage
```

A request setup failure may produce `error` before `start`; that path emits no `message_start` or frame and proceeds through `after_response`, `message_end`, and ordinary error settlement. Successful `done` and updates before `start` are protocol defects.

Frame commits emit ordinary storage telemetry only. There is no public frame event and no claim that a `message_update` was durable. `entry_added` remains the only proof that the final assistant entry committed.

A crash may occur after a live update event but before its asynchronously queued frame append commits. Reconnect then shows the latest committed frame prefix, which may be older than the last live event.

## Close, fault, and external finalization

Close is a controlled crash:

- no synthetic response is written;
- already-enqueued frame commits are ordinary admitted session work and may finish under the close barrier;
- process loss may discard mutations that had not committed;
- reopen restores the latest committed frame prefix under unchanged `effect_pending` state.

A frame-commit storage failure faults the harness. No later response settlement commits in that process.

Authorized external finalization deletes the operation-owned frame-list address in its terminal transaction. Every append mutation verifies current operation/response ownership on the Session line:

- append first → external terminal cleanup deletes the list;
- finalization first → stale append rejects without recreating state.

## Terminal cleanup, forks, and migrations

Normal/synthetic response settlement should already delete its exact frame address. The operation terminal transaction also defensively constructs and deletes the current operation-owned frame address when state is assistant/deferred `effect_pending`.

Idle forks never copy lists in the `pi.pending.assistant_frame` address family. Precise rewrites and migrations page frame lists and preserve element sequences when retaining them.

A migration changing `AssistantMessageFrame` shape must map every surviving element or explicitly delete the whole list and leave `effect_pending` recovery with no partial. It must never infer completion from legacy frames.

JSONL retains deleted frame bytes until snapshot compaction. Logical deletion is immediate.

## Races

| Race | Required result |
|---|---|
| frame append vs next frame | synchronous lane enqueue preserves provider-event order |
| frame append vs stream settlement | settlement awaits the latest promise; all accepted appends finish first |
| live update event vs frame commit | either may finish first; event is observation and reconnect uses only committed frames |
| append vs external finalization | append first is deleted by cleanup; finalization first fences the append |
| process loss with queued writes | only the committed prefix restores |
| final frame vs response settlement | frame commits first; settlement atomically deletes the list and inserts final entry |
| activation vs snapshot | both reduce the same committed sequence prefix; activation may then settle and clear it |
| unknown generation vs retry | synthetic partial error commits under old reserved IDs before later attempt starts |
| unknown deferred poll vs replacement | old list is deleted with fresh replacement intent; new response ID gets a new list |

## Invariants

1. Scalar assistant/deferred state is the sole restart authority.
2. One effect-pending response ID constructs exactly one assistant frame-list address.
3. Every stored element is an exported pi-ai `AssistantMessageFrame`.
4. Terminal `done`/`error` events are never stored as frames.
5. Frame order is a subsequence of provider event order; zero-frame covered events do not disturb order.
6. Awaiting the latest frame-write promise at stream settlement implies all accepted appends completed.
7. Frames never establish provider completion or suppress unknown-outcome recovery.
8. Final or synthetic response settlement atomically deletes the exact frame list.
9. A restored partial may appear in `streamingMessage` but never in `transcript` before settlement.
10. Interrupted partial tool calls never produce a tool plan because the synthetic response stops with `error`/`aborted`.
11. Structural generation never writes a `pendingAssistantFrames(...)` list in this slice.
12. Terminal cleanup, external finalization, and idle forks leave no operation-owned assistant frame list.

## Required tests

### Frame integration

- one per-stream encoder handles shared live partials and synchronous event bursts without duplicate content;
- each event appends zero or one frame, with covered queued deltas appending nothing;
- `done`/`error` append nothing, including pre-generation error;
- interleaved content indexes preserve sequence;
- provider loop does not await individual frame writes;
- frame appends enqueue synchronously before the next provider event;
- only the latest promise reference is retained;
- awaiting the latest promise implies all earlier writes completed;
- bounded output bounds queued frame memory;
- storage failure prevents `after_response` and faults the harness.

### Settlement and recovery

- every ordinary response class deletes the frame list atomically;
- crash at every frame/settlement boundary;
- no frames and partial text/thinking/tool-call frames;
- authoritative end-frame content survives;
- interrupted generation commits partial synthetic error then retries or fails at cap;
- interrupted partial tool calls never execute;
- recovery uses zero usage and existing reserved IDs;
- cancellation preserves committed partial content in synthetic aborted response;
- `after_response` never runs for restored synthetic settlement.

### Deferred, snapshots, and lifecycle

- deferred poll frame persistence and normal cleanup;
- unknown poll snapshot without permit;
- replacement intent deletes abandoned poll frames;
- live partial takes precedence over durable reduction;
- reopen exposes reduced `streamingMessage` on suspended effect-pending lane;
- no historical update event replay;
- recovery settlement clears partial on `entry_added`;
- structural generation writes no assistant frame list.

### Storage lifecycle

- Memory/JSONL/SQLite reduce identical frame sequences;
- frame list is absent after normal, synthetic, cancellation, and external terminal transitions;
- idle fork excludes frames;
- JSONL compaction removes deleted frame bytes;
- migration maps or explicitly discards every legacy frame;
- instrumentation records append/delete ordering without frame content in telemetry.

## Implementation map

Expected runtime areas:

- built-in `pendingAssistantFrames(operationId, responseEntryId)` address constructor in `session/values.ts`;
- bound value/list storage implementation from `values.md`;
- assistant execution observer and generation procedure;
- deferred polling procedure;
- activation and cancellation recovery;
- snapshot hydration;
- terminal cleanup, forks, and migrations;
- instrumented writer and backend conformance tests.

Implement bound typed value/list addresses first, then frame enqueue/settlement, then recovery/snapshots. Update `harness.md` with this complete lifecycle before implementing runtime assistant parity.
