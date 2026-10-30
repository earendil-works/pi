# Slice 6a: the store (spec)

Status: **built** (2026-10-27: four build-review rounds and six fix rounds; later rules are in the decision log's
2026-10-27 entries and `design.md`, which win over this spec). Was: **ready to build** (2026-10-27; the second spec review decided by its majority, section 15), written by the redesign session after
the first spec review (`/tmp/s6a-review-{astra,fable,opus,sol}.md`) and the owner's decisions of 2026-10-26 and
2026-10-27, including the general-model discussion (facets, attempts, the seal fence, keyed members). Guiding rules
(owner): simple, fast, correct; Chord and Durable aligned as much as possible.

The single source for building 6a, together with: `design.md` read in full; the store book `store/book.md`; the
decision log `packages/chord/docs/next/decisions.md` (later entries win; superseded parts are marked), in particular "The
store", S1-S17, W1-W14, P2, P3, "Flat columns", "Query runner", "Index definitions are recorded", R8, R12-R15, D9, D10,
"Slice 6 first decisions", "One retirement mechanism", "Text is plain UTF-8, in code point order", and every entry of
2026-10-26 and 2026-10-27 from "The host's store and how it is opened" to "Slice 6a small items"; the feature map and
the carry-over of `slices.md` (slice 6a); the root `AGENTS.md` section "Chord v2 Code Style". Builds on slice 5
(`4a5b45c45`), the adaptation to the shared `watch.ts` (`cc2d61f53`) and pi `8025c414d` (`runCounted`).

6a builds the store and puts Chord's persisted data on it (tables, persisted documents, keyed state members), and
reworks three parts of the built slices that the store needs: facets only declare, objects own their documents, line
and job runs across attempts, and the seal fence. Durable on the store (`StoreStorage`), persisted jobs and
`durableView` are 6b. Sync is not a slice: the store keeps an optional outbox the sync layer will read.

**Words.** An **object** is one identity (type, params, principal key); an **attempt** is one try at activating it
(factory, references, natives, members, derives, routines). A **seq** numbers a commit, one counter per store;
**`lastSeq`** is the seq of the store's last commit. A **write** (`StoreWrite`) is one change of the store (`put`,
`update`, `updateWhere`, `table`, `index`, `document.create`, …); a **commit** in the outbox is the writes of one seq; a
**batch** is the commits `from..to` that sync ships; an **archive** is a manifest, the writes from 0 to `lastSeq` and an
`end`. A **line** serializes one object's transactions; the **commit queue** serializes only the store's commit step. A
**pin** keeps one key of a keyed document loaded.

## What an app can do after this slice

```ts
// the start code of a session's worker
const db = await openNodeSqliteDatabase(join(dir, "session.sqlite"));          // chord/sqlite/node
const store = await openStore(sqliteBackend(db), ctx, { outbox: false });       // omitted: keep the persisted setting
const worker = createHost<P>({ address: Session({ id }), principal, store, onError });
…
await worker.close(ctx);
await store.close();                                                            // the app owns the store

// contracts
const NoteSchema = obj({ title: str(), body: str(), author: str() });
export const NoteStore = local("notes.store", {
  version: 1, params: {},
  members: {
    notes: keyed(NoteSchema),                                                   // a keyed state member
    create: method(obj({ title: str() }), str()),
    rename: method(obj({ id: str(), title: str() })),
    remove: method(obj({ id: str() })),
  },
});
export const NoteView = remote("notes.view", {
  version: 1, params: { session: str(), id: str() },
  placement: ({ session }) => Session({ id: session }),
  variants: {
    editor: { state: { note: NoteSchema }, methods: { rename: method(obj({ title: str() })) } },
    reader: { state: { note: obj({ title: str(), body: str() }) } },
  },
});

// a plugin: the facet only declares
const Note = defineState("notes.note", {
  schema: NoteSchema, version: 1, initial: () => ({ title: "", body: "", author: "" }),
  keyed: true, persist: true, checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 64,
});
const Edits = defineTable("edits", {
  version: 1,
  columns: { id: str(), path: str(), at: int(), note: opt(str()), meta: json(EditMeta, { version: 1 }) },
  key: ["id"],
  indexes: { by_path: ["path", "at"] },
});

export default defineFacet((host) => {
  host.serve(NoteStore, (_, self) => {                     // local, empty params (P3): host lifetime
    const notes = self.state(Note);                        // persisted, keyed, evictable
    const edits = self.table(Edits);
    self.on(notes.at("pinned"), async ({ value, retired }, ctx) => { … });   // routines live in objects
    return {
      notes,
      create: async ({ title }, ctx) => {
        const id = uuidv7();
        await self.tx(async (tx) => {
          tx.put(edits, { id: uuidv7(), path: `notes/${id}`, at: Date.now(), meta });
          (await tx.draft(notes, id)).title = title;
        }, ctx);
        return id;
      },
      rename: ({ id, title }, ctx) => notes.change(id, (d) => { d.title = title; }, ctx),
      remove: ({ id }, ctx) => notes.retire(id, ctx),
    };
  });
  host.serve(NoteView, ({ id }, principal, self) => {      // a view with params: only in-memory state of its own
    const store = self.get(NoteStore, {});
    const note = store.notes.at(id);                       // pins key `id` while this view lives
    if (principal.kind === "owner") {
      return { variant: "editor", members: { note, rename: ({ title }, ctx) => store.rename({ id, title }, ctx) } };
    }
    return { variant: "reader", members: { note: self.derive([note], ([n]) => ({ title: n.title, body: n.body })) } };
  });
});

// a browser tab: an ordinary hold of the view
const view = await tab.get(NoteView, { session: "S1", id: "n-42" }, ctx);
const watch = await view.note.watch(ctx);
watch.start(async ({ value, retired }) => (retired ? showDeleted() : show(value)));

// tables
await self.tx(async (tx) => {
  const old = await tx.get(edits, { id });
  tx.update(edits, { id }, { note: "fix" });                                    // plain values
  tx.updateWhere(edits, (e) => prefix(e.path, "a/"), (e) => ({ path: replacePrefix(e.path, "a/", "b/") }));
}, ctx);
const page = await edits.page(query(Edits).where((e) => eq(e.path, p)).orderBy((e) => e.at, "desc"), 20, ctx);

// export and import
await pipeline(Readable.from(encodeJsonl(store.export(ctx))), createWriteStream(archivePath));
const copy = await importStore(sqliteBackend(otherDb), decodeJsonl(createReadStream(archivePath)), ctx);
```

## 1. Changes to the built slices

### 1.1 Facets only declare (decisions "Facet documents are removed", "Facets only declare")

A facet's setup declares only `host.serve` and `host.references` (`self.contribute` comes with slice 8). Removed:
`FacetSelf` (the setup takes `host` alone until slice 8), facet documents (`FacetSelf.state`), facet routines
(`FacetSelf.on`/`onLive`), the facet's `Documents` and line, the lock order across two lines, `Documents.facet`,
`Transaction.#facetLine`/`close()`, the facet hydration and routine start in `host.ts#setUp`, the facet drain in
`#close`, `ChordHost.#facets` beyond the names, and their tests (`facet.test.ts`, the facet cases of
`routines.test.ts` and `documents`/`transaction` tests, `support.ts` helpers). A facet cannot fail after `load` (a
throwing setup still rejects `load`, slice 2). A transaction covers only its own object.

### 1.2 Objects own documents, line and job runs (decisions "Documents and the line belong to the object", "Job runs belong to the object")

- **Slots and handles.** The object (`ChordObject`) holds one slot per declared document name (trackers, the stored
  version and fingerprint, pins) and the line. Each attempt's `self.state(def)` returns a thin handle bound to the
  attempt's seal token and the definition's version; old handles keep their token and version (R15: old code touching
  a slot migrated past its version throws, one integer comparison per read and draft). The same name with a higher
  version migrates on access (in memory too); the same version with another fingerprint is `broken`; a flipped
  `keyed` or `persist` is `broken`. "Declared twice" is checked per attempt.
- **Lifetime.** Slots live from the object's first activation to its end, across retries, failures and native
  restarts. `initial()` is taken once per slot (again when the declaring definition changes). In-memory slots the new
  factory no longer declares are dropped when the factory returns (never on a throwing factory); persisted ones drop
  their trackers only. Persisted singletons load once per object, keyed data once per residency, again after a failed
  load or a drop (section 15). In-memory state
  survives a failure and retry; ending the object clears it.
- **Job runs.** Per job name the object holds the records, keys, active count, `running`, run state documents and
  pending actions; the attempt holds the implementation (`run`, `finish`) and the running invocations (its drain, its
  seal). A run's state changes and its outcome are fenced by the run's own invocation; `finish` runs on the current live
  attempt (a finishing run waits for one); a run of a job the new code no longer declares stays `blocked`; a run
  waiting for a live attempt keeps its object alive only while an attempt is live or activating. `Job.seal` fires
  signals only; waiters reject at the object's end.
- **Derives and watches.** Derives detach with their attempt and the next attempt's derives attach to the same slots.
  Routine watches end by their attempt's ctx cancellation, never by a slot drop. Local references re-bind every state
  member by name when the object's new attempt goes live, as a remote reference re-holds and gets a fresh snapshot:
  their member watches go on across attempts (documents and derives alike; one frame from the last value), and a
  consumer's derive over a member recomputes from the new attempt's member. While the object is failed or activating
  again, the members keep their last values and get no frames; the builder states this in one rule in `members.ts`.
  Keys a reference holds on a keyed member (`at(key)`, `watch(key)`) follow the object's attempts the same way (fix
  round 3). A failed derive heals on every later change of its sources and on a re-bind; failures reach watches as
  `failed` calls (decision "Failures are watch calls", fix round 4).

### 1.3 The seal fence (decision "The seal fence")

- **Tokens.** Every attempt has a seal token; every job run invocation its own (for `ctx.state.change` and its
  outcome).
- **At use:** after the seal, new work through the attempt's handles is refused with `released`: `self.tx`, `ctx.get`
  (it checks the call's abort signal first, before anything is created), a job start, a routine start. The attempt's
  references stay usable for its own natives' closes, then are released.
- **At commit:** a commit is checked when it enters the store's commit step (sealed: rejected `released`, nothing
  written, not a storage failure) and at adopt (admitted while current, sealed during the SQL: durable, adopted into
  the object's slots, its staged job changes adopted into the object, their invocations deferred to the next live
  attempt; the handler's `self.tx` resolves with `fn`'s result, Durable's rule). In-memory commits are checked inside
  the batch. The store gets the check through its interface: `store.commit(writes, { admit, adopt }, ctx)` (section 15).
- **The line:** at the seal, a transaction of the attempt that has not entered the step yet is aborted and the line
  released; a step already started finishes before the attempt's teardown completes.
- **Cleanup still runs** after the seal: `ctx.get` references of stuck calls released at teardown, presence entries,
  `host.activity` counts. The existing start guards stay (`ChordObject.#run`'s attempt identity, `Job.#invoke`, a
  `ctx.get` resolving after its call settled).
- **Not a replacement:** a pure swap (slice 7) keeps the attempt. Natives' effects outside Chord are the plugin's;
  their `close` is honoured.

### 1.4 A live object can fail (decision "A live object can fail")

A runtime failure of the owner (a `migrate` failing on access, a stored version newer than the code) seals the live
attempt and makes the object `failed` with a `broken` cause: calls reject at once with the cause (the triggering call
too), state members keep their last values (same-host reads return them) and get no frames after the commits already
admitted to the step (those adopt and publish once), natives close, slots stay; `onError` gets `object_failed { object, cause }`
once; recovery by reload or `ref.retry()` (a new attempt; only the failed load is redone). Live dependents stay live;
their calls into it fail.

### 1.5 Smaller changes

- `ctx.get` checks the call's abort signal first (an ended handler creates nothing).
- **Names** (decision "Restricted names instead of assigned table names"): object type names and host kind names use
  `[a-z0-9@/._~-]+`, lowercase, checked at declaration (`contracts/declare.ts`, `host-kind.ts`); `hostKind("client")`
  is refused.
- **Errors:** a new `HostError` kinds `storage_failed { error }` and `object_failed { object, cause }`; a new reason
  `unavailable/storage_failed` in the protocol's reason list (the test pinning the list changes; `PROTOCOL_VERSION`
  stays 1 until p3 ships).
- **Keyed handles** take a context: `get(key, ctx)`, `keys(ctx)` (code point order, in memory too), `watch(key, ctx)`
  (decision "Slice 6a's three code questions").
- **`retired` on the wire and in sources** (decision "One retirement mechanism"): `Source.advance` takes `retired`;
  `Subscriber.next` gets it; `Singleton.remove` sends `{ value: initial(), ops: [["r", initial()]], retired: true }`;
  a `state` entry lists retired members (`retired: [index]`), kept by the hold while its window is full (ORed until a
  message carries it, as `#failed`), validated as member indexes; a derive over a retired source carries the flag on;
  a `bound` snapshot carries no flag.

## 2. The store

- **Opening:** `openStore(backend, ctx, { outbox? })` with `sqliteBackend(db)` over any `SqliteDatabase` (Node through
  `chord/sqlite/node`, Durable Objects through `chord/sqlite/cloudflare`, sqlite-wasm later). There is no hand-written
  memory backend: tests use SQLite `:memory:` through `chord/sqlite/node`. The backend interface is internal; `src/next`
  imports no Node module. No `openNodeStore` shortcut.
- `openStore` runs the store's own schema migrations (`applySqliteMigrations`), checks that the file uses the UTF-8
  encoding, and reads the metadata once: `lastSeq`, the outbox setting, the table definitions (version, state, columns
  with `json(...)` versions and fingerprints, index definitions) and the document id counter (S10); in memory from then
  on (one writer per store), persisted with every commit that changes them (S9). In-memory metadata changes only after
  `COMMIT` returned.
- **Lifetime:** the app owns the store; the host never closes it (6b's Durable Session shares it). `store.close()` (no
  context, as Durable's `Storage.close()`) waits for a running step, rejects queued commits, running exports and reads
  with `released`, closes the backend; idempotent, also after `storage_failed`. A host without a store fails an object
  declaring persisted data at activation (`broken`, "persist needs a store").
- **`storage_failed` reaches the host** through an internal listener the store calls once; the host reports
  `{ kind: "storage_failed", error }` once and closes itself.
- **The outbox** (decisions "The outbox is optional, internal and versioned", small items 3-4): opened with
  `{ outbox: true }`, off with `{ outbox: false }`, an omitted option keeps the persisted setting (new stores: off).
  Turning it on records "outbox from seq N+1"; turning it off drops its commits. A table `outbox(seq, format, writes)`
  in the backend, written in the step's transaction; `store.outbox` is `undefined` without an outbox (typed). The store
  persists a floor (N when turned on at N, advanced by `trim`): `store.outbox.read(afterSeq, limit, ctx)` returns
  `{ seq, writes }[]` in the current `format` (older ones stepped forward, a newer one refused with the data intact) for
  `floor <= afterSeq <= lastSeq` and rejects any other `afterSeq` (`invalid/args`); `store.outbox.trim(throughSeq,
  ctx)` is idempotent, rejects beyond `lastSeq`, takes no seq and runs outside the commit queue (serialized by the
  backend). No pluggable encoding.

## 3. The commit step

- **One commit queue per store** serializes the step only; each object keeps its own line for the whole transaction.
- **A step:** the seal-fence check; `BEGIN`; the writes (rows, revisions, the outbox commit when there is an outbox,
  the new `lastSeq`); `COMMIT`; then the owner's `adopt(seq, ids)` in one `host.batch.commit(...)` (W1), so every source
  the commit touched is marked in the step and the flush right after sends one message per link. The next step starts
  only after `adopt` returned (S1). Document ids are assigned in the step (monotonic with seq) and passed to `adopt`.
- **Interface** (internal, Durable's shape): `store.commit(writes, adopt, ctx): Promise<number>`.
- **seq:** one counter per store, strictly increasing; an empty commit takes none.
- **Errors** (decision "Store errors: Durable's rule"): any backend error in a step is `storage_failed`: the store
  stops, every later commit and read rejects `unavailable/storage_failed`, the host closes. Plugin mistakes are refused
  when a write is staged (`invalid/args`) and never reach the step. A seal-fenced commit is rejected `released` before
  `BEGIN`. A backend error on a read is `storage_failed` unless the read's `ctx` was aborted (`aborted`); invalid
  arguments (a foreign cursor, a bad key) are checked before the backend (`invalid/args`). An `adopt` that throws is
  `storage_failed`. Accepted: integer overflow past 2^63 in a bulk `add` is fatal.
- **Counts** through `chord/sqlite`'s `runCounted` (pi `8025c414d`), only where a count matters: bulk writes, the
  engine's conditional `UPDATE`, single `update`/`delete`.
- **Statements per commit:** a delta commit of one document is about three statements (revision, the record's
  `UPDATE … WHERE id = ? AND version = ?` counted, `lastSeq`), plus one `INSERT` with an outbox, plus one `DELETE` on a
  checkpoint (pruning).
- **In-memory commits** never enter the queue and take no seq: a transaction with only in-memory writes commits
  synchronously in a batch of its own (no extra await, no promise; a flag set at the first persisted write, no scan).

## 4. Transactions (decision "A Chord transaction enters the commit step as Durable's does")

```
take the object's line
  -> run fn (only await tx.*)
  -> abort or error: discard everything, reject
  -> prepare every draft; checkpointWhen picks base or delta per persisted document
  -> nothing persisted written: batch.commit(adopt) synchronously (W12)
  -> otherwise: await store.commit(writes, adopt, ctx without its abort signal)
       queue; seal check; BEGIN; revisions, rows, outbox, lastSeq; COMMIT
       adopt(seq, ids) = host.batch.commit(() => { persisted slots; in-memory slots; staged changes })
-> release the line; settle the staged changes; drafts revoked (R12)
```

- The line is held until the step returned; once admitted, a commit runs to its end (the caller's abort no longer
  counts); the in-memory part is adopted inside the same step (P2).
- **Cold keyed loads** (decision "Cold keyed loads on the line"): a cold `get`, `watch` or pin of a keyed document is a
  job on the object's line, as Durable's `snapshot`; cached reads take no line; `tx.draft` loads inside its
  transaction; one load in flight per key, shared, each caller's `ctx` ending only its own wait; a load installs its
  tracker only while the key is still absent. `tx.retire(handle, key)` of an unloaded keyed persisted document finds it
  inside the transaction (one read; absent: a no-op, R13).
- **A migrated base** is written back by the next commit that changes the document; until then a load migrates again
  (once per object).

## 5. Tables

- `defineTable(name, { version, columns, key, indexes? })` (later versions through `evolveTable`, section 9). `columns` is a flat record of L1's helpers as
  a restricted subset: `str()`, `int()`, `bool()`, `num()`, `opt(...)` of those, and `json(schema, { version,
  migrate? })`; defaults as `int({ default: 0 })`; no nesting outside `json(...)` (types and declaration). Keys, index
  columns and `orderBy` columns are non-`opt` `str` or `int` columns. Every index ends with the primary key.
- `self.table(Def)` only in the factory of a `local` type with empty params (P3; type error and declaration error),
  once per table name per object.
- **Names** (decision "Restricted names"): table names `[a-z0-9@/._~-]+`, lowercase; the SQL table name is
  `"<host kind>:<object type>:<table>"` (a host without an address uses `client`); `:` cannot occur in the parts, so
  the rendering is injective. Index names `[a-z0-9_]+`, rendered `<table>:<index>`. Column names
  `[A-Za-z_][A-Za-z0-9_]*`, no two equal ignoring ASCII case, no `$`.
- **Layout** (S16): a real SQLite table per logical table (`STRICT`, `WITHOUT ROWID`, the declared key as primary
  key), one column per declared column; a `json(...)` column is `TEXT` plus a hidden integer `<column>$v`; a hidden
  integer `$v` per row (eager steps applied). The store renders the DDL and records each definition as a `table` write
  (columns with types, `opt`, defaults, `json(...)` versions and fingerprints, key, version, state).
- **Text** ("Text is plain UTF-8, in code point order"): `str()` is plain UTF-8 `TEXT` compared by code point; written
  values and every operand go through `toWellFormed()` (check `isWellFormed()` first; copy only when needed); NUL fails
  `invalid/args`; `compareText(a, b)` exported; a prefix's upper bound is the next code point after its last, carrying
  past U+10FFFF (an all-U+10FFFF prefix has no upper bound; the empty prefix matches every value); `substr` offsets
  count code points.
- **Values at write:** `int` a safe integer, `num` finite, `bool` stored 0/1 and read back as `boolean`, `str` as
  above; a row has every non-`opt` column and no other field; one compiled closed check per table (a plugin's row is a
  trust boundary); `json(...)` values are not walked (R9).
- **Nullable columns** (decision "Nullable columns and the `set` form"): an `opt(...)` column is an optional field,
  absent when `NULL`, never an explicit `null`; SQL's `NULL` rules apply to every comparison.

## 6. Queries and reads

- `query(Table)` is immutable data: `.where((t) => …)` with `eq ne lt lte gt gte inArray isNull prefix and or not` over
  scalar columns, `.orderBy((t) => t.col, "asc" | "desc")` (several, one direction per query in 6a); no joins,
  grouping or projections (S12). The default order is the key ascending; the key is appended to every `orderBy` as
  the tie-break.
- **SQL** is generated from the query data; values always bound, identifiers quoted; `limit` and cursor values bound,
  `inArray` one JSON parameter through `json_each` (no 32,766-parameter limit; `inArray([])` matches nothing). Query
  shapes are unbounded (any `and`/`or` tree), so the facade's prepared-statement cache is bounded (pi change, a fixed
  LRU in `chord/sqlite/node`, section 15).
- **Outside a transaction** the handle reads committed state: `page(q, limit, ctx, { after? })` → `{ items, next? }`,
  `rows(q, ctx)` (all pages), `get(key, ctx)`, `count(q, ctx)`. A key is an object with exactly the key columns
  (`{ id }`, `{ path, entry }`); other or missing fields fail `invalid/args`. A query for another table is refused.
- **Cursors** are opaque strings bound to table, order columns and direction; decoding one is a trust boundary
  (`invalid/args`).
- **Inside `self.tx`**: the table handle first (another object's is refused); reads async: `tx.page(table, q, limit,
  { after? })` and `tx.rows(table, q)` read committed rows, stable for the transaction; `tx.get(table, key)` overlays
  the transaction's own `put`/`update`/`delete` (one evaluator for `where` and `set`, also used for the overlay);
  after an `updateWhere`/`deleteWhere` on a table, `tx.get` on it throws `invalid/read_after_bulk` (W10).

## 7. Writes

- Five writes (S17), synchronous and buffered like a draft's ops (checked and staged, no I/O, no line; a bad row
  throws at its own call; the buffer is written in the step or dropped): `tx.put(table, row)` (an upsert: the whole row
  replaced), `tx.update(table, key, set)`, `tx.delete(table, key)`, `tx.updateWhere(table, where, set)`,
  `tx.deleteWhere(table, where)`. No write shorthands on the handle. An `update`/`delete` of an absent key changes
  nothing.
- **`set`** is a plain object of values or a callback with typed column references: `{ note: "fix" }`,
  `(e) => ({ hits: add(e.hits, 1), path: replacePrefix(e.path, from, to) })`; `undefined` clears an `opt` column.
  Expressions over real columns only: `add sub max min concat replacePrefix coalesce when` (`when(cond, a, b)` with
  `cond` a `where` expression over the row); integer arithmetic only; every right side is evaluated against the row
  before the write (`{ a: e.b, b: e.a }` swaps); `replacePrefix` on a value without the prefix leaves it unchanged.
- **Writes in the outbox commit** carry what a replica needs, explicitly (decision "Writes carry their versions"):
  `put` with the row, `v` and each `json(...)` column's version; `update` with its `set` and `count`; `delete` with the
  key and `count`; `updateWhere`/`deleteWhere` with `where`, `set` and `count` (a replica affecting another count stops
  applying, S17).
- `$v` is written only by eager migration steps (an internal write form) and by `put` (the table's version); `update`,
  `updateWhere`, `deleteWhere` never touch it; a write of a `json(...)` column stores its current version (W11).

## 8. The documents engine

- One engine (S13). Address `(namespace, owner, kind, key)`; Chord's: namespace `chord`, owner
  `<host kind>:<object type>` (W7; `client` without an address), kind the definition's name, key the keyed document's
  key or `""` for a singleton (so the partial unique index on the live address also refuses two live singletons). Owner,
  kind, key and `meta` strings follow the `str()` rules.
- A record per incarnation (`id`, address, `history: "latest" | "rewindable"`, `createdAt` (a seq), `retiredAt?`, `meta`,
  `revision`); revisions: a base (version, fingerprint, value) and deltas (ops). Chord uses `history: "latest"` (a new
  base and a retirement prune older revisions).
- Reads: `find(address)`, `load(id)` (base plus deltas applied once: value, version, fingerprint, `deltasSinceBase`),
  `list(query, limit, cursor)` by key. Reads at an older seq (`at`) and `history: "rewindable"` are 6b.
- Writes inside the step: `document.create`, `document.change`, `document.retire`, checked by the writes (one live per
  address by a partial unique index; a delta only on its record's current version through the counted conditional
  `UPDATE`; nothing after retirement); a failed check is `storage_failed` (memory and disk disagree).

## 9. Migrations

- **`json(schema, { version, migrate? })` columns** ("The `json(...)` column helper"): a read of an older value runs
  `migrate` and checks the result once (R8); a read never writes back; without `migrate`, a throwing one or an invalid
  result the read is refused and the owner fails (section 1.4); a newer stored version is refused the same way; at
  activation, the same version with another fingerprint fails the object `broken` (D9).
- **Eager migrations: `evolveTable`** (decision "Second spec review: the majority"; all four reviewers accept it; the
  derived adds and drops are withdrawn: a store at v1 cannot reconstruct v2's columns from v3's declaration):

  ```ts
  const EditsV1 = defineTable("edits", { version: 1, columns: { id: str(), file: str(), at: int() }, key: ["id"] });
  const EditsV2 = evolveTable(EditsV1, (t) =>
    t.rename("file", "path").add("dir", str({ default: "" })).rows((row) => ({ dir: dirname(row.path) })));
  const EditsV3 = evolveTable(EditsV2, (t) => t.drop("dir").index("by_path", ["path", "at"]));
  host.serve(FileHistoryStore, (_, self) => { const edits = self.table(EditsV3); … });
  ```

  - **History.** `defineTable(name, { version, columns, key, indexes? })` is a base written in full (no `migrations`
    option); `evolveTable(prev, (t) => t…)` appends `prev.version + 1` (contracts' `Increment<N>`) and its edit returns
    the editor it was given (contracts' rule, checked). Every version is materialized and fingerprinted at
    declaration (`TABLE_FORM_VERSION`, its own form version: table fingerprints are persisted, not sent). The object
    serves the newest. A new base (`defineTable(name, { version: 7, … })`) starts a new history; stores below it fail
    `broken`.
  - **Edits:** `rename(from, to)` (key, index and hidden `<column>$v` references follow), `add(name, column)` (`opt(...)`
    or with a `default`), `drop(name)` (its indexes are dropped first in the same commit; a key column cannot be
    dropped), `index(name, columns)`, `dropIndex(name)`, `json(name, json(schema, { version, migrate? }))` (a
    `json(...)` column's version change: no DDL, no data step, cells still migrate on access; every change of a table
    definition is a table version), and at most one data step: `rows(fn)` or `update({ where?, set })`. No key or
    column-type changes (`rebuild`, carry-over). The editor's types enforce the order: `rename`/`add`/`json` before the
    data step, `drop`/`index`/`dropIndex` after it; the data step's row type is the columns at that point of the chain,
    so a step may read a column its version drops and fill one its version adds.
  - **Commits per version N:** (A) the edits before the data step as DDL plus `table { version: N, state: "migrating" }`,
    one commit; the data step's chunks; (Z) the last chunk (or the `update`) with the edits after the step, their index
    changes and `state: "ready"`, one commit. No data step: (A) and (Z) are one commit. Recorded writes: `alter
    { table, version, edit }` per column edit (`rename | add | drop | json`), `index`/`dropIndex`, `table { version,
    state, columns, key, fingerprint }`; the applier renders DDL from them. Resume at `version N, migrating`: (A) is
    done; the step continues; then (Z); N+1 starts only after N is `ready`.
  - **Data steps:** `rows` is synchronous and pure; it gets that version's typed row (`json(...)` cells migrated on
    access to that version's column versions) and returns a patch of non-key columns (`{}` stamps `$v` only; a key or
    unknown column fails `broken`); chunks of 100 in key order, paging forward by the last processed key (a crash
    restarts the scan, skipping rows with `$v >= N`); the patch plus `$v = N` written through an internal write form.
    `update` is one `updateWhere` with `and(where, lt($v, N))` stamping `$v = N`, `ready` in the same commit, so a
    non-idempotent `set` never applies twice. A throwing `rows` fails the owning object `broken`, the table stays
    `migrating`, committed chunks stay. Data functions are immutable once deployed (the guide).
  - **Activation:** a recorded version newer than the code's newest, older than the code's base, or the same version
    with another fingerprint (a history edited in place) fails `broken`; `self.table` of an older version than the
    recorded one fails `broken`. A fresh table is created directly at the newest version (`ready`, `$v` = newest), with
    its indexes, no replay.
  - **Shared with contracts:** `hash64`, L1's `snapshotSchema` normal form per column, `Increment<N>` and the "returns
    the editor it was given" check move into one shared module; the table history is its own concept
    (`store/table-history.ts`, `store/table-evolve.ts`), not contracts' `Draft`, `Editor` or `checkAccepts`.
- **Where and when:** at the owning object's activation, after its persisted documents loaded and before its
  references are bound, on the store that owns the data (a replica never migrates). The attempt's `readyTimeout`
  deadline is paused while eager migration work runs and resumed with its remaining budget (one pause scope over the
  table checks, (A) and (Z) commits, data chunks and their waits in the commit queue; resumed in a `finally`); the attempt's abort is checked between chunks (a chunk admitted to the step completes); the migration
  yields to the event loop between chunks; the start barrier waits for host-lifetime objects' migrations. Getters and
  parked calls keep their own deadlines.
- Old code meeting a newer table version or a newer `json(...)` version fails the object `broken`, data intact.

## 10. Persisted documents

- `defineState(name, { …, persist: true, checkpointWhen })`: `checkpointWhen(value, ops, info)` required for persisted
  documents (a type-level constraint), called once per commit per changed document; creation and version transitions
  always store a base. The fingerprint is L1's structural fingerprint of the schema, computed once.
- Only in `local` types with empty params (P3).
- **Loading at activation:** once per object, right after the first factory, every persisted singleton and every
  pinned `at(key)` with plain reads (the object holds its line; no read transaction): find, load, the fingerprint
  check, `migrate` with its result checked once (R8); an absent document reads `initial()` (Q11). A storage error is
  `storage_failed`; a fingerprint mismatch, a throwing `migrate` or an invalid result fail the object `broken`.
- **Keyed persisted documents** load on demand (section 4): `get(key, ctx)` (`undefined` when absent), `keys(ctx)`
  (pages from the engine in code point order), `watch(key, ctx)` (`undefined` when absent), `tx.draft(handle, key)`.
- **Pins and eviction:** each loaded key counts its pins: an `at(key)` declared by the current attempt's factory, a
  keyed member's `at(key)` of a consumer while it lives, each watch, each load in flight. A key with no pins not read or
  written for 10 minutes leaves memory (one owner-level timer and idle structure, no timer per key; eviction runs on the
  object's line). Persisted singletons stay in memory while the object lives (`handle.value` is a synchronous read).

## 11. Keyed watches, `at(key)` and retirement

- Every document, in memory or persisted, is watchable; a watch follows the address:
  - a singleton's retirement is one call `{ value: initial(), ops: [["r", initial()]], retired: true }`; it reads
    `initial()` meanwhile; a later write is an ordinary change;
  - `await handle.watch(key, ctx)` is `undefined` when absent; a retirement is the same call and the watch goes on; a
    later write delivers the new incarnation as `[["r", value]]` (a retire and recreate in one transaction: one call
    with `retired: true` and the new value);
  - watches end `ended` with their object.
- **`handle.at(key)`** in the factory: a view of the keyed handle's slot for that key (the same tracker, the same draft
  in a transaction: never a second document), pinned while the declaring attempt lives, `initial()` while absent; a
  state member, a derive source, an `on` source.

## 12. Keyed state members (decision "Keyed state members, `local` contracts only")

- `keyed(schema)` is a third member kind (`MemberKind` `"keyed"`), part of the fingerprint (normal form updated), only
  in `local` contracts (`remote()` refuses it at the type level and at declaration).
- **Provider:** returns a keyed document handle for it (in memory or persisted), or re-exposes another reference's
  keyed member; checked at activation as state members are.
- **Consumer on the same host:** `ref.member.at(key)` only in its factory (a `Watchable<T>`: a pin on the provider's
  per-key source while the consumer's attempt lives; loaded before the consumer goes live; `initial()` while absent;
  the `retired` flag on retirement); `ref.member.get(key, ctx)` and `ref.member.watch(key, ctx)` anywhere (`watch` on an
  absent key gives `undefined`).
- **Hydration:** `host.get` of a consumer waits for its declared `at(key)` sources like any state member's value; keys
  read dynamically are not part of hydration.
- A key whose `migrate` fails fails its owning object `broken` (section 1.4), never the store. Versions of keyed members map per key in slice 7.
- Nothing on the wire changes: across links a view per entity is held as an ordinary remote object.

## 13. Export and import (decisions "Export archives are operations", "Writes carry their versions; archives are lossless", small items 6-7)

- `store.export(ctx)` yields `AsyncIterable<ArchivePart>`: the state after its `lastSeq` as writes, lossless: a
  manifest `{ kind: "manifest", format: 1, lastSeq, schema }`; per table its `table` write (with `state`), its `put`s
  (stored values and versions) and its `index` writes; the `document.create`s (stored version and fingerprint; for
  `latest` the current value as the base); an `end` with the counts. Retired `latest` records, blobs, the outbox and
  sync state are not in it; tables of plugins that are not loaded travel along.

  ```
  {"kind":"manifest","format":1,"lastSeq":4812,"schema":1}
  {"kind":"table","table":"session:file-history.store:edits","version":4,"state":"ready","columns":{…},"key":["id"]}
  {"kind":"put","table":"session:file-history.store:edits","row":{…},"v":4,"columns":{"meta":1}}
  {"kind":"index","table":"session:file-history.store:edits","name":"by_path","columns":["path","at"]}
  {"kind":"document.create","record":{…},"base":{…}}
  {"kind":"end","writes":10061}
  ```

- It takes the commit queue at its first `next()` and holds it until the iteration ends, throws, is closed
  (`return()`) or `ctx` aborts (an abort listener releases it even while the consumer is suspended; a later `next()`
  rejects `aborted`); it reads page by page with plain reads (no long read transaction). The guide: export to a local
  file, then upload.
- `importStore(backend, parts, ctx, { outbox? })` is a trust boundary: every part checked against one compiled
  `ArchivePart` schema, every name against the name rules, every row against its table's recorded columns, the order
  above and the `end` counts; it refuses a non-empty backend (one with the store's tables) and parts after `end`;
  applies everything in one backend transaction with the replica's applier (one code path for import, bootstrap and
  batch apply) and returns the store at the manifest's `lastSeq`, its outbox (if asked) starting after it.
- The encoding is pluggable: the store yields and takes parts; it ships plain JSONL (`encodeJsonl(parts):
  AsyncIterable<Uint8Array>`, `decodeJsonl(bytes: AsyncIterable<Uint8Array>)`).

## 14. Benchmarks and tests

- **Benchmarks** (`test/next/bench/store.ts`, results in `benchmarks.md`), the gate (decision "The commit-step
  benchmark"): the store without outbox no slower than Durable's `SqliteStorage` per commit on (a) one document delta,
  (b) one table `put` (against `SqliteStorage`'s entry append), (c) 1,000 commits back to back, with and without a
  watched document; bursts (median and p95 over several runs), memory after GC, the same pragmas and file system. The
  outbox's extra cost reported separately; also query pages, a 10k-row `updateWhere` (its step time: bulk writes block
  every owner's commits), text per row, a migration chunk. A failed gate goes to the owner before the build continues.
- **Cost guards** (in-memory telemetry adapter): validations (`migrate` results), materializations (document loads),
  store commits and statements per commit; none on the in-memory-only path; a cached keyed `get` touches no SQLite.
- **Tests,** one `describe` per mechanism: facets that only declare; slots, handles and job runs on the object across
  retries, failures and native restarts (R15 through old handles); the seal fence (sealed handles, both commit checks,
  a queued commit of a sealed attempt rejected, an admitted one adopted into the object, the line released, cleanup);
  a live object failing; the commit step (order, adoption inside the step, errors, `storage_failed` once, reads after
  the stop); transactions (the line across the step, no abort once admitted, the in-memory part in the same step,
  in-memory-only commits without a step); cold keyed loads on the line (a cold `get` racing a draft of the same key, a
  cancelled waiter); the outbox (on, off, omitted, switching, `read` gaps, `trim`, `format`); tables (declaration and
  name checks, DDL, P3 errors, values, text, nullable columns); queries (every operator, `NULL` rules, order and
  tie-breaks, cursors, keys as objects, reads inside and outside transactions, W10, bounded SQL texts); writes (all
  five, `set` forms, the swap, upserts, counts, their outbox writes); migrations (`json(...)` on access, fingerprints,
  eager steps, chunks, resume, indexes, the paused deadline with a fake clock, a timer firing during a long migration);
  the documents engine (rules, ids, pruning, the singleton address); persisted documents (load once per object,
  fingerprints, `migrate`, keyed `get`/`keys`/eviction and pins, checkpoints, the migrated base written back);
  retirement (singleton, keyed, `at(key)`, `self.on`, derives carrying the flag, the wire with a full window); keyed
  state members (pins, hydration, retirement, two consumers of one key); export and import (round trips with old
  versions, mid-migration and uncheckpointed deltas, every refusal, the queue released on abort while suspended); GC
  (evicted documents, unpinned keys, ended objects, stopped watches, export iterators closed early, abort listeners).
  Examples: `20-tables.ts`, `21-persisted-documents.ts`, `22-migrations.ts`, `23-keyed-watches.ts`,
  `24-keyed-members.ts`, `25-export-import.ts`.

## 15. Rules from the second spec review (decision "Second spec review: the majority")

The owner delegated the second review's findings to the reviewers' majority (`/tmp/s6a-review2-{astra,fable,opus,sol}.md`;
a point raised by one reviewer only takes that reviewer's recommendation). These rules complete the sections above;
where a section above says otherwise, this section wins.

**Objects, attempts and the fence**
1. **Slot versions:** a slot keeps `valueVersion` (the version of its value in memory, the handle fence, R15) and
   `storedVersion` (the version on disk, for write preparation), with their fingerprints, as Durable's
   `LoadedDocument`. An old handle whose version is below the slot's fails that access, not the owner; a stored version
   newer than the current definition fails the owner (1.4). 6a builds the version comparison and the in-memory
   `migrate` (tested through a retry whose factory declares a newer definition); slice 7 wires it to reload.
   `initial()` is retaken when the declaring definition's version or fingerprint changes, not on every attempt.
2. **The store's admission check:** `store.commit(writes, { admit, adopt }, ctx)` (internal): `admit()` is called at
   the step's entry (false: the store rejects `released` and drops the entry, never writes it); `adopt(seq, ids)`
   after `COMMIT`, `ids` mapping the commit's `document.create` writes by index to their ids. 6b's `StoreStorage`
   passes `admit: () => true`.
3. **A transaction at the seal** is discarded: drafts aborted, every later `tx.*` throws `released`, a callback that
   returns afterwards is rejected `released` without a commit, and the line is released. As Durable's `Transaction`,
   it tracks its pending async `tx.*` operations and refuses a callback that settles with one still pending.
4. **Sealed handles** may still read synchronously (`.value`, cached keyed reads); anything taking the line (`change`,
   `retire`, a cold `get`/`watch`/`keys`) is refused `released`. A live failure of an already sealed attempt is ignored.
5. **Jobs at the seal:** staged changes of an admitted commit are adopted into the object (section 1.3). A run cut off
   by its attempt's seal ends `failed { aborted, reason: "restart" }` (design §15's reason, now also "the attempt
   ended while the object continues"); its outcome transaction runs on the object's line fenced by the run's own token
   (a transaction path owned by the object, not an attempt). A `finish` sealed mid-way is refused at the step and
   retried on the next live attempt, not counted as one of the five failures. A run's state-change admission closes
   when `run` returns; changes already admitted drain, then the outcome is recorded.
6. **Pins between attempts:** the object holds the factory's `at(key)` pins until the next factory returns (the moment
   unused in-memory slots are dropped). Each attempt loads its declared singletons and pins not in memory (line jobs)
   before it goes live. A consumer whose pin load fails the provider fails as a dependency failure (`transient`, R18).
7. **One host per store:** `createHost` refuses a store attached to an open host (`invalid/args`).

**The commit step and errors**
8. **Serialization before `BEGIN`:** every write is serialized when it is staged (table writes) or prepared (documents,
   before the queue); a value `JSON.stringify` cannot encode (a cycle, a `BigInt`) fails there (`invalid/args` or the
   transaction), never in the step.
9. **Order inside one commit:** retirements before creations (the partial unique index on the live address), then
   changes, rows, the outbox commit, `lastSeq`.
10. **Integers:** an `int` column has a SQL `CHECK` keeping it within `±(2^53 - 1)`; an expression result outside it
    (`add` past the safe range) fails the step, which is `storage_failed` (accepted, as the 2^63 case was); the JS
    evaluator (the `tx.get` overlay) checks the same range and refuses out-of-range results. `add`/`sub` take `int`
    columns only; `max`/`min` take `int` or `num`.
11. **Reads after a failure:** as Durable's `GuardedStorage`, a read that settles after the store stopped rejects
    `unavailable/storage_failed`, never returns a value. A shared cold load runs under the owner's context, not its
    first waiter's.
12. **Open and import failures:** `openStore` and `importStore` close the backend they were given when they reject;
    a refused import rolls back every table it created. An import whose input iterator stalls is cancelled by `ctx`
    without holding the backend transaction past it.

**Tables, queries, writes**
13. **Key columns are immutable** in `update`, `updateWhere` and migration patches (types and staging, `invalid/args`);
    moving a row is `delete` plus `put`.
14. **Canonical writes:** both `set` forms compile at staging into one data-only expression vocabulary, with an
    explicit `null` literal for a clear (`{ note: undefined }` would serialize to `{}`); the outbox and archives carry
    that form, never callbacks or `undefined`. An empty `set` is `invalid/args`.
15. **Defaults:** a column with a `default` may be omitted in a `put` (SQL `DEFAULT`); reads always return it.
16. **Operands:** comparing an `opt` column with `undefined` is `invalid/args` (ask with `isNull`).
17. **Pages:** `limit` is a positive safe integer; `rows()` pages internally by 100; `next` comes from fetching
    `limit + 1`; a cursor is a position in the order (one from another `where` with the same order is accepted);
    duplicate `orderBy` columns are refused and the key tie-break is not repeated.
18. **The prepared-statement cache** of `chord/sqlite/node` is a fixed LRU (pi change, upstream first, before the
    build): arbitrary query shapes cannot grow it without bound.

**Documents and keyed members**
19. **Retiring a `latest` record** deletes its row and revisions (Chord never reads history; a key retired and
    recreated often leaves no dead rows); `full` records keep them (6b). The record's counter is `revision` (not
    "version") in the conditional `UPDATE`.
20. **Absent keys:** a keyed `get` of an absent key is not cached (a line job plus a read each time; accepted, stated in
    the guide); `watch(key)` on an absent key returns `undefined`, and a later creation is seen through `at(key)` or a
    new watch.
21. **Retired derives:** a derive over a retired source publishes `retired: true` even when its value is unchanged and
    its ops are empty (`Derive.deliver`'s identity and empty-diff shortcuts must not swallow the flag).
22. **Keyed members:** a re-exposed keyed member resolves to the ultimate provider's source (no second tracker); pins
    are released exactly once (failed consumer activation, retry, release, re-exposure); `ref.member.get/watch` while
    the provider is loading or failed behave as calls (park while loading, reject with the cause when failed); keyed
    members have no `keys` (a method lists keys); `keyed(...)` adds a node to the fingerprint without bumping
    `NORMAL_FORM_VERSION`.
23. **Eviction's idle structure** is Durable's (`#touchDocument`'s granule rule: one move per tenth of the retention,
    O(1) per touch); one owner-level timer.

**Export and import**
24. **The manifest carries `nextDocumentId`** (the id high-water mark), restored atomically and checked against the
    imported records; import keeps ids and `createdAt` seqs.
25. **Import validation** also covers record ids and seq ranges, one live record per address, versions, duplicate
    definitions and agreement with the manifest; `json(...)` cells are checked as JSON text only (no plugin code runs).
26. **Export cancellation** releases the queue and its page buffers and metadata references (GC-tested with a retained,
    aborted iterator). Code that commits while consuming its own export waits until `ctx` aborts (the guide; a test).

**Benchmarks and cost**
27. A fourth gate case, (d) a commit with one in-memory document only (the store adds nothing to the W12 path); queue
    wait reported separately from step time; late migration chunks measured as well as the first.

**Carry-over (to slices.md):** slice 7: remote holds and remote objects leaving `live` (`Hold.moved`,
`RemoteObject.failed`; not reachable in 6a, P3), old table handles' version fence, the routine handover fenced per
routine invocation, holds re-bound by member name, keyed members' versions per key, `rebuild`.

## Races

1. Two objects commit at once: their steps queue; each adopts inside its own step, in seq order.
2. A transaction discarded after its callback while another owner's step runs: it never entered the queue.
3. The store fails during a step: that commit rejects; later commits and reads reject `unavailable/storage_failed`;
   the host closes.
4. An object's attempt is sealed while its commit waits in the queue: rejected at the step's entry; one already in the
   step lands and is adopted into the object's slots; the next attempt drafts from them.
5. A cold `get` and a transaction's draft of the same key: both on the line; the load installs only while absent.
6. A keyed document evicted while a `get` for it is in flight: eviction runs on the line and skips pinned keys.
7. A migration crashes in the middle: the next activation finds `version N, migrating` and continues.
8. An export holds the queue while commits and migration chunks wait; the export's `ctx` aborts while its consumer is
   suspended: the queue is released.
9. A retire and a recreate of one key in one transaction: one call with `retired: true` and the new value.
10. Old code (after a rollback) meets a newer table, column or document version: the object fails `broken`, data
    intact; a newer outbox `format`: `outbox.read` rejects, data intact.
11. The outbox is switched on for a store with data: the metadata says from which seq it starts.

## Cost

| Work | Cost |
| --- | --- |
| commit of one document delta | one step: about three statements, plus one with an outbox, plus one on a checkpoint |
| commit of in-memory documents only | as today: no step, no seq, no await |
| table put | two statements in the step (the row, `lastSeq`), plus its write in the outbox commit |
| `updateWhere` over N rows | one statement, one write; holds the queue for its duration |
| read of a page | one query |
| keyed `get` (cached) | no SQLite; one touch of the idle structure (Durable's granule rule); (cold) a line job and one or two reads |
| activation of an object with persisted singletons | plain reads, once per object |
| a `json(...)` column read at the current version | one `JSON.parse`; an older version adds `migrate` and one check |
| `rows` migration | about 15 µs per row, one commit per 100 rows |
| a keyed commit with no pins on the key | one `Map.get` |

## Carry-over taken

From `slices.md` "Slice 6a": facets only declare (1.1), documents, line and job runs on the object (1.2), keyed state
members (12), W12 and W7 (sections 3, 5, 8), retirement in Chord (1.5, 11).

## Carry-over left

- Slice 6b: persisted jobs, `StoreStorage` (Durable's record tables in the store: declared tables or internal), reads
  at an older seq, `history: "rewindable"` export, `durableView`.
- Slice 7: in-memory `migrate` on reload; the routine handover fenced per routine invocation; holds unsubscribed at
  seal and re-bound by member name; keyed members' versions per key; a native restart drains first (decided); `rebuild`
  (key or column-type changes) if a case needs it.
- The sync layer: upload, acknowledgement and `outbox.trim`, epochs, pull-back, the split, snapshot reads for large
  exports.
- Keyed members across links (Fable's design or selector holds) when a real case needs them.

## Size

About 3,000-3,500 source lines (the store core about 1,650, persisted documents about 400, tables and migrations
about 600, retirement and keyed watches about 200, keyed members about 300-350, the object/attempt/fence rework about
300), minus the facet code removed, plus the tests.
