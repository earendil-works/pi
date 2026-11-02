# Slice 6b: Durable and jobs on the store (spec)

Status: **built** (2026-10-28, pi `14b4c56e5`: one build, a build review and two fix rounds by the four spec reviewers;
reopen, the one-entry commit's mean and the resume watch's CPU accepted by the owner). Was: ready to build (2026-10-27).

The single source for building 6b, together with `design.md` read in full; the decision log `decisions.md` (later
entries win), in particular "The store", S1, S2, S4, S10, S11, S13, S15, W1, W12, "Slice 6 first decisions", "Durable's
synchronous observers", "Text is plain UTF-8", "Failures are watch calls", the "One vocabulary" entries, "The performance
and memory bar", and every "Slice 6b" entry; `slice-6a.md` (what 6a built); the feature map and the carry-over of
`slices.md` (6b); the root `AGENTS.md` "Chord v2 Code Style".

6b puts Durable on the store (`StoreStorage`), follows Durable's views as Chord sources (`self.follow`), persists jobs,
and extends the applier to every write kind. A worker then has one store: Chord's objects and Durable's Session commit
through one queue, and a commit of either is one seq in one outbox.

## What an app can do after this slice

```ts
// p3 worker base code
const store = await openStore(sqliteBackend(db), ctx);
const host = createHost<P>({ address: Session({ id }), principal, store, onError });
await host.load([{ name: "@p3/core", facet: coreWorkerFacet({ init, store }) }, ...plugins], ctx);

// the core facet: the harness object opens Durable on the same store, its data under the harness's own type
host.serve(Harness, (_, self) => {                     // local, empty params (P3)
  const harness = self.open(async (context) =>
    Harness.open(await StoreStorage.open(store, Harness.name, context), { models, registry, … }, context),
    (h, _reason, context) => h.close(context));
  const view = self.follow((observer, ctx) => harness.value.observeConversation(rootId, observer, ctx, { min: 50 }));
  return { view };
});

// a persisted job: survives a crash, a clean close and its object's retry
const ImportJob = defineJob("notes.import", {
  version: 1, args: obj({ path: str() }), result: obj({ count: int() }),
  state: ImportState /* persist: true, checkpointWhen */, persist: { resume: "rerun" },
});
const imports = self.job(ImportJob, { run, finish });
await imports.abort(id, ctx);                          // "marked" | "terminal", stored
await ctx.state.change((d) => { d.output = text; }, ctx, { persistence: { kind: "deferred" } });
```

## 1. Changes to 6a's store

Every item below changes 6a's code; nothing is deployed, so the schema and the archive format change in place.

### 1.1 Names and claims (decisions "R2", "owner names and claims")

- Tables are `"<owner>:<table>"` (`"notes.store:edits"`), document owners `"<owner>"`; no host kind. The applier and
  import check two name parts.
- **Claims** (owner, 2026-10-27, decision "owner names and claims", refined): what can collide is claimed once per
  store, in memory: a table by its SQL name, documents by `(owner, namespace)`. An object claims its tables and
  `(type, "chord")` (plus `chord.jobs` and `chord.job-states` with persisted jobs) when it declares them;
  `StoreStorage.open` claims its five tables and its document namespaces (Durable's scopes contain a `:`, Chord's
  namespaces never do). A second claim is refused `invalid/args`; a claim is released by its owner's end
  (`StoreStorage.close` after its calls underway drained, the object's end), so a new Session can reopen over the same
  store. So the object that opens Durable can declare its own persisted data under the same owner name, and two
  harnesses can share a store under two owner names.

### 1.2 One id allocator (D3)

- The store owns one synchronous allocator: `mintId()` takes the next id; the commit step takes its documents' ids from
  the same allocator when a creation applies (no copy in the `Step`, no overwrite after `COMMIT`); explicit ids in
  staged writes raise it at staging (`max`); a refused step leaves its ids unused (gaps, S10). Each commit persists
  the allocator's current value.
- It starts at 2 (id 1 is Durable's root conversation). It saturates at `Number.MAX_SAFE_INTEGER`: an explicit write of
  that id is accepted, the persisted value stays `MAX_SAFE_INTEGER`, every later `mintId` rejects "ID space is
  exhausted", and a Chord creation at the saturated allocator refuses its own commit (1.4).
- Each commit takes the allocator's value once, after its writes applied, for the outbox commit (`{ seq, nextId,
  writes }`) and the metadata row (mints meanwhile only raise it further); an export reads it once with `lastSeq`; the
  archive manifest's `nextDocumentId` is `nextId`; import and batch apply restore it, so a replica mints above every id
  it holds.

### 1.3 The commit step

- **A staged write returns the writes it recorded:** `StagedWrite.apply(step): Promise<readonly StoreWrite[]>`.
  `StoreStorage` stages one composite write per Durable commit (1.3 of section 2).
- **Order:** within the step, writes apply in the order staged, except that a staged write that frees a live address
  (a retirement of another incarnation) is applied before the creation at that address (rule 9's reason, the partial
  unique index); Chord's own staging keeps 6a's order. The outbox records the writes in applied order; the applier
  replays them in that order (no re-sort).
- **Stamps:** a staged write can take values only the step knows (`step.seq`): Durable's `entries.commit_seq`. The
  outbox records the resolved values.
- **Adopt in the owner's batch:** the host gives the store its batch when it attaches (`attach({ failed, batch })`);
  an adapter's fence runs its `adopt` in `batch.within(…)` (joins a running batch, opens one otherwise); Chord's own
  transactions keep their `batch.commit`. Without a host, `adopt` runs plain.

### 1.4 Errors: Durable's Storage semantics (D4)

- The step records the error its own code threw inside the transaction callback. A rejection of the backend
  transaction that is that very error is a **refusal**: the facade rolled back (a failed `ROLLBACK` reaches us as
  another error, an `AggregateError` on Node), the commit rejects, nothing is adopted, the allocator keeps its raised
  value, the store goes on. Any other rejection (`BEGIN`, `COMMIT`, `ROLLBACK`, a throwing `adopt`) is an unknown
  outcome: the store stops (`storage_failed`). The Cloudflare facade is checked to keep the same identity; a test
  injects failures at `BEGIN`, in the body, at `COMMIT` and at `ROLLBACK` on both drivers' facades.
- **The refusal's error reaches the owner unchanged** (Durable's suite matches its messages); the store classifies it
  for Chord's owners: an `int` `CHECK` failure (SQLite's extended code `SQLITE_CONSTRAINT_CHECK` on Node; the error
  message on the Durable Object facade, which has no extended codes) is `invalid/args` and
  fails only that transaction; every other refusal of a Chord commit (the engine's counted `UPDATE`/`DELETE`, the
  live-address index, a primary key, the saturated allocator, a backend error in a statement) fails the object live
  (`object_failed`, `broken`: memory and disk disagree).
- **6a's owners:** a refused `self.tx` rejects with the error above and the object fails as above; a refused
  migration commit (a chunk, (A) or (Z)) is rolled back whole, fails the activation `broken`, the table stays
  `migrating`, earlier committed chunks stay; a refused job start rejects the start; a refused outcome or finish commit fails the object (records and
  memory disagree); a refused commit that carried held changes (D8) fails the object.
- **Reads:** a read's callback returns data, never throws for a request: an adapter's request checks (an unknown
  conversation, a cursor, history a document does not keep) happen after the guarded read returned, from tagged
  results, so only a backend error fails the store. The store offers a read transaction for reads of several queries
  that must see one state (S4).

### 1.5 The documents engine

- **Addresses:** `(owner, namespace, kind, key?)`: `owner` the owner name; `namespace` the adapter's partition, claimed
  with the owner (Chord: `chord` for documents, `chord.jobs` and `chord.job-states` for persisted runs; Durable: the
  document's scope, `session`, `conversation:<id>`, `task:<id>`, which Durable's reads by scope need); `kind` and `key` as the adapter writes them (Durable JSON-encodes both,
  as its indexed strings). One live record per address (the partial unique index).
- **`history` per record (R1):** `none` (Chord: older revisions dropped at a new base; row and revisions deleted at
  retirement), `latest` (Durable's session, task and latest conversation documents: older revisions dropped; the row
  kept with `retired_at` at retirement), `rewindable` (nothing dropped; the row kept). `retireDocument` reads the record
  and applies its rule.
- **Explicit ids:** a creation may carry its id (Durable mints ahead); otherwise the allocator gives one.
- **Changes without a known revision:** an adapter whose writes carry no revision (Durable) stages a change that reads
  the record in the step and uses its revision; the counted conditional `UPDATE` stays the guard.
- **`meta`:** Durable's `fork` policy and `history` details live in the record's `meta`.
- **Reads at a point:** `find(address, at)`, `load(id, at)` (the base at or below `at` plus the deltas up to it, its
  version the base's), `list(owner, namespace, at, kind?, limit, after?)` by id, with the half-open lifetime
  (`createdAt <= at < retiredAt`); records carry `retiredAt`. New indexes (store schema version 2):
  `(owner, namespace, kind, key, created_at)`, `(owner, namespace, id)`, revisions `(document_id, kind, seq)`; their
  cost on Chord's commit gate is measured.

### 1.6 The archive and batch apply

- **Format 1 gains** (nothing deployed): `document.create` carries `history`, `retiredAt?` and `meta`; a
  `document.revision { id, seq, content }` (`content` a `DocumentContent`: `{ kind: "base", version, value }` or `{ kind:
  "delta", version, ops }`) part per kept revision, in seq order after its create; for
  live `none` and `latest` records only the current base and its deltas are exported (as 6a); a retired `latest` record
  is exported as its record alone (no base: its content was dropped at retirement); for `rewindable` every revision,
  retired records included. Import checks: revisions in seq order, a base first, `seq <= lastSeq`, lifetimes
  at one address never overlapping (a second live record is still refused), versions per revision; the `end` count
  includes revisions.
- **Batch apply** (`applyBatch(store, commits, ctx)`, internal): refused while any owner holds a claim on the store
  (an object or a `StoreStorage`: its memory would go stale) and run through the store's commit queue; `commits[0].seq` follows `lastSeq` (S5); one backend transaction for the batch, every write applied
  with its commit's seq, `lastSeq` and `nextId` set from the last commit; the applier handles every `StoreWrite` kind
  (`alter`, `dropIndex`, `update`/`updateWhere`/`delete`/`deleteWhere` with their recorded counts and versions,
  `document.change`, `document.retire`, `document.revision`), checked against the store's records (a trust boundary);
  a count that differs from the recorded one stops applying and marks the store diverged (S17): every later
  `applyBatch` rejects. A test replays a store's outbox into an empty store and compares the exports, manifest
  included.

## 2. `StoreStorage`: Durable's `Storage` on the store (D1, D2)

In Durable's `src` (an ordinary pi module), importing `@earendil-works/chord/next` (Chord's `./next` export comes
with it: the store and the adapter surface below, marked internal for adapters). It passes Durable's storage
conformance suite on SQLite `:memory:` and across reopen (a wrapper that closes and reopens the store file after
every commit, Durable's reopen harness), and Durable's Session and harness test files run on it.

### 2.1 Opening and the adapter surface

`StoreStorage.open(store, owner, ctx)`: claims `owner` (1.1); declares its tables through the store's table
preparation (the path `self.table` takes: created at the newest version or migrated); raises the allocator to
`max(record_ids.id) + 1`, saturating at `Number.MAX_SAFE_INTEGER` (one index read; covers stores built by import or
batch apply); attaches to the store's host
batch if there is one. Chord exports for it: `StoreOwnerTables` (declare and prepare tables under an owner),
staged table writes and engine writes, the step reader, the read transaction, `mintId`, the commit with a fence. Its
`close(context)` refuses new calls ("StoreStorage is closed"), waits for its calls underway, then releases its claims; the store stays open (the
app owns it).

### 2.2 Tables

Every row carries the record's indexed columns and the whole record as `json(unknown(), { version: 1 })`; indexed
strings that must stay lossless (`kind`, `request_id`) hold Durable's JSON encoding; index columns are non-`opt`, so
absent values take sentinels that no encoded value can be (`0` for an absent owner id, ids start at 2; `""` for an
absent request id, JSON-encoded strings start with `"`). SQLite's partial head index is the table `entry_heads`
(builder, 2026-10-27: an index on `(conversation_id, has_head, id)` cost about 5.5 µs per commit; the table is written
only for entries with a head and is faster on both paths).

| Table | Key | Columns | Indexes |
| --- | --- | --- | --- |
| `record_ids` | `id` | `record_type str` | |
| `conversations` | `id` | `owner_conversation_id int`, `owner_task_id int`, `record` | `(owner_conversation_id, id)`, `(owner_task_id, id)` |
| `entries` | `id` | `conversation_id int`, `commit_seq int` (stamped), `record` | `(conversation_id, id)` |
| `entry_heads` | `id` | `conversation_id int` (one row per entry with a `head`, written with it) | `(conversation_id, id)` |
| `tasks` | `id` | `conversation_id int`, `kind str`, `status str`, `abort_requested int`, `background int`, `record` | `(status, id)`, `(conversation_id, id)`, `(kind, id)`, `(abort_requested, id)`, `(background, id)` |
| `submissions` | `id` | `conversation_id int`, `request_id str`, `status str`, `record` | `(conversation_id, request_id)`, `(conversation_id, id)`, `(status, id)` |

### 2.3 Commits

`commit(writes, adopt, ctx)` stages one composite write and calls the store's commit with `{ admit: () => true,
adopt: (seq) => adopt(seq) }` (adopted in the host's batch, 1.3). Inside the step the composite write does what
`SqliteStorage` does inside its transaction, with the step's reader: `checkGlobalIds` (an id already claimed by
another record type, a conversation, entry or document written twice: Durable's messages), the per-document actions
of `prepareDocumentActions`/`checkDocumentActions` (one content command per document, a delta on its version, one live
incarnation per address: "already has a current incarnation"), then the table `put`s (`record_ids` only for ids not yet
claimed by the same type), then the documents in two passes: first every document that already exists (its content,
then its retirement), which frees the addresses a creation of this commit takes, then the creations and copies (each
with its retirement, a create-plus-retire being an empty lifetime, `createdAt = retiredAt = seq`). Durable's
"reconstructs rewindable documents" case (`create secondId` at address A, `retire firstId` at A, `change firstId`)
needs this order. Copies (`document.copy`) are resolved before
the step (S11): the source read at its point, checked against the copy's record ("changed in the copy batch",
kind, key, history, fork), entered as a creation carrying the base. A refused check rejects with Durable's message (a
refusal, 1.4): the store goes on, Durable's Session fails (`GuardedStorage`).

### 2.4 Reads

`conversation`, `entry` (both overloads, `commitSeq` from its column), `findLatestHeadMarker`, `scanEntries` (both
orders, the fork chain walked as `SqliteStorage` does), `task`, `scanTasks`, `submission`, `scanSubmissions`,
`submissionByRequest`, `scanConversations`: queries over the tables, Durable's cursors (`scan.ts`) as they are;
`findDocument`, `document` (one read transaction), `scanDocuments`: the engine's reads at a point (1.5). Request errors
(`StorageRequestError`) are thrown after the guarded read (1.4).

### 2.5 Cost

Statements per commit, as the gate measures them: an entry append, a `record_ids` check read, the `record_ids` put,
the entry put, the meta update (4; `SqliteStorage` 5); a document delta, the record read, the revision insert, the
counted update, the meta update (about 4-5; `SqliteStorage` about 7). Per `put` one compiled row check and the JSON
encoding of indexed strings.

## 3. `self.follow`: Durable's views as Chord sources (D9, R4)

`self.follow(attach)` in a factory returns a `Watchable` (a state member, a derive source, an `on` source);
`attach(observer, ctx)` returns `Promise<{ value, detach } | undefined>` (Durable's `Observation`; `undefined` for an
absent `observeDoc` address). In 6b it is used inside the object that opened Durable (a native's value); reaching
Durable from other objects is slice 8's (the harness in a registry entry, carry-over).

- **Activation:** after the natives opened, before the members are checked and derives compute: Chord makes the
  observer and calls `attach`; calls arriving before it resolves are queued and applied in order on `value`; a rejected
  or `undefined` attach fails the activation like a failed dependency (`transient`); a failed activation detaches
  what attached. The attempt's end detaches.
- **Calls:** a call inside a running batch (Durable's `adopt` on the store) applies the queued calls first, then marks
  the source in that batch; a call outside any batch (Durable's deferred commits, `#hold`, and the task graph's
  `blocked` refresh, even on the store; any Durable storage that is not the store) is queued and one batch on the next
  microtask applies everything queued. A derive over two views of one commit sees both changes in one computation.
- **Ends (R4):** `failed` fails the live object `transient` (reported once as `object_failed` with that failure, its
  identity's backoff, several sources ending at once fail it once; its retry reopens Durable and attaches again); `ended` is final:
  a pending retirement call reaches the source's watches first (Durable's `endAfterDelivery`), then they end `ended`;
  the member keeps its last value; a new `watch` on an ended follow source opens at that value and ends `ended` at once.

## 4. Persisted jobs (D5-D8, R3)

`persist: { resume: "rerun" | "abandon" }` only in `local` types with empty params (P3, at `self.job`); a persisted job
needs a state definition with `persist: true` and `checkpointWhen` if it has state, and a JSON-only result (no `bytes()`,
refused at declaration).

### 4.1 Records

Each unsettled run is a keyed persisted document in namespace `chord.jobs` (kind the job name, key the run id,
`history: none`); its state is a keyed persisted document in namespace `chord.job-states` (same kind and key), so two
jobs sharing a state definition never meet. The record:

```ts
{ version, fingerprint, args, key?, trace?,
  phase: "pending" | "running" | "stopped" | "finishing" | "blocked",
  restarts, finishFailures, abort?: true, blocked?: "finish_failed" | "version",
  outcome?: { kind: "done", result } | { kind: "failed", error: StoredJobError } }
// StoredJobError: { kind: "threw", error: WireError } | { kind: "aborted", reason } | { kind: "restart_limit", restarts }
```

Errors are stored in the wire error format (a `PluginError`'s code, message and details survive); a stored outcome is
rebuilt as the in-memory one.

### 4.2 Transitions

| Event | Writes (one commit unless noted) | After |
| --- | --- | --- |
| start | record `pending`, state `initial()` | invoked on the live attempt |
| reservation (before `run`) | record `running` | `run` invoked (a crash after it counts) |
| `ctx.state.change` | state; the record's `restarts: 0` only when it was not 0 | |
| abort (D7) | record `abort: true` (on the line); the signal fires after the commit, outside the batch; the line is released, then `abort` joins `run` | `"marked"` |
| `run` settles | held state flushed (D8), record `finishing` with the outcome | `finish` on the live attempt |
| `finish` fails | record `finishFailures + 1`; at 5 `blocked: "finish_failed"` | retried after the backoff, a blocked run on reload |
| `finish` succeeds | record deleted, state retired (Q9), with what `finish` wrote | the run settles |
| clean stop (host close, a native restart, R3's seal) | the stopped runs written `stopped`, held state flushed, by the close writer | |
| activation (records loaded once per object; each live attempt resumes what waits) | each `running` record: `restarts + 1` (or, at 5, `failed { restart_limit }` and `finishing`, `job_interrupted` reported); `stopped` and `pending`: back to `pending` | maps, keys, active count, `running` rebuilt before anything runs; `rerun` invokes, `abandon` records `failed { aborted, restart }`; an abort-marked run finishes `aborted` without `run`; `finishing` resumes `finish`; `blocked` stays; a record of another job version, or of the same version with another fingerprint, is `blocked: "version"` |

- **A retry after a seal (R3):** the runs the seal stopped are resumed by the next live attempt only once their old
  invocation settled (bounded by `closeTimeout`, as the drain; an invocation outliving it is fenced, its run resumes
  then), so a `run` that ignores its signal never runs twice at once.
- **The close writer:** at the object's end, after the drain and before the documents drop, one commit past the seal
  (Durable's `writeAtClose`): the runs stopped by the end written `stopped`, held state flushed; a run whose `run`
  outlived the drain is fenced and written `stopped` too; blocked persisted runs keep their records (dropped only by
  `abort`). In-memory runs keep 6a's rules.
- **Pinning:** records and state documents of unsettled runs stay in memory (never evicted): `ctx.state.value` and
  `running` read them synchronously.
- **Fingerprint:** the job's fingerprint (args, result, state) is stored; a mismatch is `blocked: "version"` (resolved
  by slice 7). A run ending at the limit reports `job_interrupted { object, job, id, restarts }` (a new `HostError`).

### 4.3 Deferred state (D8)

As Durable's holds: the slot adopts and publishes the change at once (`valueVersion` ahead of what is stored), keeps
the held ops in a `PendingOps` (a base flag when `checkpointWhen` selected one), and the run's documents stay pinned;
the next immediate change of the state document stores the held ops and its own as one delta on the stored revision
(or a base); one foreground timer per object for the earliest deadline (`withinMs`, default 1,000 ms, `Infinity` waits
for the others; a negative or non-number `withinMs` is `invalid/args`); the outcome's commit and the close writer
store what is held; a held change of a fenced invocation is still stored; a crash loses it. A deferred change that
would reset `restarts` is stored at once (the reset must be durable). On an in-memory job the option is accepted and
does nothing.

## 5. Benchmarks and tests

- **The gate** ("The performance and memory bar"): Durable's storage benchmark (`test/storage.bench.ts`, every read and
  write case, 1k and 10k) and `test/conversation-view-bench.ts` on `StoreStorage` against `SqliteStorage`, outbox off
  (its cost reported separately): each hot path within about 5%, allocation per op and retained memory no worse beyond
  noise; Chord's 6a commit gate again with the new indexes and the allocator; persisted job start and state change
  reported against in-memory ones (a disk commit is not held to the in-memory number).
- **Tests:** the conformance suite (both fixtures); the D4 matrix (`BEGIN`, body, `COMMIT`, `ROLLBACK` failures; a
  refused Durable commit keeps the store; a refused Chord commit fails its object; a `CHECK` failure only its
  transaction; a refused migration chunk; a request error inside a multi-query read keeps the store); the allocator (a
  mint during a running Chord step, saturation across reopen, a refused step's gap, replay restoring `nextId`);
  create-plus-retire and change-plus-retire through the outbox and the applier; reads at a point on retired `latest`
  and `rewindable` records; export and import of rewindable history and mixed Chord and Durable data; `applyBatch`
  (every kind, the replay equality, a diverged count); `self.follow` (one frame per commit, a derive over two views,
  calls outside a batch on the store, early calls, an absent `observeDoc`, `failed` and `ended`, a retirement before
  the end); persisted jobs (every transition of 4.2, a crash between reservation and `run`, a crash during the close
  writer, a seal and retry, restart counting and its reset, the limit, the finish failure count across a crash, abort
  joined and stored, abort racing an outcome, deferred state merged, flushed at the outcome and at close, pinned past
  the retention); GC (closed `StoreStorage`, ended follow sources, cancelled abort waiters, deferred timers, settled and
  dropped runs).
- **Examples:** Durable's `test/examples/35-durable-on-the-store.ts` (a worker with Durable's Session and a Chord store
  object on one store, exporting the archive) and `36-durable-views.ts` (Chord's tests import nothing of Durable);
  Chord's `28-persisted-jobs.ts`.

## Carry-over taken

From `slices.md` "Slice 6b": persisted jobs (all of it, the finish failure count included), `StoreStorage` (ids, fork
copies, `adopt` in the batch), the Chord source over Durable's views (`self.follow`), the applier for batch apply;
`job.abort` async and stored.

## Carry-over left

Slice 7: `blocked: "version"` resolved on reload; runs of jobs the code no longer declares; blocked runs retried on
reload. Slice 8: Durable's views from other objects (the harness in a registry entry). Slice 9: the trace carrier's
use.
