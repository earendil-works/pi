# Tool Output and Progress

> **Scope:** harness-local. Nothing here depends on the facet system, RPC, or any
> presentation. Depends on [delta tracking](../01-delta/delta.md) (the landed Chord op vocabulary and tracker), [execution environments](../03-execenv/execenv.md) (where truncation happens), and [scoped storage](../02-scopes/scopes.md) (durability).

## 1. The problem

Three faults, one cause.

**Tools each implement their own truncation.** `bash.ts` owns a rolling buffer,
`truncateTail`, a spill file, an update throttle and a checkpoint interval.
`read.ts` has its own truncation. Every future tool producing bulk output
reimplements this, differently.

**Progress is a whole value.** `onUpdate(partialResult)` hands over a complete
`AgentToolResult` on every update, `tool_update` carries that whole result, and
`openToolProgress` persists it with `setValue`.

**`details: unknown` was believed to force this** — you cannot append to a value
whose shape you do not know. That premise is now false. A structural tracker
(`delta.md`) records ops against JSON without knowing the type, so details need
no special handling at all.

## 2. `ToolOutput`

The harness constructs a sink per invocation and passes it to `execute`. **Tools
return nothing**; the sink holds the result.

```ts
interface ToolOutput<TDetails extends JsonValue> {
  /** Append to the text block. */
  write(text: string): void;
  /** Append an image block. Images are never windowed. */
  image(image: ImageContent): void;
  /** Replace the retained text wholesale. Chord still recovers a verified `t` + `a` slide when possible. */
  replace(text: string): void;
  /** Apply source-owned truncation totals and spill metadata without resending text. */
  capture(metadata: ShellOutputMetadata): void;

  /** The tool's own details object. Mutate it directly. */
  readonly details: TDetails;

  /** Accumulates. A subagent making several model calls adds to it. */
  usage(usage: Usage): void;
  /** Replaces. */
  addTools(names: string[]): void;
  /** Replaces — a tool that decides to terminate and then recovers can say so. */
  terminate(value: boolean): void;
}
```

```ts
execute(
  toolCallId: string,
  params: Static<TParameters>,
  signal: AbortSignal,
  out: ToolOutput<TDetails>,
  context: Context,
): Promise<void>;
```

`execute` returns `void`. Everything the tool produces flows through the sink —
including `usage` and `addTools`, which cannot be settle-time return values
because a replayed tool must be able to seed from durable state (§7.4).

**Failure is a thrown error.** `isError` is set by the harness when `execute`
rejects. A tool may throw anything, including errors from libraries it did not
write.

**`terminate` is orthogonal to how execution ended**, so a failing tool can ask
the loop to stop:

```ts
try { await thing(); } catch (error) { out.terminate(true); throw error; }
```

This closes a gap in the current implementation, where `executeToolCall`'s catch
hardcodes `isError: true` with no terminate, and `immediateError`'s terminate
parameter is only ever passed `true` by `applyBeforeToolDecision` for a hook
block.

### 2.1 Details are just an object

```ts
async execute(id, params, signal, out, context) {
  out.details.total = 42;
  out.details.passed += 1;
  out.details.failures.push({ name, message });
  out.details.current = undefined;          // -> delete
}
```

Fully granular ops fall out, verified against the prototype:

```jsonc
["#",0,["details","passed"]]
["s",0,1]
["p",["details","failures"],0,0,[{…}]]
["d",["details","current"]]
```

No recipes, no mutation map, no `initialDetails` on `tool_start`, no Immer, and
no consumer ever runs tool code. `TDetails` remains the tool's own exported type
so a renderer can cast `call.details` to it — that is all it is for.

A survey of `packages/agent/src/harness/tools/` found **no tool mutating details
incrementally today**; only `bash.ts` writes them mid-stream and it rebuilds them
whole, because the container was replaced wholesale anyway. This design removes
that cause, and costs nothing if nobody takes it up.

**Caveat:** details are now unbounded. A tool pushing to `failures` in a loop
grows without limit, and unlike text there is no cap. Nothing shipped does this;
the door is open in a way it was not when details were a replace-only value.

### 2.2 Partial output survives failure

Today `executeToolCall` catches and returns `createErrorToolResult(message)`,
building a fresh result from the error string alone — a tool that streamed 8 KB
and then threw reports only the error.

With the sink, what was written is already the result. The harness appends the
error text as content and keeps the rest. The error text is model-visible
content, not presentation: the model needs to read why the call failed.

`abortedMessage` and `interruptedMessage` should be made consistent with this;
today they build replacement results via `syntheticMessage`, so a cancelled
long-running command loses its partial output too.

## 3. Content

Content is exactly **one text block followed by zero or more image blocks**. A
tool cannot interleave text between images — text written before and after an
image lands in the same block. Deliberate: truncation only ever touches a string,
and an image is never partially anything.

Images are **never windowed**. A byte or line cap over base64 payloads is
meaningless and `truncateTail` operates on text. `maxBytes` / `maxLines` govern
text only.

### 3.1 Retention mode

Declared on the tool definition:

```ts
output?: {
  retain?: "head" | "tail";   // default "tail"
  maxBytes?: number;
  maxLines?: number;
}
```

**`head`** — append until the cap, then stop. Nothing is ever removed. Right for
output meaningful from the start: file reads, listings, greps.

**`tail`** — a rolling window. Right for anything whose interesting part is at
the end: builds, test runs.

Head+tail is **not** offered. `truncate.ts` exports `truncateHead` and
`truncateTail`; neither combines them and none is being added.

### 3.2 The tool does not truncate — the exec env does

For output originating in the execution environment, capping, coalescing and
spilling happen **at the source**. See [`execenv.md`](../03-execenv/execenv.md). The tool passes its
`ShellOutputLimits` into `env.exec` and pipes the resulting updates into the sink.

This is not a convenience. Reading a 1 GB file on a sandbox host must not ship
1 GB to the agent machine to be capped there, and the spill file must land where
the model's own `read` and `grep` run.

For output originating on the agent machine (subagents, in-process work),
`ToolOutput` applies the same logic locally. Same code, different location.

Note this reverses an earlier decision that there is no spill in the sink and a
temp-file path is tool-specific. The exec-env argument — model reachability
across a machine boundary — is what changed it.

## 4. Tool output state

`tool_update` carries `Op[]` (`delta.md` §6) targeting the invocation's
`ToolOutputState`:

```ts
interface ToolOutputState {
  content: (TextContent | ImageContent)[];
  details: JsonValue;
  usage?: Usage;
  addedTools?: string[];
  terminate: boolean;
  truncation: ShellOutputTruncation;   // totals over everything ever written, without duplicate text
}
```

Ops rather than a typed variant union, for one decisive reason: **only ops give
details granularity without the harness knowing `TDetails`**. A typed union would
need per-tool recipes, which is the machinery §2.1 deletes.

Text still gets delta treatment, because the sink applies the cap *before*
mutating, so a rolling window produces `truncate` + `append` on
`content[0].text` rather than a whole-value set.

Interned ops also measure **smaller than a typed frame vocabulary** on every
workload, and 10x smaller on details, because a frame repeats `toolCallId` where
an interned op carries one integer. See `delta.md` §4.1.

There is no `drop` event. The sink knows what it evicted and expresses it as
`truncate`; a consumer needs no separate signal and derives nothing.

## 5. Harness events

```ts
| { type: "tool_start";
    runId; turnId; toolCallId; toolName;
    args: unknown }

| { type: "tool_update";
    runId; turnId; toolCallId;
    ops: Op[] }                       // a base batch begins with `r`

| { type: "tool_end";
    runId; turnId; toolCallId;
    isError: boolean }
```

**`tool_start` carries identity only.** An earlier draft added `caps` and
`initial`; both were redundant and are gone. The first batch is always a base batch
(`delta.md` §6), so the initial state arrives on the update channel — carrying it
twice means two ways to establish the base, which can disagree. And `caps` are
already inside the state: `ToolOutputState.truncation` carries `maxBytes` and
`maxLines`, which is what a renderer needs to say "50 KB limit". The draft itself
conceded a consumer "no longer has to" fold identically, since the producer's ops
encode eviction — that was the last reason for `caps` to travel, and it does not
hold.

`tool_update` carries ops. A base batch travels the same channel as a delta,
because a replacement is itself an op (`delta.md` §2) — there is no second shape. `message_update` has the identical shape
(`message-update.md` §5.1); a consumer folds tool output and assistant output with
one code path.

**`tool_end` carries no content, no details, no usage, no terminate.** Every byte
already went out. Re-sending would duplicate each base64 image at the moment
nothing new has happened.

> **The fold is the result.** Nothing a consumer folded is ever re-sent to
> confirm it.

This dissolves an earlier open question about settle-time truncation disagreeing
with the running fold. There is no separate settle-time truncation: the sink's
window *is* the truncation. Anything a tool wants to add at the end — bash's
`[Showing lines 8000-8123 of 8123]` footer — is `out.write(footer)`, one more
append.

The harness still assembles `AgentToolResult` in process for the model, and
`createToolResultMessage` still writes the settled `ToolResultMessage` to the
transcript with `content`, `details`, `usage`, `addedToolNames`, `isError`.
Neither is a wire event.

## 6. Lane reduction

```ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void;
```

Plain mutation on a plain object. No `Draft`, no `produce`, no Immer, and **no
`Rebase` return value** — a fold that cannot apply an event leaves state alone,
and the host sends a `replace`. (An earlier draft had `void | Rebase`; under
Immer that throws, and without Immer there is nothing to return to. Note
`reducer.ts:4` currently defines `LaneSnapshotReduction = LaneSnapshot | { rebase: true }`,
so this is a real change to existing code, and `navigation_end` is the event that
drives it.)

The event is the only input besides the view. No registry, no `resolve`, no tool
code — so a tool rewritten between crash and resume cannot make a persisted
stream unreadable.

When the harness is wrapped by a facet, the same mutation runs under the tracker
from `delta.md` and ops fall out. The harness itself does not know this.

## 7. Durability

### 7.1 What exists today

`pendingToolOutput(operationId, invocationId)` is a
`value<AgentToolResult<unknown>>`, and — importantly — `progress.write(partial)`
fires **only** when `options?.checkpoint === true` (`drive/tools.ts:325`). Not on
every update. bash checkpoints every 2 s with a `JSON.stringify` dedupe; every
other tool never checkpoints at all.

It is also **not a progress buffer**. It is the interruption checkpoint. On
resume, if the tool is not replay-safe, `readCheckpoint` turns it into a real
`ToolResultMessage` for the model: `[...checkpoint.content, INTERRUPTION_MARKER]`
plus `details` and `usage`.

Note the implication that misled an earlier draft: because the checkpoint must
*be* the current state, it was read as needing `value` semantics. It does not. It
needs to be *derivable*, and folding encoded batches from the last base batch derives it — which is the point of tagging base batches (§7.3). `checkpoint: true`
requests a durable write, not a replacement.

`pendingAssistantFrames` is a `list<AssistantMessageFrame>` appended per frame,
`deleteList` on settle in `response.ts:345`, `deferred.ts:157`, `terminal.ts:47`.

Note `operationCleanupWrites` (`terminal.ts:26`) does four `scanValues` calls to
enumerate what to delete at settle. Under scopes, the two covering
`operationToolMemoPrefix` and `pendingToolOutputPrefix` are replaced by a single
`retireScope(operationId)`.

### 7.2 Renaming

`pendingAssistantFrames` → **`pendingAssistantOutput`**, matching
`pendingToolOutput`. Frames stop being the durable unit; both addresses now hold
tracked state written as ops or snapshots.

### 7.3 What to write, and when

Both addresses are **ephemeral-scoped** ([scopes.md](../02-scopes/scopes.md)), so they live in a
sidecar retired on settle rather than in the main log forever.

Two independent wins, in order of importance:

- **Encoding.** Ops instead of whole values, plus address interning: 93.89 MB to
  5.32 MB in a single file, no change to atomicity. Do this first.
- **Scopes.** Pending state leaves the main log entirely: 5.32 MB to 0.06 MB
  surviving.

**Both are `list<WireOp[]>`**, not values. The sink owns one stateful Chord encoder/decoder pair per durable value stream. One encoded batch is appended per flush, and a logical batch whose first op is `r` is tagged `"base"` on the storage record.
Recovery reads backwards with `stopAtTag: "base"` and applies forward
([delta.md §9](../01-delta/delta.md#9-durable-form), [scopes.md §11](../02-scopes/scopes.md#11-list-tags-and-stop-conditions)).

Writing one flush:

```ts
const ops = out.flush();
if (ops.length === 0) return;
const wire = enc.encode(ops);
writes: [appendList(address, wire, isBase(ops) ? "base" : undefined)];
```

`isBase` comes from Chord. It checks for the root replacement op `r`; ordinary nested sets use `s`. Classification lives beside the vocabulary so the comparison is written once.

The landed tracker emits structural ops unconditionally. There is no serialized-size comparison or adaptive replacement heuristic. A producer requests a base batch explicitly with `rebase()`; the output sink's cap bounds that replacement, while periodic rebasing bounds recovery work. Production remeasurement rejects a text-specific append/truncate API: the generic path measured 2.43–2.46 µs per 50 KB rolling-window flush locally, below surrounding costs. Keep ordinary tracked string mutation; see the [decision record](../01-delta/append-decision.md).

**Checkpointing is not deleted.** `BASH_CHECKPOINT_INTERVAL_MS` remains only as an interim compatibility mechanism. The generic sink owns durable frequency because Shell cannot price a storage write or enforce memo/output atomicity. Forced memo, terminal, and recovery-base writes bypass ordinary pacing while remaining cap-bounded.

### 7.4 Replay must seed, not discard

`clearReplayCheckpoint` currently writes `deleteValue(pendingToolOutput(...))`
before re-executing a replay-safe tool (`drive/tools.ts:257`). **This is a bug.**

Replay-safe means the tool is re-executed, but memos exist precisely so it does
*not* redo work it already did — and skipped work emits nothing. Any output for
memoised work is lost today.

The fix: seed a fresh `ToolOutput` from the durable state, then re-execute. The
tool appends to a sink that already holds what it produced before the crash.

This is also why nothing may be settle-only. `usage` and `addTools` must survive
a seed, so they flow through the sink like everything else.

### 7.5 The memo invariant

> A tool's memo write and its output checkpoint must commit in the same
> transaction.

Otherwise a tool does work, sets a memo, crashes before the next checkpoint, and
on replay skips the work while the seeded output has no record of it.

**This does not hold today.** `setMemo` (`drive/tools.ts:112`) and `openProgress`
(`runtime/progress.ts:44`) are two separate `lane.command` calls, hence two
transactions. Making it hold means bundling the checkpoint into the memo's commit:

```ts
setMemo(name, value) {
  validateMemoName(name);
  if (!active) return Promise.reject(ended());
  return lane.command<void>((state) => {
    if (!ownsEffect(state)) return { kind: "reject", error: ended() };
    const memo = operationToolMemo(drive.operationId, call.resultEntryId, name);
    return {
      kind: "commit",
      writes: [
        value === undefined ? deleteValue(memo) : setValue(memo, value),
        setValue(pendingToolOutput(drive.operationId, call.resultEntryId), out.snapshot()),
      ],
      next: state,
      materialize: () => undefined,
    };
  }, drive.context);
}
```

Both addresses are **ephemeral-scoped**, so this is a single-file transaction and
statically enforced as one ([scopes.md §3 and §6](../02-scopes/scopes.md)). `operationToolMemo` is
placed in that scope precisely for this. Ordering on the Session line would not be
enough — two file writes are not atomic. The periodic checkpoint stays as it
is — best-effort, for the interruption path; this forces one where correctness
requires it.

The invariant holds because the tool does X, writes X's output to the sink, *then*
calls `setMemo("did X")` — so the sink's state at commit time already contains X's
output.

**Ordering alone does not work**, in case it looks tempting:

- memo first, checkpoint second → crash between → replay skips X and the seeded
  output lacks it → silent loss;
- checkpoint first, memo second → crash between → replay redoes X and appends
  again → duplicated output.

Duplication is the less bad failure, so ordered writes are a tolerable fallback,
but neither is correct.

**Cost:** `setMemo` now writes a full capped output state rather than a small
value. Memos are rare — a handful per invocation — so this is bounded by
`memo count x cap`, not by output volume.

### 7.6 `openProgress` has a write-ordering race

`commitWrite(item)` captures `item` when `write()` is called, and the write is
fire-and-forget with only `latest` tracked. A checkpoint captured at T1 can
therefore commit *after* a memo-bundled checkpoint at T2, overwriting newer state
with older — reintroducing exactly the loss §7.5 prevents.

Fix: resolve the sink's state inside the command planner rather than at call time.

```ts
commitWrite: () => setValue(address, out.snapshot())   // evaluated under the Session line
```

`lane.command` serializes on the Session line, so checkpoint writes become
monotonic by construction. This removes the race generally, not only against
memos.

### 7.7 Nothing on the durable path runs tool code

Ops are interpreted by a six-verb applier with no domain knowledge, so a tool
rewritten between crash and resume cannot make a persisted stream unreadable.

> **The durable path uses only harness-owned reducers.**

This also rules out persisting *facet* ops. The harness has no facet state,
facets come and go, and a recovering harness must rebuild its working values with
no facet present.

## 8. Open questions

- **Property tests for the tracker** (`delta.md` §3.3). Everything here rests on
  producer and replica agreeing; nothing currently proves they do.
- Coalescing window: per tick, or a byte/time threshold.
- Whether image count needs a bound. Images are unwindowed, so a tool pushing
  them in a loop grows `content` without limit. Currently treated as a tool bug.
- Whether details need a bound for the same reason (§2.1).
- Whether `retain: "head"` should keep emitting counter-only updates once capped
  so a renderer can report how much was suppressed. [`execenv.md`](../03-execenv/execenv.md) answers this
  for exec-originated output; agent-side output needs the same answer.
- Whether a failing tool *should* be able to terminate, or whether the current
  inability is deliberate — there is a reasonable argument the model should
  receive the error and decide.
- **Derived values.** `arguments` parsed from accumulated JSON should not be
  replicated; derive it on demand. Safe because `parseStreamingJson` is total —
  four fallbacks ending in `{}`, it cannot throw — so a replica derives with no
  error path and no agreement protocol. Generalises to: no derived fields in
  replicated state.
