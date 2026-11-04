# Session data: write, export, import, continue (scenarios, for discussion)

Status: discussion (2026-10-21), nothing decided. Assumes the open proposals P1 (a session is self-contained), P3
(persisted documents only in input-less `local` objects) and shared storage (Chord's persisted session documents and
Durable commit into one storage, one seq).

## The session directory

```
<data>/sessions/S1/
  session.sqlite           class 1, log state: Durable (entries, tasks, documents) + Chord persisted documents
  blobs/sha256/9f/9f3a…    class 2, immutable content, named by its hash (artifact versions, uploads, sent files)
  derived/artifacts/       class 3, a plugin's own files: index.sqlite (rebuildable, never exported or synced)
  derived/search/
```

Not in the directory: per-instance data (shares, devices, settings, read marks) in the server's storage; the catalog
on the server is a mirror of each session's metadata document.

## The example plugin: artifacts with a full-text index

```ts
const Artifact = defineState("artifact", {
  schema: obj({ title: str(), type: str(), versions: arr(obj({ blob: str(), size: int(), at: int() })) }),
  version: 1, keyed: true, persist: true,                         // key = artifact name
  initial: () => ({ title: "", type: "text", versions: [] }),
  checkpointWhen: () => true,
});

host.serve(ArtifactStore, (_, self) => {                          // local, input-less (P3)
  const artifacts = self.state(Artifact);
  const blobs = self.get(SessionBlobs, {});                       // core: the session's blob store
  const info = self.get(SessionInfo, {});
  const index = self.open(async () => openIndex(join(info.init.value.dir, "derived/artifacts/index.sqlite")),
    (db) => db.close());

  self.routines.loop("catch-up", async (ctx) => {                 // derived data repairs itself
    for await (const name of artifacts.keys()) {
      const a = await artifacts.get(name);
      if (a && index.value.versions(name) !== a.versions.length)
        index.value.put(name, a.versions.length, await blobs.read(a.versions.at(-1)!.blob, ctx));
    }
  });

  return {
    save: async ({ name, title, type, content }, ctx) => {
      const bytes = utf8(content);
      const blob = await blobs.put(bytes, ctx);                   // 1. content first
      await self.tx(ctx, async (tx) => {                          // 2. the document referencing it
        const a = await tx.draft(artifacts, name);
        a.title = title; a.type = type;
        a.versions.push({ blob, size: bytes.length, at: Date.now() });
      });
      const version = (await artifacts.get(name))!.versions.length;
      index.value.put(name, version, content);                    // 3. derived, best effort
      return { version };
    },
    search: ({ query }) => index.value.search(query),
  };
});

// the tool (Durable): the harness writes the tool result entry after it returns
execute: (args, api, context) => chord(context, async (ctx) => {
  const { version } = await (await ctx.get(ArtifactStore, {})).save(args, ctx);
  return { content: [{ type: "text", text: `${args.name} v${version} saved` }] };
}),
```

## Trace 1: the agent saves an artifact (laptop)

```
t1  blobs.put       blobs/sha256/9f/9f3a… (tmp, fsync, rename)        not in the log
t2  Chord commit    seq 41: document.change artifact "chart": versions[2] = { blob: "sha256:9f3a…" }
t3  index.put       derived/artifacts/index.sqlite                     not in the log
t4  Durable commit  seq 42: entry toolResult "chart v3 saved"
```

Crashes: after t1, an unreferenced blob (costs bytes, harmless); after t2, the index lags and the catch-up routine
repairs it at the next activation; after t3, Durable's recovery handles the tool call as today.

## Trace 2: export

```
p3 export S1  →  S1.p3session (one archive)
  manifest.json     { format: 1, session: "S1", head: 42 }
  log.jsonl         storage.export(): every record, Durable and Chord, in seq order, never filtered by plugins
  blobs/…           every file in blobs/ (no reference tracking; orphans from crashes come along)
  (derived/ is skipped)
```

Consistent without stopping the session: the log export reads one storage snapshot at head 42; every blob a record up
to 42 references was written before that record (t1 before t2), so it is already in the directory.

## Trace 3: import on another p3 instance

```
p3 import S1.p3session
  1. S1 exists here? refuse (or import under a new id: it is then another session)
  2. copy blobs/ into sessions/S1/blobs/, check each hash
  3. replay log.jsonl into a fresh sessions/S1/session.sqlite
  4. the server mirrors the session metadata document into its catalog
  5. first open: ArtifactStore activates, index.sqlite is missing, catch-up rebuilds it from documents + blobs
```

The artifacts plugin not installed there: its documents and blobs stay untouched; the index is built once it is.

## Trace 4: continue on another instance (only with sync)

```
laptop (driver)  outbox:  [blob 9f3a…] [batch seq 41-42]       blobs present at batch cut go first
desktop          fetches batches, replays; fetches blobs by hash (eager or on read); builds its own index
takeover         desktop asks for the next epoch, becomes driver; the laptop's copy turns read-only
```

## "A plugin uses its own SQLite for performance": two cases

**Derived (an index, a cache, a materialized view):** as above. Writes to it are free; only the source goes through
the log. Export skips it, import and sync rebuild it.

**Source of truth (data that exists nowhere else),** e.g. a plugin recording 1M terminal output lines in its own
database. Options:

- **A, not allowed:** the source goes into documents, entries or blobs. Bulk append data is written as sealed chunks:
  every N rows become one immutable blob, a document lists the chunk hashes, the open tail lives in a document. The
  plugin's SQLite is again a derived query index over the chunks. Export, import and sync work unchanged.
- **B, plugin directories exported as opaque files:** export must stop the session's writers (a live SQLite file
  copy is not consistent, and the database must agree with the log at head 42), then copy `derived/` along. Works for
  export and import. Fails for sync: a changing database cannot ship incrementally (that is page shipping), so another
  instance gets it only as a whole file at a handover.
- **C, plugin export hooks** (serialize to records, apply on import): for sync each plugin would also have to produce
  incremental changes, i.e. its own log next to class 1.

## The driver rule

It bites only with sync. In p3 clients never write storage: the phone's calls go to the worker on the instance that
runs the session, which is the only writer anyway. Two instances holding S1 exist only through sync (then one drives)
or through import (then the import is another session).

## Option D (2026-10-21, owner's concern: docs and blobs may not model everything)

Queries are not limited by documents plus blobs (a derived SQLite may have any schema and index); the write model is.
Example: a file-history plugin, 10k rows `(path, before, after, entry, at)`; "directory a/ moved to b/" is one SQL
`UPDATE`, but 10k document changes. D: a plugin record kind in the session log; the plugin's own database is a
projection of its records (event sourcing; documents are the same idea with a fixed apply into memory).

```ts
const FileHistory = defineLog("file-history", {
  version: 1,
  record: union([
    obj({ kind: lit("edit"), path: str(), before: str(), after: str(), entry: int(), at: int() }),
    obj({ kind: lit("move"), from: str(), to: str(), at: int() }),
  ]),
});

host.serve(FileHistoryStore, (_, self) => {
  const log = self.log(FileHistory, {
    open: (dir) => openDb(join(dir, "history.sqlite")),       // any schema, any index
    apply: (db, record) => {                                   // deterministic: no clock, no I/O but db
      if (record.kind === "edit") db.run("INSERT INTO edits VALUES (?,?,?,?,?)", …);
      else db.run("UPDATE edits SET path = ? || substr(path, ?) WHERE path GLOB ?", …);
    },
  });
  return {
    move: ({ from, to }, ctx) => log.append({ kind: "move", from, to, at: Date.now() }, ctx),
    versions: ({ path }) => log.db.all("SELECT * FROM edits WHERE path = ? ORDER BY at", path),
  };
});
```

```
append   commit seq 57: { log: "file-history", record: move a/ → b/ }   (same storage, may share a tx with documents)
         then apply + "_applied = 57" in one SQLite transaction of history.sqlite
crash    between the two: on open Chord applies records after _applied
export   records are log records: already in log.jsonl; history.sqlite skipped
import   replay the log; first open: empty db, apply every record from the start (or from a snapshot)
sync     records ship in batches like everything else; the other instance applies them
compact  log.snapshot(): VACUUM INTO → blob, record { snapshot: hash, seq }; records before it may be dropped;
         import starts from the snapshot blob and applies the rest
```

Rules and costs: `apply` deterministic and pure over its database; every record version is applied forever (or until a
snapshot); one writer per log (the object's line); a snapshot is a SQLite file (a Durable Object cannot load one, it
replays records instead).

## Option E (2026-10-21, owner: an app-layer abstraction; Chord provides primitives)

Owner: blobs plus documents recording them are already app layer; the app knows what to sync; plugins get a storage
location in the session directory that is synced too; open issue: consistency on sync.

The problem, traced (two stores, no common order):

```
driver   t1 history.sqlite: row { path: "x", entry: 812 }
         t2 session.sqlite seq 42: entry 812
replica  has the SQLite changes up to t1, the log only up to seq 41: the row points to a missing entry
takeover at that moment: the new driver writes another entry 812 at seq 42: the row points to the wrong entry
```

Mechanism: one position sequence across all stores of a session (app layer). Every store, in the same transaction as
its change, takes the next position and records the change in its own outbox (SQLite: an outbox table in the same
database; JSONL: the appended lines themselves). A batch is cut at position P once nothing at or below P is still
committing; it holds every store's records up to P. A receiver applies them in position order, so it is always at a
state the driver had. After a crash the counter restarts at the maximum over all stores.

| store kind | change record | apply on a replica | snapshot (export, compaction) |
| --- | --- | --- | --- |
| Chord / Durable storage | the commit's writes | `replay` | `export()` |
| blob directory | "added hash" plus the bytes | write the file | the files |
| append-only JSONL | the appended lines | append | the file |
| SQLite (app abstraction) | changeset from SQLite's session extension, stored in the same transaction | `applyChangeset` | `VACUUM INTO` |
| files changed in place | none | none | not syncable: derived only |

Checked on Node 24 (`node:sqlite`): `createSession({ table })`, `changeset()` before `COMMIT`, insert into an outbox
table in the same transaction, `applyChangeset` on a second database gives the same rows. Limits: changesets are per
row (a 10k-row move is 10k row changes, tens of bytes each, no pages); schema changes are not in changesets, so plugin
migrations are versioned and run on every replica before changes of the new version; Cloudflare's Durable Object SQLite
API may not expose the session extension (to check).

Chord's part: a storage that can be wrapped (every commit's writes, in order, with a hook inside the commit to take a
position and write the outbox record) plus `export()`, `replay()` and `head()`. Consequence: ordering no longer needs
Chord documents in Durable's storage; shared storage would only save a file.

## Generalized session SQLite store (owner, 2026-10-21, proposal) and outbox cost

Owner: one generalized store implementing the outbox mechanics; plugins give it a schema plus versions/migrations
and get a SQLite interface ("SQLite all the things"). Prototype of the mechanics: `session-sync-prototype/`.

Measured on slayer (Node 24.4.1, WAL, `synchronous=NORMAL`), table `edits` with 2 KB before/after text per row,
one transaction per operation:

| workload | plain | changeset outbox | patchset outbox |
| --- | --- | --- | --- |
| 10k inserts | 244 ms | 584 ms, outbox 40.5 MB (= row data 40.2 MB) | 568 ms, 40.5 MB |
| rename 10k rows (one UPDATE) | 137 ms | 198 ms, 418 KB | 191 ms, 259 KB |
| 1k one-column updates | 11 ms | 39 ms, 49 KB | 38 ms, 36 KB |

Per transaction about +30 µs. An insert's record is the row (the same holds for any replication log, including a
Durable outbox: an entry's record is the entry). Set-based updates cost 26-42 bytes per changed row. The outbox is
trimmed after upload, so disk holds only the unsynced backlog.

## Recording SQL statements, verified by an effect hash (2026-10-21, proposal)

Record each write statement with its parameters instead of the changed rows; check determinism instead of trusting
it. Checked on Node 24.4.1:

- Nondeterministic built-ins can be blocked by overriding them per connection with `db.function(name, { varargs:
  true }, throwing)`: `random()`, `randomblob()`, `datetime('now')`, `CURRENT_TIMESTAMP`, `unixepoch()` all throw;
  `abs()` still works. (`setAuthorizer` is not in Node 24.4.)
- SQLite's patchset of a statement is byte-identical on two databases with the same rows even when their physical
  insertion order differs (5,000 rows inserted ascending vs descending: same 118,904-byte patchset, same SHA-256), and
  differs after one replica lost a row. So a 16-byte hash of the patchset, recorded with the statement, detects any
  divergence at the exact statement on the replica.
- Record size of the 5,000-row rename: the statement is 69 bytes (plus a 16-byte hash) instead of a 119 KB
  patchset.

Shape: the plugin writes through `tx.run(sql, ...params)`; the store runs it inside a SQLite session, records `{ pos,
statements: [[sql, params]], hash(patchset) }` in `_outbox` in the same transaction, and discards the patchset. The
replica runs the statements inside a session and compares the hash; a mismatch stops that store and restores it from
a snapshot (and reports the plugin's nondeterministic SQL). Costs: the session extension still runs on both sides
(CPU, about +30 µs per transaction), no extra disk. Remaining sources of divergence that the hash catches but nothing
prevents: `INSERT ... SELECT` or `LIMIT` without a total `ORDER BY`, different SQLite versions across machines.

## Statements Durable's and Chord's SQLite storages use (inventory, 2026-10-21)

Sources: `packages/durable/src/storage/sqlite/{storage,migrations}.ts`, `packages/chord/src/storage/sqlite/{storage,schema}.ts`.

Reads:

| Shape | Durable | Chord (frozen next/) |
| --- | --- | --- |
| get by primary key | conversations, entries (+ `commit_seq`), tasks, submissions, documents, record_ids, metadata singleton | documents, ids, metadata |
| equality filters + id range + order + limit (paging) | conversations by owner; tasks by any of conversation, kind, status, abortRequested, background; submissions by conversation, status; entries by conversation with `id >= ? AND id <= ?`, asc or desc | keys of (owner, definition) after a cursor, ordered by `key_order` |
| latest matching row (`ORDER BY … DESC LIMIT 1`) | entry heads (`head IS NOT NULL`, partial index); document revisions: newest base `seq <= ?`, newest revision | newest base |
| range of a composite key | revision tail `document_id = ? AND seq > ? AND seq <= ? ORDER BY seq` | same |
| lookup by secondary key | submission by `(conversation_id, request_id)`; current document by address (5 columns) `AND retired_at IS NULL` | current document by address (4 columns, unique partial index) |
| point in time | documents `created_at <= ? AND (retired_at IS NULL OR retired_at > ?)` | none |
| tags | none | `byTag` (dropped by proposal P3) |

Writes: insert row; upsert whole row on primary-key conflict (tasks, submissions); insert-or-ignore (record_ids, tags);
update columns by primary key (metadata counters, retiring a document); delete by key prefix (all revisions of a
document; tags of a document). Every commit is one transaction; multi-query reads (document materialization) run in a
transaction for one consistent state. Migrations: DDL, including a table rebuild to change a CHECK constraint.

Not used anywhere: joins, aggregates (not even `count`), `GROUP BY`, `LIKE`, subqueries, expressions in `SET` (only
values), set-based updates other than delete-by-prefix. Details a backend must match: string order equal to
JavaScript UTF-16 code-unit order (Chord's `key_order` encoding exists for this), integers beyond 2^53 stored as text
(`next_id`), partial and unique indexes. p2's plugins additionally use `count`, `IN (subquery)`, joins, `GROUP BY` with
`max`, and `SET x = x + 1` / `max(x, ?)` (catalog and sharing, server-side).

## Generic JSON rows plus local SQL views (2026-10-21, proposal after "IndexedDB may not be enough")

The store keeps every table's rows in one generic layout, `rows(tbl, key, v, row JSON)`, so it needs no plugin code;
the plugin, where its code runs, creates local views and expression indexes (derived, never synced) and reads with full
SQL. Measured on Node 24.4.1, 100k `file-history/edits` rows plus 20k `turns` rows:

| query | time | plan |
| --- | --- | --- |
| versions of a file (`WHERE path = ? ORDER BY at DESC LIMIT 20`) | 0.07 ms | covering expression index |
| edits per model (join + `GROUP BY`) | 129 ms | index on the join key, temp B-tree for the group |
| most edited files (`GROUP BY path ORDER BY n DESC LIMIT 5`) | 49 ms | scan of the table's rows |
| big edits in a time window (two ranges, no index on `at`) | 30 ms | scan of the table's rows |

Write guard without `setAuthorizer` (Node 24.4.1): temporary triggers `BEFORE INSERT/UPDATE/DELETE ON main.rows WHEN
store_writing() = 0 ... RAISE(ABORT)` with `store_writing` a JS function the store flips around its own writes; plain
`INSERT`, `UPDATE`, `DELETE` and `WITH ... DELETE` from plugin SQL are refused. DDL (`DROP TABLE rows`) is not stopped
by triggers.
