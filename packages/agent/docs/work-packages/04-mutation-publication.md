# WP04 — Mutation publication and event delivery

## Status

Complete. Phase A and the final implementation rereview passed Fable with no findings. Focused agent/server/SQLite tests, `npm run build`, `npm run check`, and `./test.sh` pass. `packages/agent/docs/harness.md` remains normative.

> Historical note: WP06 later replaced the lane-creation API and keyed line described in this completed handoff with atomic `AgentHarness.lane()` acquisition on one Session line. The event-publication guarantees remain current.

WP02 established atomic acceptance, recipient binding, and coherent lane watches. WP03 removed drive deadlines. WP04 removes the caller-operated event-delivery gate without weakening those guarantees and makes the historical `Session.createLane()` own lane creation end to end. The direct durable-drive package follows as WP05.

## Problem

A committing lane job currently uses a two-part event API:

```text
inside Session.mutate:
  commit
  publish process-local state
  delivery = events.enqueue(batch, context)

outside Session.mutate:
  await delivery.start()
```

The split preserves the correct boundary, but it is a footgun: calling `emit()` too early, calling `start()` too early, or dropping `start()` can violate observation semantics or stall the global event tail. The historical `Harness.createLane()` repeats the choreography manually.

Lane creation has a second one-off boundary. The historical `Session.createLane()` owns validation and the durable transaction, but Harness cannot publish its process-local `Lane` and bind `lane_created` recipients from that same commit continuation. Harness therefore opens `Session.mutate()` itself and calls exported `createLaneWithMutator()`.

WP04 removes both caller-operated seams while preserving current direct-listener and hook barriers.

## Required semantics

### Direct events remain awaited observations

Direct `events.on()` listeners remain passive but causally ordered:

```text
hook or preparation
→ commit
→ publish process-local state
→ bind and append event batch
→ release lane mutation line
→ await direct listeners
→ resolve operation
→ later hook or transition
```

Passive means a listener cannot transform the in-flight operation and listener failures are isolated as `handler_error`. It does not mean fire-and-forget. An extension may update process-local state in an event listener and inspect it from a later hook. Awaiting also supplies producer backpressure.

A direct listener must not call a state-mutating harness API: an emitted mutation would queue a later event behind the event currently awaiting that listener. Read-only lane calls remain legal.

Deliberate exceptions remain unchanged:

- watchers and RPC/watch consumers use their own buffered FIFO and are not awaited by operations;
- fault publication is fire-and-forget, and close never waits for listener completion;
- high-frequency tool updates enqueue every event and retain only the latest delivery promise; tool settlement awaits that promise before `after_tool` and outcome publication, which drains all earlier updates through global FIFO without per-update backpressure.

### Commit and recipient binding remain one continuation

Every event-producing committing lane job performs, in the exact continuation that observes successful commit:

```text
commit succeeds
→ publish complete process-local state
→ synchronously call emitBatch(batch, context)
   - clone payloads
   - bind current ordinary listeners and watchers
   - append the complete batch to the global delivery tail
→ return from the mutation callback
```

There is no scheduler-owned after-release publication phase. Moving recipient binding into a later promise continuation creates a gap in which another task may observe committed state and register a listener before the old event binds recipients.

`emitBatch()` starts asynchronous delivery immediately and returns its completion promise. The mutation callback never awaits that promise. Listener code may begin after publication/binding but before the mutation line technically releases; a reentrant lane read queues behind the current job. The command carries the promise out of `Session.mutate()` and awaits it before resolving publicly.

This preserves the two legal watcher races:

```text
watcher registration first
→ snapshot-before + complete buffered batch

commit publication first
→ snapshot-after + no old event
```

### Ordering

- One non-empty `emitBatch()` call publishes one contiguous batch.
- Batches enter the existing global event tail in `emitBatch()` invocation order, including across lanes.
- Events within a batch retain source order.
- Direct listeners run serially in registration order.
- Same-lane committing jobs bind batches in lane mutation order.
- A lane procedure awaits each command's delivery before invoking its next hook or transition.
- Hooks on unrelated lanes may overlap; there is no total cross-lane hook order.
- Context remains the exact emitting invocation Context and is always the final parameter.

## Event bus contract

Replace the public/internal delivery split with:

```ts
class HarnessEventBus implements Events {
  emit(event: HarnessEvent, context: Context): Promise<void>;
  emitBatch(events: readonly HarnessEvent[], context: Context): Promise<void>;
}
```

`emitBatch()`:

1. returns an already-resolved promise for an empty batch or a closed bus;
2. synchronously structured-clones every payload and binds its current recipients;
3. appends one contiguous delivery to the existing global tail;
4. delivers cloned payloads serially with the emitting Context;
5. isolates listener failures and publishes non-recursive `handler_error` as today;
6. returns a promise that resolves after eligible direct listeners settle and never rejects because a listener failed.

Synchronous publication defects such as an uncloneable internal payload still throw in the caller's commit continuation and follow the existing harness-fault path.

Delete:

- `HarnessEventDelivery`;
- `HarnessEventBus.enqueue()`;
- caller-operated `start()`;
- delivery gates and `pendingStarts`;
- close-time forced gate release.

`close(error)` seals listener/watch registration and future publication immediately. Already appended batches retain their bound recipients and drain through the existing tail; listener completion still does not block Harness close.

## Lane command integration

The commit branch of `Lane.command()` returns a plain internal outcome containing the caller result and optional delivery promise:

```ts
const events = decision.events?.(commit) ?? [];
const delivery = events.length === 0
  ? undefined
  : this.onEvent(events, context);

return {
  kind: "return",
  result,
  ...(delivery === undefined ? {} : { delivery }),
};
```

`onEvent` returns `Promise<void>` and delegates to `emitBatch()`. It is called only after commit, complete process-local state publication, and synchronous result materialization, as the final action before returning the mutation outcome.

After `Session.mutate()` returns:

```ts
if (outcome.kind === "reject") throw outcome.error;
await outcome.delivery;
return outcome.result;
```

Expected no-commit rejections publish no events. Commit/materialization/publication errors retain the existing harness-fault semantics.

## Session lane creation contract

The historical `Session.createLane()` owns validation, commit, and the synchronous committed-publication callback. Context remains last:

```ts
createLane(
  name: string,
  at: string | null,
  configuration: LaneConfiguration,
  onCommitted: ((context: Context) => void | Promise<void>) | undefined,
  context: Context,
): Promise<SessionTree>;
```

The implementation performs:

```text
enter the prospective lane's mutation line
→ validate name, absence, complete lane shape, and target
→ commit lane configuration + leaf + idle lane state
→ synchronously invoke onCommitted(context) in that same commit continuation
→ retain its returned promise inside a non-thenable outcome object
→ return from the mutation callback and release the line
→ await the retained promise
→ return Session.view(name)
```

The callback receives neither `SessionTree` nor `SessionMutator`. It is only the process-local publication point. Its synchronous prefix must complete the publication needed before another same-lane job can run. Ordinary Session callers pass `undefined`.

If validation or commit fails, the callback is not invoked. If the callback throws after commit or its retained promise rejects after line release, the durable lane remains and the caller rejects; Harness converts that committed-publication defect to its existing fault path. A promise returned by the Harness callback is event delivery, whose listener failures are isolated by the bus.

The current lane validation/transaction implementation becomes private to Session. Delete exported `createLaneWithMutator()` and its direct tests.

Harness preconstructs a detached `Lane`, then calls Session:

```ts
const lane = this.buildLane(name, state);

await this.session.createLane(
  name,
  at,
  this.seed,
  (context) => {
    if (this.closedError !== undefined) lane.seal(this.closedError);
    this.lanesByName.set(name, lane);
    return this.events.emitBatch(
      [{ type: "lane_created", lane: name, at }],
      context,
    );
  },
  context,
);

return Result.ok(lane);
```

The callback's synchronous prefix publishes `lanesByName` and binds `lane_created` before the first creation job releases its line. A queued duplicate therefore cannot report `LaneExists` before the winner is visible through `harness.lane(name)`.

If close or fault wins while commit is admitted, the callback publishes the new Lane sealed. Emission on the already-closed bus is a resolved no-op, matching the existing admitted-creation race. The successful admitted creation still returns its sealed Lane.

## Scope

### Source

Modify:

- `packages/agent/src/harness/events.ts`;
- `packages/agent/src/harness/runtime2/lane.ts`;
- `packages/agent/src/harness/runtime2/harness.ts`;
- `packages/agent/src/harness/session/types.ts`;
- local Session implementations and tests required by the historical `createLane` signature;
- direct event primitive, acceptance, watch, lane, and harness tests.

Remote/experimental runtime behavior is not a design constraint for WP04. Session mutation authority remains process-local; do not add remote Session callback transport, protocol machinery, compatibility abstractions, or boundary tests.

### Documentation

Update normative `harness.md`:

- replace enqueue/start language with synchronous `emitBatch` binding and post-mutation awaiting;
- state accurately that listener execution may begin after publication/binding but before technical line release;
- retain awaited direct-listener, event/hook, watcher, Context, close, and ordering semantics;
- replace shared exported mutator-procedure lane creation with the historical `Session.createLane(onCommitted, context)`;
- update invariants, races, tests, glossary, and Part 8;
- link WP04 and move direct durable drive to WP05.

Update the historical WP02 handoff only where it points forward or claims the old mechanism remains current. Do not rewrite its completed-package record as though WP04 behavior landed in WP02.

## Non-goals

- fire-and-forget direct events or a public flush API;
- sequence/watermark delivery redesign;
- per-extension event queues;
- changing hook aggregation or event/hook causal barriers;
- changing watcher/RPC buffering;
- changing tool-update settlement barriers;
- making event-listener mutation safe;
- drive, breakpoints, providers, tools, recovery, retries, polling, abort, or terminal settlement;
- generic Session post-commit/after-release task APIs;
- remote callback execution or remote-runtime redesign.

## Required tests

### Event primitives

- `emitBatch` binds ordinary listeners and watchers synchronously;
- a listener registered after `emitBatch` but before delayed delivery receives nothing;
- a complete batch is contiguous and preserves event order;
- concurrent batch publication preserves invocation order;
- listener payload mutation remains isolated;
- listener rejection emits one non-recursive `handler_error` and does not reject delivery;
- empty and post-close batches resolve without delivery;
- already appended batches drain after close;
- no gate/start tests remain.

### Lane commands and watch

- direct listeners may perform reentrant read-only lane inspection without deadlock;
- a command does not resolve until its direct listeners finish;
- committed memory is visible to listeners;
- commit failure publishes nothing;
- a late listener that observes durable state receives no historical event;
- watcher-first yields snapshot-before plus the complete buffered batch;
- publication-first yields snapshot-after without replay;
- source Context identity survives delayed and buffered delivery.

### Lane creation

- Session callback runs exactly once after successful commit and never on validation/commit failure;
- callback synchronous publication occurs before a queued duplicate reports `LaneExists`;
- Harness Lane and durable configuration are visible to `lane_created` listeners;
- Harness waits for asynchronous `lane_created` listeners before resolving;
- admitted creation racing close publishes a sealed Lane and does not require event delivery;
- callback throw and retained-promise rejection after commit follow the documented committed-publication failure path;
- ordinary Session creation with `undefined` returns its view;
- no exported `createLaneWithMutator` remains.

### Ordering barriers

- acceptance events finish before `accept()` resolves;
- command resolution cannot overtake its awaited direct event delivery; WP05 tests the first subsequent procedure hook;
- event batches are globally ordered across concurrent lane publication;
- tool-update latest-delivery settlement behavior remains unchanged where implemented.

## Validation

After documentation:

```bash
git diff --check -- \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages/02-atomic-run-acceptance.md \
  packages/agent/docs/work-packages/04-mutation-publication.md \
  packages/agent/docs/work-packages/05-direct-durable-drive.md
```

After implementation, run every modified focused test, then:

```bash
git diff --check
npm run check
./test.sh
```

Review the final implementation with Fable before declaring WP04 complete. Do not commit without explicit user approval.

## Stop condition

WP04 is complete when:

- event publication has one `emitBatch()` operation and no caller-operated gate;
- recipient binding remains in the exact commit-observation continuation;
- direct event delivery remains globally FIFO and awaited before public operation resolution;
- existing event/hook causal barriers remain intact;
- lane watches retain exactly the two coherent race outcomes;
- Session owns lane creation and invokes Harness publication before releasing the creation job;
- `createLaneWithMutator()` is gone;
- Context is trailing and source-identical throughout;
- focused tests, `npm run check`, and `./test.sh` pass;
- final Fable review reports no findings.
