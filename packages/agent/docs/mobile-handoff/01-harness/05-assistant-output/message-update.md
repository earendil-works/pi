# `message_update` Write Amplification

> **Scope:** harness-local. Depends on [delta tracking](../01-delta/delta.md) for the landed Chord `Op`/`WireOp` vocabulary and [scoped storage](../02-scopes/scopes.md) for durability. Chord delta tracking has landed; scoped storage and this Harness integration have not.

## 1. The problem

```ts
{ type: "message_update", runId, message, event, frame? }
```

Three representations of the same thing travel together:

- `message` — the full `AssistantMessage`;
- `event` — an `AssistantMessageEvent`, which itself carries `partial: AssistantMessage`,
  a second full copy;
- `frame` — the actual delta, optional.

Per streamed token this is roughly two complete snapshots plus a delta, so bytes grow
quadratically over a response.

The reducer does not even use the delta:

```ts
case "message_update":
  if (next.operation?.id === event.runId && event.message.role === "assistant") {
    next.operation.streamingMessage = event.message;
  }
```

A straight assignment. So on any wire, sending the event is *worse* than sending a
snapshot — it ships two where `replace` ships one.

The wire adapter is already halfway to the fix: it drops `event` and sends `message`
plus `frame`. That is the full snapshot together with the delta that produced it.

## 2. The compact form already exists

```ts
/**
 * Compact, replayable assistant-message progress. Terminal settlement is
 * intentionally excluded and must be persisted separately.
 */
export type AssistantMessageFrame =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; contentIndex: number; ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
  | { type: "toolcall_start" | "toolcall_checkpoint" | "toolcall_delta" | "toolcall_end"; ... };
```

`AssistantMessageFrameEncoder` produces it, `reduceAssistantMessageFrames` folds it,
and `openFrameProgress` already persists it with `appendList`. The delta format is
built, used, and durable. It simply is not what `message_update` carries.

## 3. Precedent

pi already does wire-is-delta one layer down. `PiMessagesEvent` — the serialized form
a pi-messages backend sends — has no `partial`:

```ts
| { type: "text_delta"; contentIndex: number; delta: string }
| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
```

`pi-messages.ts` then rehydrates: it holds a local `partial`, mutates it per event
(`partial.content[i].text += event.delta`), and returns the in-process
`AssistantMessageEvent` with `partial` attached.

So the convention is established. It just stops at the provider edge instead of
continuing through the harness.

## 4. The change

```ts
| { type: "message_update"; runId: string; entryId: string; frame: AssistantMessageFrame }
```

`message` and `event` are removed; `frame` stops being optional.

The blast radius is small because `HarnessEvent` is not what most streaming consumers
read. `AgentEvent` (`agent-loop.ts`) and `AgentSessionEvent` (`agent-session.ts`) are
separate unions that happen to share the tag name and build their own
`message_update` from the pi-ai event directly. They are out of scope here.

Real consumers and producers of `HarnessEvent.message_update`:

| site | change |
| --- | --- |
| `runtime/drive/response.ts` | emit the required semantic frame; stop attaching full snapshots |
| `runtime/reducer.ts` | fold the frame instead of assigning `event.message` |
| lane/facet state adapter | run that fold under the Chord tracker and emit `Op[]`/encoded `WireOp[]` |
| `experimental/harness-wire-adapter.ts` | stop treating raw `HarnessEvent` as the final replication format |
| `harness/telemetry.ts` | name list only |
| `protocol/harness.ts` | replication carries encoded `WireOp[]`, not the raw event |

`message_end` continues to carry the settled message, because frames deliberately
exclude terminal settlement. That is once per message, not once per token.

## 5. An incremental applier is needed

`reduceAssistantMessageFrames` is a whole-stream fold over an `Iterable`. The
reducer needs a step function:

```ts
export function applyAssistantMessageFrame(
  state: AssistantFrameState,
  frame: AssistantMessageFrame,
): void;
```

Plain mutation on a plain object. **No `Draft`, no Immer.** An earlier draft
argued for a draft-mutating signature so it would compose inside a `produce`
recipe; that motivation is gone ([delta.md §8](../01-delta/delta.md#8-what-this-removes-from-the-codebase)). The step function is still
needed — the whole-stream version becomes a loop over it — just for the simpler
reason that the reducer folds one frame at a time.

### 5.1 pi-ai frames stay at the pi-ai boundary; Chord ops cross replication boundaries

`AssistantMessageFrame` is pi-ai's semantic delta vocabulary (`text_delta`, `text_end`, …). [Delta tracking §6](../01-delta/delta.md#6-there-is-no-frame-type) defines no second frame wrapper: in-process replication carries `Op[]`, and a wire adapter carries encoded `WireOp[]`. Pi-ai frames stop at the fold; Chord ops cross the replication boundary.

`AssistantMessageFrame` is pi-ai's own delta vocabulary and stays. What changes is
that it is no longer the durable unit or the replication unit.

The harness folds frames into `LaneView` by plain mutation. Under the Chord tracker that yields:

```json
["a",["operation","streamingMessage","content",0,"text"],"Let me "]
```

Measured, interned ops are **smaller than frames** on this workload — 13.6 KB
against 21.5 KB raw for 200 deltas — because a frame carries three keys of its own
where an interned op carries one integer. So the size argument for putting frames
on the wire is dead.

What frames keep is semantic: `text_end` carries authoritative content plus a
signature in one atomic unit, where ops would need two with a weaker contract
about their relationship. That is why they remain the *input* vocabulary and are
folded before anything crosses a boundary.

### 5.2 Reducer state must live in the reduced value

Text and thinking fold purely: `block.text += frame.delta`, and `*_end` overwrites
with authoritative content plus signature. The `ended` flag in `ReducerBlockState`
is used only for validation and can be dropped.

Tool calls cannot. `toolcall_delta` does `state.json += frame.delta`, accumulating
a **raw JSON string that is never stored on the message** — the block holds
`arguments`, the parsed value. You cannot recover the accumulator from the
snapshot, and you cannot append a delta to a parsed object.

So the accumulator has to become part of the value being folded — e.g.
`operation.frameState[contentIndex].json` on `LaneView` — leaving
`AssistantMessage` clean. Generally:

> **A replicated reducer's state must be part of the replicated value.** Anything
> held beside it diverges on any consumer that did not run the producer's fold.

The corollary is that `arguments` itself should **not** be replicated. It is
derived from `json`, and a parsed object is a fresh reference on every parse, so
storing both ships two copies of the same information. Derive it on demand.

This is safe precisely because `parseStreamingJson` is **total** — four fallbacks
ending in `{}`, it cannot throw — so a replica derives unconditionally with no
error path and no agreement protocol. There is no parse-failure state to
represent, and no block needs an error slot.

### 5.3 Parse cost

`parseStreamingJson` on a growing string once per delta is quadratic per message.
Since `arguments` is now derived rather than replicated, this cost falls on whoever reads it rather than on every consumer. Presentation can refresh derived arguments at semantic checkpoints and `toolcall_end` instead of parsing on every delta; that policy is separate from why the encoder currently emits a checkpoint (§6).

## 6. What `toolcall_checkpoint` is for

`EncoderBlockState` carries `caughtUp` and `catchupJson` because a queued provider event's shared `partial` may already be ahead of that event's delta. The checkpoint catches the semantic frame stream up to the authoritative tool-call arguments visible at block start; it is not currently a general late-subscriber protocol.

After frames fold into tracked state, a Chord root replacement (`r`) is the replication and durable-recovery resync point. `toolcall_checkpoint` remains semantic input to that fold rather than carrying transport responsibility.

## 7. Write volume for pending output

`openFrameProgress` calls `appendList(pendingAssistantFrames(...))`, so every
frame is a line. A long response is thousands of writes.

**The address is renamed `pendingAssistantOutput`** and becomes a `list<WireOp[]>`, matching `pendingToolOutput` ([tool-output handoff §7.2](../04-tool-output/harness-tools.md#72-renaming)), and it stops being a list of frames. The progress sink encodes tracked `Op[]` with one stateful encoder per response before appending each durable `WireOp[]` batch; explicit `rebase()` calls produce bounded root-replacement batches for recovery. The list lives in an **ephemeral scope** so it is unlinked on settle rather than persisting in the main log ([scoped storage](../02-scopes/scopes.md)).

The important property is that this list is **not history**: `deleteList` runs on
settle in `response.ts`, `deferred.ts`, and `terminal.ts`. It exists so a crash
mid-response can recover a partial assistant message. The settled message is persisted
separately.

That means per-frame durability buys almost nothing, and the write rate can be traded
away directly:

- **Coalesce with a bounded, non-resetting window.** The first pending frame opens the
  window; later frames join it *without* extending the deadline, so a continuously
  streaming response cannot postpone the first write indefinitely — the failure mode a
  naive debounce has. Frames admitted during an active write form the next batch.
- **Concatenate on flush.** A run of `text_delta` frames for one `contentIndex`
  collapses to a single frame with the joined text. The fold result is identical, so
  this is lossless for our purposes.

A crash then loses at most one window of in-flight streaming.

### 7.1 Contrast with DeepSeek Harness

DSH cannot make this trade. Its `assistant/chunk` events are canonical log entries, so
per-token durability is mandatory and it attacks size instead:

- the same bounded non-resetting write-behind window;
- **packed rows** — runs of consecutive chunk deltas stored as
  `text-chunks` / `reasoning-chunks` / `tool-call-chunks`, lossless and roughly 60%
  smaller on a real session, with reading unconditional so layout never depends on the
  write switch;
- checksummed zstd frames by default, with recovery from a torn final frame.

Their packing must reconstruct exact event boundaries, sequence numbers and timestamps,
because `seq = log.length` and validation requires a contiguous logical log. Ours does
not, because the frames are discarded at settle — so plain concatenation is available
to us and packing machinery is not needed.

## 8. Consequence for ad-hoc listeners

`HarnessEvent.message_update` stops being self-describing. A listener that attaches
mid-stream sees a delta against a partial it does not hold.

Any correct listener already has the base, because `watch()` installs the subscription
and captures the snapshot inside one `readLane` critical section, buffering until
`start()`. But a listener that calls `on("message_update")` directly, without a watch,
is no longer viable — worth knowing before committing.
