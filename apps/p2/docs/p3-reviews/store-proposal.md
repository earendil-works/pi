# The store: one transactional table store under Durable, Chord and plugins (proposal under review)

> **Superseded (2026-10-21):** the decided design is the book `packages/chord/docs/store/book.md` and the decision
> log entries "The store", "S1" to "S17", "Blobs and derived data", "Index definitions are recorded". This page is the
> state that went into the review.

Status: direction accepted by the owner on 2026-10-21 (decision log, "The store"); details below are open for review.
Working name "the store" (the owner rejected "session table store": it is a general embedded store; a session is one
use). Background and measurements: `session-data-scenarios.md`, prototype `session-sync-prototype/`, explainer
`session-sync-explainer/` (option E, now superseded by this).

## 1. Problem

**P1 (owner):** a session is self-contained: everything of it lives in its storage plus its directory; it can be
exported from the session alone and imported into another p3 instance; it can be synced to Radius and continued on
another device (Armin's "Session Sync, second edition": a decorator captures every commit into an outbox, batches go
to Radius, a replica replays them, one driver per session, two writers fork the session).

That works for one storage (Durable's `session.sqlite`). It does not extend to:

- **Chord's persisted documents** (today a second storage with its own sequence);
- **plugins' own storage** in the session directory (a SQLite file for performance, a JSONL log): no outbox, and no
  order relative to the session's commits.

The failure, traced (file-history plugin, own `history.sqlite`):

```
laptop   t1 history.sqlite: row { path: "x.ts", entry: 812 }
         t2 session.sqlite seq 42: entry 812
replica  received history up to t1, the log only up to seq 41 → the row points to a missing entry
takeover now: the desktop writes another entry 812 → the row points to the wrong entry, permanently
```

## 2. Discarded solutions (in the order discussed)

| # | Idea | Why discarded |
| --- | --- | --- |
| A | Plugins' own databases may hold only derived data (rebuilt, never synced); source data in documents, entries, blobs | owner: too limiting; some plugins need their own query power and write model |
| B | Export plugin directories as opaque files | needs a quiescent session; cannot sync incrementally (page shipping) |
| C | Plugin export/import hooks | for sync each plugin would build its own incremental log |
| D | Plugin record logs in the session log, the plugin's database as a projection (`apply`) | plugin must write deterministic `apply` and keep every record version forever |
| E | Many stores, each with an in-transaction outbox, one global position counter, a safe cut | works (prototype), but many outboxes and a cut rule; SQLite changesets are per row (10k-row rename 259-418 KB), DDL not captured, Cloudflare support unknown |
| F | Generalized session SQLite with changesets, or with recorded SQL statements verified by a patchset hash | SQLite-only; statements risk nondeterminism (`random()`, unordered `INSERT ... SELECT`, SQLite versions) |
| G | Raw SQL reads, controlled writes | SQLite-only backends; reads need a write guard |
| H | An IndexedDB-shaped API only | owner: too limited for many queries (aggregates, joins, multi-range filters) |
| I | Chord documents inside Durable's `Storage` (shared storage, earlier reviewer proposal) | covers Chord, not plugins; Durable's write grammar only |

## 3. The design

### Layers

```
backend   SQLite (Node, Durable Objects, sqlite-wasm) | memory | IndexedDB
          rows, declared indexes, one atomic write batch
store     defineTable, query DSL, controlled writes, commit queue, seq, outbox, export/replay
  ├─ Durable adapter    StoreStorage implements Durable's Storage on tables "pi-durable/*"
  ├─ Chord documents    on tables "chord/*"
  └─ plugin tables      self.table(...) in their owning objects
```

Durable's existing storages (memory, SQLite, JSONL, IndexedDB) stay unchanged; `StoreStorage` is added next to them
and must pass Durable's storage conformance suite. One store per session (on the session's worker); the server may
have its own store for instance data.

### Documents engine (S13, decided)

One engine in the store for persisted documents, used by Durable's `StoreStorage` and directly by Chord: address
`(namespace, owner, kind, key?)` with an opaque owner; `find`/`load`/`list` outside the step, `create`/`change`/
`retire` inside it; API and rules in the decision log ("S13").

### Tables

```ts
const Edits = defineTable("edits", {
  version: 2,
  schema: obj({ id: str(), path: str(), entry: int(), at: int(), size: int() }),
  key: ["id"],
  indexes: { byPath: ["path", "at"], byEntry: ["entry"] },
  migrate: (row, from) => ({ ...row, size: row.size ?? 0 }),
});

host.serve(FileHistoryStore, (_, self) => {          // input-less local object (P3)
  const edits = self.table(Edits);                   // address: (host, object type, "edits")
  …
});
```

- **`json(schema)` columns (owner, 2026-10-21, proposal):** a column that holds a JSON value typed by its schema but is
  opaque to the store: not indexable, not usable in `where`/`orderBy`/`groupBy` (a type error), read back typed (no
  manual `parseJson<T>` casts as in Durable's SQLite storage today), not validated on write (R9), part of the table's
  fingerprint. Scalar columns are what queries and indexes use. Example: `pi-durable/entries` =
  `obj({ id: int(), conversationId: int(), headOf: opt(int()), commitSeq: int(), record: json(EntryRecord) })`.
  Under the real-tables layout this is exactly Durable's current SQLite shape (index columns plus `record TEXT`).
- A table belongs to one owning object, like a document: only that object reads and writes it; address (host,
  object type, table name), so an input change cannot orphan data; other plugins see the data only through the
  object's members.
- Rows are JSON objects. A row missing an indexed field is not in that index (on every backend: the partial-index
  rule; Durable's head-entry index uses it).
- Indexes are local: created by the owning code where it runs; never recorded.
- Migrations run only where the owning code runs (the driver); rewritten rows are ordinary puts in the outbox; old code
  reading a row of a newer version is refused, data intact (as R15 for documents).

### Queries (small DSL) and controlled writes

```ts
q.from(Edits).where((e) => eq(e.path, "src/app.ts")).orderBy((e) => e.at, "desc").limit(20).after(cursor)
q.from(Edits).groupBy((e) => e.path).select((e) => ({ path: e.path, n: count() }))

await edits.transaction(async (tx) => {               // under the owning object's line
  const g = await tx.get(Guests, id);
  await tx.put(Guests, { ...g, revision: g.revision + 1 });   // read, compute, put: no expressions
  await tx.delete(Links, [linkId]);
  await tx.deleteWhere(Revisions, (r) => eq(r.document, docId));   // resolved to keys, one delete record per row
});
```

Proposed DSL scope (not yet confirmed by the owner): `get`; `where` with `eq ne lt lte gt gte inArray isNull prefix
and or not`; `orderBy` (several fields), `limit`, cursor; `select` of fields; `groupBy` with `count sum min max`; one
equality `join`. Out: subqueries, `LIKE`/regex/full text, offset paging, computed selects, window functions, `HAVING`,
more than one join. Full-text search stays derived (a local SQLite FTS, never synced).

### Lines, the commit queue, seq

| | serializes | duration | count |
| --- | --- | --- | --- |
| object line | a whole transaction callback (read, decide, write) | as long as the callback | per Chord object; per Durable Session |
| commit queue | only the final write batch: adapter checks, writes, seq, outbox record | short, no waits outside the store | one per store |

```ts
store.commit(async (batch, seq) => { /* reads only through batch; checks; puts and deletes */ });
```

- **Adoption inside the step (S1, decided):** `store.commit(prepare, adopt)`; each owner's synchronous in-memory
  adoption runs after the backend commit and before the next step; Durable's `Storage.commit(writes, adopt,
  context)` carries it. Listeners run afterwards in each owner's continuation.
- **Completion (S3, decided):** the step ends on the backend's terminal success only (SQLite `COMMIT`, IndexedDB
  `complete`); memory stages and swaps; an ambiguous outcome stops the store; after a restart the driver pulls back
  its own uploaded batches when its local head is behind.
- The seq is assigned inside the commit step, and the outbox record is written in the same backend transaction as
  the rows, so a crash keeps both or neither.
- Durable's seq is the store's seq: `StoreStorage.commit(writes)` runs its checks and stamps `commitSeq`, `createdAt`,
  `retiredAt` and revision seqs inside the step, as `SqliteStorage.commit` does inside its SQLite transaction today.
  Durable sees gaps (other owners' commits); it only compares seqs (`created_at <= at`, `seq > base`; checked:
  no `seq + 1` neighbour arithmetic in the storages or the session).
- Chord documents get the same seq, so they share one timeline with the transcript (outbox, export, "as of" reads).

### The outbox, sync, export, import

```
{ seq: 41, ops: [
  { table: "pi-durable/entries", key: [812], v: 1, row: { … } },
  { table: "file-history/edits", key: ["e1"], v: 2, row: { … } },
  { table: "file-history/edits", key: ["e0"], delete: true } ] }
```

- A replica applies ops without any plugin code: it stores rows under (table, key). Tables of plugins that are not
  installed travel along untouched.
- Sync: Armin's transport and fencing (batches of outbox records, one driver per session, epochs, fork on conflict).
- Export (S4, decided): pauses commits while it reads, so the archive is the state at one head; import: restore into a fresh store; then the server indexes the
  session (catalog mirror).
- Derived data (FTS, caches) is rebuilt where needed, never shipped.

## 4. Open points

1. Physical layout: generic rows `rows(tbl, key, v, row)` (no DDL on replicas, JSON parsing on scans) or one real table
   per logical table (definitions and changes recorded, DDL and rebuilds on replicas). Measured for generic rows on
   100k rows: indexed lookup 0.07 ms, join + group 129 ms, group by 49 ms.
2. DSL scope (section 3).
3. Migration timing: eager at activation (consistent indexes, one burst) or lazy per row.
4. Durable's `next_id`: a row written per commit (replicates for free) or derived at open from the highest id.
5. Backend details: string order (UTF-16 code units as in JS and IndexedDB vs UTF-8 bytes in SQLite), values that
   cannot be index keys in IndexedDB (booleans, null), IndexedDB version upgrades for new indexes.
6. Atomic writes across owners: possible in one batch, but owners commit separately; core invariants stay in one
   owner's transaction.

## 5. Owner's worry: "seq 40 after seq 50"

Could anything observe, store, upload or apply a commit with a lower seq after one with a higher seq, or act on state
at seq 50 that lacks seq 40? Places to check: seq assignment vs completion of the write; in-memory adoption and
observer notification order across owners (Durable's Session adopts after its commit, Chord objects adopt after
theirs); reads outside transactions between two commits; derived data and routines reacting to commits of different
owners; the outbox cut and upload; export snapshots; replica apply; takeover; async backends (IndexedDB) and the
queue; aborted commits (gaps).
