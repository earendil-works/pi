# Bounded output publication

**Status:** the shared adaptive publisher and its `ExecutionEnv` use are implemented. Generic `ToolOutput` integration remains design work.

Depends on landed Chord delta tracking, source-bounded execution output, and scoped storage for durable batches.

## 1. Invariant

> The durable record, what the model sees, and what the UI shows are the same bounded view.

A spill file is not a second view. It is a file inside the execution environment that the model reaches through ordinary file tools.

Every uncontrolled producer boundary needs two independent bounds:

- **state size:** the latest retained text is capped;
- **publication:** both encoded bytes and event count are paced.

Delta encoding is complementary. It compresses a published change; it does not cap state or decide when publication occurs.

## 2. Boundaries

```text
remote process
  -> optional ExecutionEnv publisher
  -> worker ToolOutput publisher
  -> events + durability + replication
```

A publisher instance is required only before a real costly boundary:

- a physically remote execution environment limits output before transport;
- `ToolOutput` limits custom tools and downstream event/storage traffic;
- a colocated environment can feed its bounded updates in process without another serialized transport;
- custom tools bypass `ExecutionEnv` but cannot bypass `ToolOutput`.

The control algorithm is shared. Payload vocabularies differ: Shell uses replace/append/slide/metadata; `ToolOutput` uses Chord operations.

## 3. Why size or cadence alone is insufficient

A fixed 50 KB snapshot is safe per event but not over time. At 100 ms it permits ten complete snapshots per second, approximately 500 KB/s plus envelopes.

A byte budget alone also permits excessive tiny events and durable transactions. A minimum interval bounds count; encoded-size debt bounds bandwidth.

The original handoff incorrectly treated `intervalMs = 100` as 100 emits/s. It is ten emits/s. The fixed interval was still non-adaptive: it delayed small trickles while allowing complete windows at the same frequency.

## 4. Landed adaptive algorithm

`packages/agent/src/harness/utils/adaptive-publisher.ts` implements:

```ts
nextDelayMs = max(globalMinEmitInterval, encodedUpdateBytes * 1000 / globalTargetBytesPerSecond);
```

Current harness-global policy:

```ts
minEmitInterval = 100 ms;
targetBytesPerSecond = 100 KB/s;
```

Behavior:

1. The first dirty state after idle publishes immediately.
2. Writes before the next deadline collapse into the latest state.
3. One trailing timer publishes held state after the deadline.
4. Completion and correctness boundaries force one bounded publication.
5. The publisher commits its baseline before consumer delivery, preventing duplicate deltas if a consumer applies and then throws.

This is an amortized token bucket with a cap-sized burst. A leading or forced terminal update may exceed the target over a short interval, but sustained encoded bytes converge to the target and sustained event count cannot exceed the minimum-interval floor except for explicit forced correctness writes.

## 5. Scenario traces

Assume a 50 KB cap, 100 KB/s target, and 100 ms floor.

### Below cap, completes

The initial state publishes immediately. Small appends publish no faster than the floor, and final dirty state is forced. Total encoded text is approximately the produced text.

### Below cap, trickling

Writes arriving more than 100 ms apart publish immediately because the preceding deadline has already passed. Faster writes collapse into one append per floor interval.

### Above cap, full force

The retained state never exceeds 50 KB. Complete window turnovers encode as bounded replacements. A roughly 50 KB update buys about 500 ms of silence, yielding approximately two updates and 100 KB per second regardless of raw producer throughput.

For shell execution, the complete stream goes to a source-local spill under backpressure rather than over the output-update channel.

### Above cap, trickling

A small tail movement encodes as truncate plus append (Chord) or `slide` (Shell). Its encoded size is small, so the 100 ms floor dominates and output remains responsive. Resending a complete 50 KB snapshot for each tiny slide would be both slower and larger.

### Burst then silence

The leading state is immediate. Held writes collapse, and one trailing timer publishes the latest residue. There is no polling timer.

### Huge single write

The producer may already have allocated its input, but the boundary retains and publishes only the configured cap. Shell spill keeps the complete source stream. Arbitrary custom-tool images and structured details still require separate limits.

## 6. Forced writes

These bypass pacing once, while remaining state-size bounded:

- command/tool completion;
- error or abort;
- a memo and output checkpoint committed atomically;
- an explicit recovery base/rebase.

A terminal flush cancels the trailing timer before `tool_end`, preventing a late update for a settled invocation.

## 7. `ToolOutput` application

The sink will own one Chord tracker and encoder per invocation. Mutations remain local while publication is blocked; flush-time dirty tracking means held writes collapse without retaining one op per write.

One sink flush feeds the live event and current model-visible state. Durable batches use the same logical flush, encoded as per-stream `WireOp[]`. Periodic `rebase()` bounds recovery replay; a memo correctness flush writes a tagged base batch in the same transaction as the memo.

Durable cadence belongs to the sink, not to Shell or bash. Bash's existing two-second checkpoint request remains only as an interim compatibility mechanism until the sink migration.

## 8. Remaining decisions

- Explicit byte/count rejection policy for images.
- Bounds for structured details; arbitrary JSON cannot be meaningfully tail-windowed.
- Whether ordinary durable writes ride every live sink publication initially or use a slower measured cadence. Memo and terminal correctness flushes are not optional.
- Exact global production values after profiling real remote transport and storage.
