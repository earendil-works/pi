---
title: In the Step: when Durable's views change, and who hears it
cover: In the / Step
kicker: An explainer · Chord v2 slice 6 and pi-durable · 2026-10-26
subtitle: Why Durable's views must change inside the storage's commit, why the first build broke hosts, and what the "publication at adoption" proposal changes
stats:
  - 1 | Durable commit, seen as one change
  - 4 | regressions the first build had, all in one gap
  - 7 | things that change for hosts compared with HEAD
  - 5 | decisions for the owner
note: |
  Written for the owner from the build of `/home/badlogic/pi-observers` (uncommitted), the four reviews
  (`/tmp/observers-review-{astra,fable,opus,sol}.md`) and the four checks of the proposal
  (`/tmp/observers-proposal-{astra,fable,opus,sol}.md`), whose probes ran against HEAD, the first build and the
  proposal. Code is Durable's `session/session.ts` and `harness/*.ts` at HEAD, simplified. Nothing here is decided
  beyond what the decision log says ("Slice 6 first decisions", refined 2026-10-26).
colophon: In the Step · first edition · 2026-10-26 · from the observers build, its reviews and the proposal checks
---

# Before we begin {.preface}

Mario's phone shows a p3 conversation. Next to the transcript a small status line reads "last: tool call, 1 task
running". It is a Chord derive over two Durable views: the conversation view (the transcript) and the task graph (the
running tasks).

The model asks for a tool. Durable makes one commit, seq 41, that appends the tool-call entry and creates the tool's
task. The phone should go from "last: assistant, 0 running" to "last: tool call, 1 running" in one step. Today it can
show "last: tool call, 0 running" in between: a state that never existed. Slice 6 also puts Durable and Chord into one
store with one commit step, where every owner's memory must show a complete prefix of the log (S1, W1). Both need the
same thing: Durable's views must change inside the storage's commit, not after it.

This book explains where Durable publishes a commit today, why moving half of it broke hosts, and what moving all of
it changes.

## Seven things to know

:::findings
1. **Durable adopts inside the storage, but publishes after it.** `Storage.commit(writes, adopt, context)` calls
   `adopt` once the batch is durable; Durable's views, scheduler and host listeners all run later, after
   `Storage.commit` returned.
2. **Two watches tear one commit.** A derive over two Durable views sees seq 41 in one view before the other.
3. **The first build moved only Durable's internal observers.** Host listeners and telemetry stayed after the
   storage. Everything a host could see in between came out in the wrong order.
4. **All four regressions live in one gap:** the time between `adopt` and the end of `Storage.commit`.
5. **The proposal removes the gap:** the whole publication happens inside `adopt`.
6. **It changes seven things a host could observe**, most of them timing nobody documented, one a bug fix, one a real
   problem for Chord.
7. **The real problem has a small fix:** host listeners one microtask after `adopt`, outside Chord's batch (Opus's
   variant).
:::

## Words used throughout

**Durable** is pi's agent harness; a **Session** is its one line of atomic commits. **Storage** is Durable's storage
interface; `Storage.commit(writes, adopt, context)` stores a batch and calls **`adopt(seq)`** once it is durable.
Durable's **trackers** hold each loaded document's value in memory. **Internal observers** are Durable's own commit
listeners (`observeCommits`): the conversation **view** mounts, the **task graph**, the **scheduler** and the
**submissions**. **Host listeners** are what an app registers with `subscribeCommits`. A **watch** is a
`WatchHandle`: its listener runs a microtask after a frame arrives. **The gap** is the time between `adopt` and the
moment `Storage.commit` resolves. In Chord's store, the **commit step** is the store-wide serialized part of a commit
(backend transaction plus adoption), and the **batch** is Chord's synchronous adopt, mark and flush around it.
Letters in traces: **A** = `adopt`, **R** = `Storage.commit` resolves, **H** = host listeners, **C** =
`session.commit()` resolves.

# Today {#today lede="Where a Durable commit is adopted and where it is published, at HEAD."}

A Durable commit runs on the Session's line from start to end. Inside, `#runCommit` hands the batch to the storage
with an `adopt` callback, waits for it, and only then publishes:

```ts
// session.ts, #runCommit, at HEAD (simplified)
const adopt = (seq: Seq): void => {
  adoption = { documents: tx.adopt(seq) };          // trackers swap to the new values
};
seq = await this.#storage.commit(writes, adopt, context);
// ... back in the Session, after R:
this.#publish(seq, writes, documents, context);      // telemetry events, internal observers, host listeners
return result;                                       // C
```

The SQLite storage calls `adopt` right after `COMMIT` returned. JSONL calls it and then still awaits its own cleanup
of sidecar files before it resolves:

```ts
// jsonl/storage.ts
adopt(seq);                                           // A
await this.reclaimSidecars(reclamations, context);   // still inside Storage.commit
return seq;                                           // R
```

:::sequence animate | One Durable commit at HEAD. The trackers change inside the storage; everything that tells anyone about it happens after the storage returned.
actor session "Session" "the line" accent
actor storage "Storage" "JSONL" muted
actor obs "internal observers" "views, graph, scheduler"
actor host "host" "subscribeCommits"
actor watch "watch listeners" "microtasks" blue
session -> storage: commit(writes, adopt)
storage -> storage: write, marker durable
storage => session: A: adopt(41), trackers swap
storage -> storage: reclaim sidecars
storage --> session: R
session -> obs: telemetry events, then observers (views advance, waits resolve)
session -> host: H: subscribeCommits(41)
obs -> watch: frames queued, delivered next microtask
session --> session: C
:::

Two things follow. A host listener always runs before any watch listener of the same commit: the observers queue the
watch deliveries as microtasks, and the host listeners run synchronously right after them. And nothing is published
until the storage is completely done.

## The tear

Chord follows a Durable view through its watch. Two views mean two watches, and each delivers in its own microtask:

```ts
const status = self.derive([conversationView, taskGraph], ([view, graph]) => ({
  last: view.entries.at(-1)?.kind,
  running: graph.tasks.filter((t) => t.status === "running").length,
}));
```

```trace
commit 41 (entry + task)
  microtask 1: view watch delivers 41   → derive: last "toolCall", running 0    ← never existed
  microtask 2: graph watch delivers 41  → derive: last "toolCall", running 1
```

The phone receives both. Chord's rule W1 says a commit changes its sources inside one step and the derives over them
recompute once, right after. For Durable's views that means: they must change inside `adopt`, and Chord must follow
them as sources marked there, not through watches.

## Why after is not good enough for the store

In Chord's store, Durable's storage (`StoreStorage`) runs `adopt` inside the store's commit step, and the step lets
the next owner's commit start as soon as `adopt` returned. Durable's `#publish` runs later, after its `await`. In
between, a Chord object's commit can adopt, flush and recompute a derive that reads a Durable view still at 40. The
owner ruled out the alternative, a store that waits for Durable's continuation: no Durable special cases in the store.

# The First Build {#first lede="Moving half the publication into adopt, and the four things that broke."}

The first build moved Durable's internal observers into `adopt` and left the rest of `#publish` (host listeners,
telemetry events) after R. To keep host code from waking too early, it added `afterPublish(callback)`: observers queue
what wakes a host (resolving a wait, aborting a run, `onWake`), and the queue runs after the host listeners.

```ts
const adopt = (seq: Seq): void => {
  const documents = tx.adopt(seq);
  this.#observeStored(seq, writes, documents);       // internal observers, inside A
};
seq = await this.#storage.commit(writes, adopt, context);
this.#publish(...);                                    // host listeners, after R
this.#settle();                                        // afterPublish callbacks
```

Durable's state (views, the scheduler's idle state, the metric counts) now changes at A. Hosts hear about it at H,
after R. Everything that runs in between sees a commit that is half published. Four reviewers found four ways that
shows, each reproduced with a probe.

:::steps | The four regressions
+++ Watch listeners before host listeners
The observers call `Watch.advance()` inside A; the watch delivers a microtask later. The storage's own `await` and the
Session's `await` resume later still, so the watch listener runs first.

```trace
HEAD:        A … R → H → watch
first build: A (watch queued) → watch → R → H
```

Even with the memory storage. With JSONL the watch listener runs before `Storage.commit` resolved; if the storage then
rejects, the watch has shown a commit whose `commit()` failed.
+++ waitForIdle answers early
The scheduler's idle state is updated in A. A host that calls `waitForIdle()` in the gap gets the fast path ("already
idle") and resumes before H.

```ts
harness.subscribeCommits((p) => seen.push(p.seq));
// a task-graph watch listener runs in the gap:
await harness.waitForIdle(ctx);          // resolves before seen has the terminal commit
```
+++ A late subscriber misses the commit
When nothing listened at A, the publication is never built. A host that subscribes during the gap gets nothing for
that commit; at HEAD the listener list was read after R, so it did.
+++ The metric drifts after a rejection
A storage that rejects after A (JSONL's cleanup fails): the scheduler counted the new task in A and queued its `+1`
for the metric; the failure seals the scheduler, which subtracts `-1`; the queued `+1` is dropped with the failed
commit.

```trace
HEAD:        []        (nothing observed, net 0)
first build: [-1]      (net -1)
```
:::

Fable found three more of the same kind: a host listener that closes the Harness makes resolved waits reject;
scheduler line jobs queued in A jump ahead of a host listener's own commit; abort listeners moved after H. The
patches each reviewer suggested were more `afterPublish`. The owner called it what it is: special-casing.

# Publication at Adoption {#proposal lede="One rule: a commit is published when it is adopted, all of it, inside adopt."}

The gap is the bug. The first build created it by splitting the publication. The proposal moves all of it:

```ts
const adopt = (seq: Seq): void => {
  const documents = tx.adopt(seq);                              // trackers, as today
  const publication = this.#publication(seq, writes, documents);
  this.#events(writes);                                         // pi.durable.entry / .submission, contained
  this.#notifyInternal(publication);                            // views, graph, scheduler, submissions
  this.#notifyHosts(publication);                               // subscribeCommits
};
seq = await this.#storage.commit(writes, adopt, context);
// after R: touch documents, sweep, fail() for an error an observer threw; nothing is published here
```

The order inside is HEAD's: telemetry events, internal observers, host listeners. `afterPublish` disappears. Waits
need nothing special: an observer resolves a promise in A, and the waiter's continuation runs later by nature, after
the host listeners already ran synchronously. One rule replaces the special cases: `adopt` runs no task code. The
only synchronous path into task code is `AbortController.abort()` of a newly marked run (abort listeners run inside
`abort()`), so that one is queued with `queueMicrotask`. `adopt` never throws: every listener, every report and every
telemetry call inside it is contained.

:::sequence animate | The same commit under the proposal. Everything happens inside A; R and C only end it.
actor session "Session" "the line" accent
actor storage "Storage" "JSONL" muted
actor obs "internal observers" "views, graph, scheduler"
actor host "host" "subscribeCommits"
actor watch "watch listeners" "microtasks" blue
session -> storage: commit(writes, adopt)
storage -> storage: write, marker durable
storage => session: A: adopt(41)
session -> session: trackers swap, telemetry events
session => obs: observers: views advance, waits resolve
session => host: H: subscribeCommits(41)
obs -> watch: watches, waits, abort: next microtasks
storage -> storage: reclaim sidecars
storage --> session: R
session --> session: C
:::

What this does to the regressions, verified by Opus and Fable with probes against HEAD:

| regression | HEAD | first build | proposal |
| --- | --- | --- | --- |
| watch listeners vs H | H, watch | **watch, H** | H, watch |
| `waitForIdle` in the gap | after H | **before H** | after H |
| metric after a rejection following A | 0 | **−1** | 0 (+1, −1) |
| `close()` from H, then `waitForTask` | resolves | **rejects** | resolves |
| scheduler jobs vs H's own commit | H first | **jobs first** | H first |
| stuck state, lost reports | none | yes | none |
| allocations per commit | baseline | more | about HEAD |

HEAD's whole non-e2e Durable suite (73 files, 1404 tests) passes on a build of the proposal. The four tests the first
build added that encode its split fail, as they should, and are replaced.

# What Changes for Hosts {#changes lede="Seven things a host, a task or a storage could observe, compared with HEAD."}

Nothing in the public API changes. These are the differences in behaviour the four checks found.

## 1. With JSONL, everything runs before the storage is done

```trace
HEAD:     marker → A → cleanup … → R → observers → H → watches, waits → C
proposal: marker → A { observers, H } → watches, waits, abort → cleanup … → R → C
```

Host and task code woken by a commit now runs while JSONL still cleans up its sidecars. It cannot reach the storage
through the Session: the line is still held, so a commit or read it starts waits. The memory, SQLite and IndexedDB
storages do no work after A, so for them only the microtask placement differs, and the order is HEAD's. No spec
section promised "after `Storage.commit` resolved". Verdict: harmless; the spec gets one sentence.

## 2. Abort listeners fire after host listeners

```ts
runtime.signal.addEventListener("abort", () => log(hostSaw(id)));
// HEAD: false (abort before H)    proposal: true (abort after H)
```

At HEAD the scheduler aborted a newly marked run inside `#publish`, before the host listeners. Under the proposal the
abort is a microtask after A, so after H. No contract fixes this order. Decision for the owner.

## 3. A commit the storage rejects after A is published

A host keeps a replica from `subscribeCommits`. JSONL wrote the marker (the commit is durable), called `adopt`, then
failed while cleaning up and rejected.

```trace
HEAD:     durable, but no observer and no host listener ran → the replica misses it
          → replica ≠ storage; waits of that commit reject; the Session fails
proposal: published at A → the replica gets it → replica = storage
          → waits of that commit resolve; the Session fails after R
```

Durable's spec says a replica fed by `subscribeCommits` "stays equal to Storage"; HEAD breaks that, the proposal keeps
it. Spec invariant 2 changes from "published only after its storage commit succeeds" to "published once it is
durable, even when `commit()` then rejects". Decision for the owner; all four checks recommend it.

## 4. A subscriber that arrives late misses the commit

```ts
// host code that runs in the gap, between A and R:
harness.subscribeCommits(listener);   // HEAD: gets commit 41; proposal: does not, 41 was published at A
```

Consistent with the rule: a listener added after the publication misses it, as one added after `#publish` did at
HEAD. Documented, nothing to decide.

## 5. An observer that throws fails the Session after the host listeners

At HEAD, a throwing internal observer failed the Session at once, inside `#publish`: close listeners and the
`session_failed` report came before the host listeners. Under the proposal, `adopt` records the error, lets the other
observers and the host listeners run, and the Session fails after R. The commit stands, as before. Failing inside A
instead would make Durable's storage guard reject the caller of a durable commit with `SessionFailed`. Verdict: keep
it so.

## 6. Telemetry that throws no longer breaks memory

At HEAD, `#publish` called `context.telemetry.addEvent` for each entry and submission without protection. A throwing
adapter rejected a commit that was already durable and adopted, skipped every observer and host listener, and left the
Session healthy: the scheduler and the views missed the commit for good. Inside `adopt` nothing may throw, so the
proposal contains it and reports it; the commit resolves. This fixes a HEAD bug. The report needs a type (`host_error`
with callback `"telemetry"` is the suggestion). The same containment must cover Durable's report path itself
(`safeReport` records a metric and a span event outside its `try`), or `adopt` is not truly throw-free.

## 7. Host listeners would run inside Chord's batch

This is the one that matters. In Chord's store, `StoreStorage` runs Durable's `adopt` inside the store's commit step,
inside Chord's batch, where Chord refuses reentrant calls (`self.tx`, `get`, `watch`, `close` throw
`invalid/reentrant`). Under the proposal the host listeners run inside `adopt`, so inside that batch:

```ts
// p3 code that mirrors Durable's commits into a Chord object
harness.subscribeCommits((publication) =>
  chord((ctx) => audit.record(publication.seq, ctx), context));   // throws invalid/reentrant
```

The listener keeps every rule Durable states (synchronous, no Session calls) and still fails. Its error is reported;
an `onReport` that itself uses Chord throws too, and a throwing `onReport` is dropped, so the work vanishes without a
trace. And every host listener's run time is added to the store-wide commit step that every other object's commit
waits for.

:::flow wide | Under the proposal, a host listener runs inside Chord's batch; Chord calls from it are refused.
row "Store commit step (one at a time for the whole store)" accent
box backend "backend transaction" "`BEGIN … COMMIT`" muted
box adopt "Durable's adopt" "trackers, views, scheduler" accent
box hostin "host listeners" "inside the batch" dashed
row "Chord"
box flush "flush" "derives, wire, watches queued" blue
box refused "`self.tx` from a listener" "`invalid/reentrant`" dashed
arrow backend -> adopt "durable"
arrow adopt -> hostin "proposal"
arrow hostin -> refused "Chord call"
arrow adopt -> flush "after the step"
:::

# The Microtask Variant {#variant lede="Host listeners one microtask after adopt: same results, outside Chord's batch."}

Opus proposed a variant that keeps every result of the proposal and moves only the host listeners out of the step.
The publication is still built in A and the internal observers still run there. The host listeners are dispatched in
one microtask that is queued before the internal observers run:

```ts
// inside adopt, after tx.adopt(seq)
this.#events(writes);                                            // contained
if (this.#commitListeners.size > 0) {
  const listeners = [...this.#commitListeners];
  queueMicrotask(() => {
    for (const listener of listeners)
      contained(() => listener(stored, context), (error) => this.report(error, LISTENER, context));
  });
}
for (const listener of [...this.#internalListeners])
  contained(() => listener(observed, context), (error) => { failure ??= { error }; });
```

Microtasks run first in, first out. The host dispatch is queued before anything the observers queue, so the host
listeners still run before every watch delivery, every resolved wait, every abort and `onWake`. And it is a
microtask, so it runs after the storage's synchronous step: after Chord's batch and flush, where Chord calls work.

:::sequence animate | The variant inside Chord's store. The step stays synchronous and short; host listeners run right after it, first of everything the commit woke.
actor store "store step" "one at a time" accent
actor durable "Durable adopt" "views, scheduler"
actor chord "Chord batch" "mark, flush" blue
actor host "host listeners"
actor later "watches, waits, abort" muted
store -> store: backend COMMIT
store => durable: adopt(41): trackers, events
durable -> host: queue H (microtask 1)
durable -> durable: observers: views advance (sources marked)
durable -> later: queue watches, waits, abort (microtasks 2…)
store => chord: flush: derives over both views recompute once
store --> store: step ends, next commit may start
host -> host: H runs: Chord calls allowed
later -> later: then watches, waits, abort
:::

Chord needs nothing Durable-specific: only that its commit step and its flush are synchronous, which its design
already states. The store never knows Durable's continuation, as the owner required.

What the variant gives up compared with the proposal: host listeners are no longer called synchronously from inside
`adopt`, but one microtask later, still on the Session line and still before C. Opus ran HEAD's full non-e2e suite
against the variant (1404 of 1404) and all twelve probes: the same results as the proposal. One detail to settle while
building: the listener list is copied at A, so a listener removed between A and the microtask is still called once;
copying it inside the microtask avoids that, but then a listener added in between is called too.

# Decisions {.epilogue lede="What the owner decides before the rebuild."}

1. **The variant or the proposal.** The variant (recommended by Opus) runs host listeners one microtask after `adopt`,
   outside Chord's batch. The proposal runs them inside `adopt` and needs the documented rule "no Chord calls from
   `subscribeCommits` or `onReport`".
2. **Abort listeners after host listeners** (change 2): acceptable, or must the abort keep HEAD's place before them.
3. **Publish a commit the storage rejects after `adopt`** (change 3): recommended by all four checks; it fixes HEAD's
   replica gap and changes spec invariant 2.
4. **The report type of a throwing telemetry call** (change 6): suggested `host_error` with callback `"telemetry"`.
5. **HEAD's order inside the publication** (events, internal observers, host listeners) and a fully throw-free
   `adopt`, the report path included. These are fixes rather than choices; listed so they are not lost.

After the decisions: the spec rewrites (invariant 2, section 4 and its pseudo-code, the Storage contract, section 10
failures), new tests in place of the four that encode the split (order with the memory storage and with a storage that
works after `adopt`, `waitForIdle` in the gap, publication on a rejection with a balanced metric, close in the gap,
Chord-like reentrancy, telemetry throws), a rebuild by a fresh builder, and the four reviewers again.

# Sources {.appendix}

| what | where |
| --- | --- |
| HEAD code | `packages/durable/src/session/session.ts` (`#runCommit`, `#publish`), `harness/view.ts`, `harness/task-graph.ts`, `harness/scheduler.ts`, `harness/submissions.ts`, `storage/jsonl/storage.ts` |
| first build | `/home/badlogic/pi-observers` (uncommitted) |
| reviews of the first build | `/tmp/observers-review-{astra,fable,opus,sol}.md` |
| the proposal | `/tmp/observers-proposal.md` |
| checks of the proposal | `/tmp/observers-proposal-{astra,fable,opus,sol}.md`; probes in `/tmp/obsprobe-*` |
| decisions so far | `packages/chord/docs/next/decisions.md`, "Slice 6 first decisions" |
| Chord rules | `packages/chord/docs/next/design.md` §11 (W1, the batch), §24 (Durable integration) |
