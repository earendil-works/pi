# Group commit for the Durable Session

Status: design, revision 2 (after three reviews). Branch `durable-perf` (worktree `~/pi-perf` on slayer), on top of the
uncommitted prerequisites (record cache, conversation tails, kept context ranges advanced at publish, task-document
index, deferred tool-slot `running` and generation attempt). Read `docs/spec.md` §1, §4, §4.1, §5, §8, §10.1 alongside.

## 1. Problem

A Session has one mutation line (`SessionImpl.#tail`). Each commit runs its callback, settles, calls `Storage.commit()`,
and adopts while holding the line, so every storage round trip of every conversation is serialized. After the
prerequisites the line makes no storage reads in a normal run; a run that calls one tool stores 12 commits. Measured on
slayer (one Harness, faux model, MemoryStorage with a simulated round trip per call, 32 concurrent conversations):
26.8 runs/s at 4 ms, 84 at 1 ms, 895 at 0 ms (CPU, one core). Throughput is fixed by the line.

Group commit sends the commits that accumulate while one write is in flight as one storage call. Modelled with result
fences (each job on a run's critical path waits about one round trip): ~250 runs/s at 4 ms with 32 conversations,
rising toward the CPU ceiling with more conversations. A conflict probe (`/tmp/conflict`) measured, per run, 0 writing
jobs that would wait for one tool call or a streamed answer, 0.13 for three parallel tools.

## 2. Semantics

### Unchanged

- Every logical commit keeps its own `seq`; history (`snapshotAsOf`, fork `asOf` copies, `createdAt`/`retiredAt`)
  keeps per-commit boundaries.
- A commit's promise resolves only once it is durable and published; outcomes are delivered in line order (§5.1).
- Publication is in line order, deferred commits included (§5.2): telemetry events, Session listeners, the
  `observeCommits()` dispatch, waits and aborts per commit; host observers of commit A run, and the continuations of
  public waits A resolves start, before commit B is published (§5.3).
- No callback observes unstored state (§4). Memory adopts a commit at its publication.
- A commit adopted by Storage and then rejected stays published and rejects, as today (§3.4).
- Storage failure is fatal; callers are never told something storage does not hold.

### Changed (accepted)

1. A callback can run while an earlier commit's storage call is in flight. It runs until its first touch of a key an
   unpublished commit wrote, waits until that commit's storage call settled and it is published, then continues. Code
   before that touch runs early, assignments to caller variables included; acting on such values before the commit
   resolves was already unsafe (a callback's own writes can fail to store today).
2. Cancellation is checked when a job starts; a job can start earlier.
3. If a batch fails fatally, later callbacks may already have run; their outcomes are `SessionFailed` (§5.1).
4. On a path that fails the Session, which commits survive differs: a stored prefix survives. Every caller's outcome
   matches storage. On a bug path (adoption or an internal listener of part i throws) parts after i can be durable but
   unpublished; their commits reject with `SessionFailed`; reopening recovers them. Likewise, once another error has
   failed the Session, a call that settles afterwards, and the parts of a call not yet published when it fails, are
   durable but unpublished and reject with `SessionFailed` (the first error); an `observeCommits()` consumer, such as a
   replica, misses them until reopen.
5. Read results (`tx.task()`, `tx.conversation()`, `getTask()`, `runtime.entry()`, entries in published commits) are
   frozen shared objects; mutating one throws (documented on `Tx`).
6. Prerequisite presentation changes (spec §8.2, §8.4 updated): a tool slot's `running` and a nested slot's final
   arguments, and the generation's attempt, are stored like progress; after a crash a slot may show `pending` while
   the task's checkpoint is `execute` (a safe rerun sets it again).
7. A wait whose commit is in flight when close begins ends with the closed error; the commit is still stored and
   published by the drain (today this already happens when close lands before adopt).
8. Spec text to update: invariant 7, §4 (host listeners run while the line is held), §4.1 (holds leave at the last step
   before `Storage.commit()`: now at logical admission), §10.1 (per-part outcomes), the `observeCommits` doc, the
   `SessionImpl` class doc, the scheduler class invariant (decisions stay serialized; their storage overlaps).

## 3. Storage

### 3.1 `commit`

```ts
/**
 * Persist `batches` in order, each as one ordinary atomic commit with its own seq, checked against the state the
 * earlier ones left, in as few round trips as the backend can. Stops at the first batch Durable's own checks refuse:
 * the batches before it are durable, it and the ones after are not. Calls `receive(index, seq)` once per durable batch,
 * in order, synchronously, after all of them are durable and before the next commit starts. Resolves with the number of
 * durable batches and the refusal, if any. Rejects for an unknown outcome (connection lost, statement or commit
 * failed); `receive` calls made before the rejection still stand.
 */
commit(
	batches: readonly (readonly StorageWrite[])[],
	receive: (index: number, seq: Seq) => void,
	context: Context,
): Promise<{ readonly stored: number; readonly refused?: unknown }>;
```

`receive` is a durability receipt, not publication: the Session publishes later (§5.3). It is Storage's only write
method (it replaced the earlier one-batch `commit(writes, adopt, context)`, and took its name): every backend implements
it natively. Tests and suites that write one batch directly use `commitWrites()` (`@earendil-works/pi-durable/testing`),
which throws the refusal.

Example: `[A, B, C, D]`, C refused. A and B are durable and published; C rejects with the refusal; D rejects with
`SessionFailed`; the Session fails. This is today's outcome (A and B stored, C fails, D never reaches storage).

### 3.2 Backends

A refusal is one of Durable's own checks (`checkGlobalIds`, `checkDocumentActions`, copy resolution), run against the
transaction's state before that batch writes anything. Any other error is an unknown outcome. No savepoints (Durable
Objects' SQL API does not allow them).

- SQLite: one transaction; per batch: read `next_seq`, run the checks, apply, advance; on a refusal stop and commit the
  prefix. `prepareDocumentActions` and `candidateNextId` per batch.
- MemoryStorage: per batch `prepareCommit()` (checks and detaches, changing nothing) then apply; stop at the first
  refusal (prefix semantics allow it).
- JSONL: check batch by batch against the in-memory state, append the prefix's commit markers in one write; a torn append
  recovers a shorter complete prefix, which prefix semantics allow.
- IndexedDB: one `readwrite` transaction per call (metadata read once, written once at the end). Per batch every read
  and check runs first (`checkGlobalIds`, `checkDocumentActions`, then `resolveCopies`, which reads each copy's source
  against the state the earlier batches left), and only then its writes. A refusal stops issuing writes; the transaction
  commits the prefix. An error of IndexedDB itself (a `DOMException`, or a failed request or transaction without an
  error, also as a check's cause) aborts the transaction: the call rejects with nothing stored.
- StoreStorage (p3's primary storage): one series of the Chord store's commit queue per call
  (`ChordStore.commitSeries`): one backend transaction for all batches, one seq and one outbox commit per batch, the
  store's metadata (`last_seq`, `next_id`) written once per call. A batch's `DurableCommit.check(step)` (ids,
  documents, copies through the step's reader, so it sees the earlier batches; the same reads a single commit makes)
  runs before its writes; a throw refuses it and the series commits the prefix, unless one of the check's statements
  failed (the store watches the check's executor), which rolls the series back and rejects, as does a throw of the
  writes; a failed `COMMIT` is an unknown outcome that stops the store. Receipts run after `COMMIT`, before the next
  step of the queue; the Session then publishes each commit in its own host batch (`publishing`). Memory per call is
  the call's staged commits and one receipt entry per batch; the catalog is copied only if a batch changes a table
  record.

A Storage may also implement `publishing?(publish: () => void, context: Context): void`: the Session calls it for each
part's publication and the Storage runs `publish` inside its own scope. StoreStorage implements it with its attached
host's `batch.within(...)`, so Chord sources over Durable's views stay marked in one batch per commit.

### 3.3 Wrappers

- `CachedStorage` applies write-through at publication (§5.3), not at the receipt. Its read rule becomes per key: a read
  records `version(key)` at its start and keeps its result only if no commit published since wrote that key. Versions
  exist only for keys with a read in flight (registered at read start, removed at read end), so the map is bounded by
  reads in flight.
- `GuardedStorage.commit` guards the call but does not fail the Session itself on rejection; the writer does
  (§3.4), after publishing the received parts.

### 3.4 Outcomes per logical commit

The writer keeps a ledger per call: which parts were received.

- Received: published (§5.3), then resolved through the fences.
- `commit` resolved with a refusal at part k: parts before k as received; part k rejects with the refusal; parts
  after k and every queued job: `SessionFailed`; the Session fails after the received parts are published.
- `commit` rejected: received parts are published first, then reject with the error (adopted-then-rejected, as
  today); unreceived parts reject with the error; the Session fails.
- Adoption or an internal listener of part i throws: part i as today (the Session fails after its storage call);
  parts after i are not published and reject with `SessionFailed`.

## 4. The line

### 4.1 Mechanics

- The line runs one job at a time; callbacks never interleave with each other's synchronous code.
- A job with writes, after its callback and settlement succeed, takes the held changes it will store (`takeHeld`) and
  joins the pending batch (logical admission). Its outcome is parked (§5.1).
- The writer runs off the line: it sends the pending batch with `commit` when no call is in flight and the previous
  call's parts are published. A job waiting on a gate never blocks the writer.
- Backpressure: at most `MAX_OUTSTANDING` (initially 256) admitted jobs whose outcome is not delivered, writing or not;
  beyond it the line waits.
- Unpublished write set: per key, the newest unpublished writer. Registered at logical admission (immediate commits) or
  at callback end (deferred commits, which stay in it until their publication); removed at publication only if the key
  still maps to that writer.
- Touch: every read or write a job makes checks its key. On a hit the job awaits the gate of the newest writer of that
  key, then proceeds. A gate opens when that commit is published and its storage call settled (holds released).

### 4.2 Keys

| Key | Read by | Written by |
|---|---|---|
| `task:<id>` | `tx.task`, committed-task reads, every task record a scheduler region reads (decided task, wait members and their `on`, cycle walks) | task create or write |
| `owned:<node>` | every node a walk over live children expands (`#hasOwnedLive`, `#ownedLive`, `#walkDown`, `#waitCycle`, `ownedTasks`, `#idle` in a line job) | task creation and a task becoming terminal: every node from the task's parent up to and including the nearest live task or the root conversation (the nodes `#relist` lists or unlists), chain loaded at admission if needed; conversation creation under a task: that task's chain |
| `roots` | global idle in a line job (`#idle(undefined)`) | every task creation whose chain reaches an ownerless conversation (directly or through terminal tasks and conversations), and every task becoming terminal there (conservative: whether the root is listed can change under pending commits) |
| `intent` | every cancellation check (`#belowCancelled`, `#cancellingOwner`, including the empty-intent fast path, `#inScope`, `#nearestLiveAbove`) | abort marks (set, upgraded, cleared), a non-completed held or terminal outcome, restart marks |
| `conv:<id>` | `tx.conversation`, `#requireConversation`, edge loads | conversation creation |
| `entry:<id>` | `tx.entry(id)`, `storage.entry(conv, id)` | entry append |
| `entry-append:<conv>` | `latestEntryId`, `latestHeadMarker`, entry scans, context bounds | entry append (blind) |
| `sub:<id>` | `tx.submission`, settlement/placement resolution | submission create or write |
| `req:<conv>:<requestId>` | `submissionByRequest` | submission creation with a request ID |
| `doc:<address>` | `tx.doc`, `retireDoc`, cold loads, `conversationDocumentOnLine`, fork copies of the source | document create/change/retire/copy at the address; held changes the commit takes |
| `docscope:<scope>` | `scanDocuments`, task-document index reads | document creation/retirement in the scope (blind) |
| `*` | scans that cannot be keyed (`scanTasks`, `scanSubmissions` by status, `scanConversations`); `unloadDocuments`, close, version reload | conflicts with every unpublished write |

Blind writes conflict with reads of the key, not with each other (appends with distinct minted IDs, creations in one
scope). Created records' keys are ordinary keys: a minted ID can leak through a caller variable before publication, and a
read of it waits.

### 4.3 Liveness-only reads (not keyed)

A stale read that only delays work needs no key: a reservation pass not seeing a task a pending commit made runnable;
a waiter's check whether its dependencies are still live; the projection of immutable ownership fields (`owner`,
`conversationId`, `background`) during chain loading (not the rest of `#loadChain`, which installs settled nodes and
null edges after the check); a reservation pass skipping a task with an invocation without reading its record.
Cancellation decisions and terminalization are never liveness-only.

### 4.4 Line reads outside `tx`

`readOnLine(job)` becomes `readOnLine((storage) => job)`: the job gets a gated Storage view whose reads record keys and
wait on gates. All current `readOnLine` call sites (harness.ts, scheduler.ts runtime reads, submissions.ts, task-graph.ts,
view.ts, `captureContextBounds`) use it; the Session's line helpers (`latestEntryId`, `latestHeadMarker`,
`conversationDocumentOnLine`, cold loads) are gated too. Off-line reads keep using the ungated Storage.

## 5. Outcomes and publication

### 5.1 Outcome fences

Every job's outcome (commits with and without writes, `readOnLine` jobs, deferred commits, callback errors) is
delivered in line order. A Session-fatal failure makes every later outcome `SessionFailed`; a nonfatal rejection (a
callback's own error, cancellation, validation, `ReadOnlySession`) affects only its job. Fences hold outcomes, not the
line. Exemption: a scheduler-internal job without writes whose outcome goes only to scheduler code and whose touch set
is clean (no hit) delivers at once; it is equivalent to having run before every unpublished commit. A job with writes
(a reservation, a step that faults, a reconcile pass) is never exempt: its outcome waits for its own publication, so no
invocation starts on a reservation that is not durable.

### 5.2 Deferred commits

A deferred commit's callback runs and settles like any job; its memory adoption and publication are fenced like an
immediate commit's publication: they happen when every earlier unpublished commit is published. Its keys stay in the
unpublished write set until then. Holds are taken at logical admission, so a commit never stores a hold adopted after
it in line order.

### 5.3 Publishing a call's parts

After `commit` settles (or the received prefix is known, §3.4): publish part 0 (cache write-through, conversation
tails, adoption, Session listeners, host dispatch, waits), then a macrotask hop (`setImmediate` where available, else a
`MessageChannel` message), then part 1, and so on. The hop lets public wait continuations (`Submission.wait()`,
`waitForTask()`, `commit()`) of part i start before part i+1 is published. Tests use the public APIs.

### 5.4 Close, unload, holds, eviction

- Close: seal admission; run close listeners; signal every invocation (scheduler); let admitted callbacks finish,
  gates included; drain pending and in-flight calls and their publication; join invocations and run `writeAtClose()`
  through the writer; store remaining holds through the writer; end observers; close Storage.
- `unloadDocuments()`, version reloads (also nested inside a callback), hold timer stores: `*` barriers through the
  writer; holds captured after the barrier.
- Documents with unpublished changes stay pinned.

## 6. Scheduler

Scheduler state changes at publication, as today. Inside a callback, decisions read it synchronously. Each decision is
restructured as a pure plan:

1. A decision region runs with a synchronous "recording" flag set; helpers record keys (§4.2) only while it is set
   (the same helpers run at publication inside `#observe`, unrecorded).
2. The region reads, records, and computes a plan or an error, staging nothing and mutating no scheduler state.
3. If a recorded key has an unpublished writer: discard the plan (or error), await the gate, reload scopes
   (`#loadScopes`), rebuild the overlay (`overlayOf`, `#links`), and run the region again. A waiting job holds the line,
   so unpublished writes only shrink; re-runs converge.
4. After a clean check: apply the plan: stage writes, mutate scheduler sets, create or end invocations, run `migrate`,
   take registry snapshots, report. None of these runs inside a region, so none repeats.

Sites to restructure (hardest first): `#reserve` (runnable iteration, abandoned marks, cut-off faults, `#resolve` with
`migrate` and reports, invocation creation); `#step`/`#decide` (registry refresh, `task_outdated` reports,
cancellation, `#end`); `#finalize` (rounds, overlay mutation, awaited `#settleOutcome` between rounds: one region per
round); `#validateWait`/`#waitCycle` (async member loads, cycle errors gated like plans); `abort`; `#commitState`
terminal (chain loads per overlay task, walk); `#reconcile` (intent walks, marks; it captures and clears work lists
before its commit: move the take inside, after the check). `abortConversation` and cascades scan with `*`.

Sweep: `#sweep` and `#scheduleSweep` do not drop nodes loaded by a job whose commit is unpublished; chain loads record
the nodes they install for their job, released at that commit's publication or failure.

Later, the ownership index can move into the Session behind `tx` reads with the same keys.

## 7. Bounds

- Outstanding jobs: at most `MAX_OUTSTANDING`, a count, not bytes: pending writes are bounded by what one commit can
  hold (tool output is bounded by output limits), times the count.
- Unpublished write set: one entry per key per newest writer, removed at publication.
- Cache versions: only keys with a read in flight.
- Fences, gates, ledgers: settled at publication or Session failure; nothing outlives close.
- Existing: record cache (conversations 4096, submissions 256; tasks: every live one, the ended ones a waiting or just-resumed task names, plus 256 ended), conversation tails (4096 IDs, 256 markers),
  task-document index (live tasks and their documents), kept context ranges (busy or within retention; an idle range
  past its expiry is dropped when an entry would extend it; expiry fixed at idle start, the timer uses the current
  setting: document and test), document cache (retention).

## 8. Tests

- `commit` per backend (conformance for every backend): prefix stored, refusal index, seq per batch, copies
  against earlier batches' state, JSONL torn append; IndexedDB: a copy refused mid-call keeps the prefix, an IndexedDB
  error in a check or a write rejects with nothing stored; StoreStorage: one backend transaction per call; Chord's
  `commitSeries`: refusal, a failed check statement and a throwing write roll back, a throwing receipt stops the store.
- Gating per key class, with deterministic interleavings: records; ancestor chain membership (live P → terminal B →
  terminal A → empty C, creation in C vs P terminal); global idle with empty roots; pending abort mark vs child step
  (empty-intent fast path); concurrent opposite waits; leaked entry ID read by `tx.entry`; request IDs; absent
  addresses; held documents (hold created after a reader prepared); `*` barriers; `readOnLine` read after an
  un-awaited commit.
- Outcome fences: no-write, read, deferred, callback errors in line order; nonfatal rejections do not poison later jobs;
  fatal failure poisons later outcomes.
- Deferred publication behind a pending immediate commit, and when that commit fails.
- Failures per part: refusal, rejection after receipts (received parts published, then rejected), adoption failure.
- Publication order through public waits: A's `Submission.wait()`/`waitForTask()` continuation sees B unpublished.
- Close during in-flight calls with an invocation waiting on its signal; unload, version reload, hold timer during
  flight; backpressure on all outstanding jobs.
- Scheduler retries: `migrate`, registry snapshots, reports and cleanup run once across re-runs; sweep vs chain loads.
- Randomized interleavings: random commits over overlapping keys, random latency and refusals; storage equals the stored
  commits replayed in seq order, no callback observed unpublished state (instrumented oracle), outcomes match storage.
- Prerequisites: tool crash at both sides of the intent commit (sibling flushing presentation first); kept range
  installed after a publication between return and install; live retention change; cache eviction and close; tails
  eviction, fork markers.
- Bounds: outstanding, write sets, versions, fences return to zero when idle.
- Existing suites: durable (both retention modes), workers.

## 9. Benchmark

Conc probe at 0/1/4/20 ms with 1/8/32/64/128 conversations, one tool, three parallel tools, streaming; dpetrou's repro
as is and with warm documents. Report throughput, p50/p95 run latency, batch sizes, gates per run, fence delay.
