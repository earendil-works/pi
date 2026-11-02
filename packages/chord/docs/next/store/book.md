---
title: One Store: how a p3 session keeps, exports and syncs everything it owns
cover: One / Store
kicker: A design book · Chord v2 and p3 · 2026-10-21
subtitle: Why Durable's transcript, Chord's documents and every plugin's own tables live in one transactional store, and how that store moves a session to another machine without coming apart
stats:
  - 17 | review items decided (S1–S17)
  - 1 | commit queue per store, one seq for every owner
  - ~150 B | outbox write for renaming 10,000 rows (instead of ~40 MB)
  - 0 | lines of plugin code a replica needs
note: |
  Written for the owner from the discussion of 2026-10-21 and the store review by Fable and Astra. Every decision is in
  the decision log (`packages/chord/docs/next/decisions.md`, entries "The store", "S1" to "S17", "Context last"); the
  review is summarized in `apps/p2/docs/p3-reviews/store-review-summary.md`, bulk operations and migrations in
  `store-bulk-migrations.md`, the earlier discussion with measurements in `session-data-scenarios.md`. Numbers were
  measured on slayer with Node 24.4.1 and `node:sqlite` unless marked as estimates. Nothing here is built yet. Notes
  marked *review* are points the reviewers raised that the design answers.
colophon: One Store · first edition · 2026-10-21 · based on the redesign decision log and the store review
---

# Before we begin {.preface}

Mario works in session S1 on his laptop. The agent edits files, and a plugin called **file-history** remembers every
edit: which file, which conversation entry made it, the content before and after. It keeps those rows in its own table,
because it needs queries: every version of `src/app.ts`, every file the last turn touched, every edit under `a/`. When
Mario renames the directory `a/` to `b/`, ten thousand rows change.

In the evening he wants to continue S1 on his desktop. Another day he exports S1 to a file and imports it into a
colleague's p3. Each time the other machine must end up with the conversation (Durable), the plugins' documents (Chord)
and the file-history table, and all three must agree: a row that says "entry 812 made this edit" must find entry 812,
the same entry 812.

Copying files does not do that, and neither does syncing each storage on its own. This book explains the problem, the
solutions that were tried and dropped, and the design that came out: one transactional store per session, under
Durable, Chord and every plugin.

## Eight things to know

:::findings
1. **A session is self-contained.** Everything it owns lives in its store and its directory; it can be exported from
   the session alone, imported elsewhere, synced and continued on another machine (P1).
2. **One store holds everything.** Durable's records (through an adapter), Chord's persisted documents and plugin
   tables commit into one store, through one commit queue, numbered by one seq.
3. **Order is guaranteed where it is observable.** Disk, outbox and export follow the seq; in-memory adoption runs
   inside the commit step (S1), so no reader ever sees seq 41 without seq 40.
4. **The outbox records what changed, not code.** Rows, column updates, bulk operations and table changes, written in
   the same transaction as the data. A replica applies them without any plugin code.
5. **Tables are real tables with a small query language.** Keys and indexed columns are typed; text is UTF-8 and
   compares by code point on every backend.
6. **Bulk writes stay small.** `updateWhere` records one operation instead of one row per change, and every replica runs
   the same operation.
7. **Migrations run only where the code is.** Changes inside `json(...)` columns migrate on access; key and index changes run eagerly on the
   driver and ship as ordinary writes.
8. **Losing control never rolls back.** A device that learns another one took over turns its copy into a separate
   session.
:::

## Words used throughout

A **session** is one agent workspace: its conversations, tasks and plugin data. An **owner** is the code that writes a
piece of data: Durable's Session, a Chord object, a plugin's object. The **store** is the transactional store of one
session; a **backend** is what it runs on (SQLite, including in the browser as WebAssembly; tests use SQLite `:memory:`). A **table** is a set of
rows owned by one object. A **commit** is one atomic write; the **commit step** is the short, serialized part of a commit
in which the store checks, writes and numbers it; the **seq** is that number. The **outbox** holds a record of every
commit, written in the same backend transaction. The **driver** is the machine that writes a session; a **replica** is
a copy on another machine that applies the driver's records. **Adoption** is an owner updating its in-memory state to a
committed write.

# A Session Is More Than Its Transcript {#problem lede="What has to travel with a session, and why separate storages cannot keep it consistent."}

A p3 session holds three kinds of data written by three kinds of owners. Durable writes the transcript: conversations,
entries, tasks and its own documents. Chord objects write persisted documents: settings, drafts, plugin state. And a
plugin may need data shaped for queries, like file-history's edits.

The owner's rule for p3 (**P1**) is that a session is self-contained. Everything of it lives in its storage plus its
directory; the server only mirrors it (the session catalog) and keeps instance data (shares, devices, settings). That
makes three things possible: export a session from its files alone, import it into another p3, and sync it to Radius
so another device can continue it.

Durable alone already supports that shape: one storage, every change in an atomic commit, numbered by a seq. Armin's
sync design builds on it: a decorator captures each committed batch into an outbox, batches go to Radius, a replica
replays them. It breaks as soon as a session has a second storage.

:::steps | One edit, two storages, synced separately
+++ On the laptop
The edit tool records the edit in file-history's own `history.sqlite` (row: path `x.ts`, entry 812). Durable commits
the tool's result. Both exist and agree.
+++ The history arrives first
The desktop has received `history.sqlite` up to the edit, but Durable's log only up to the commit before. The row says
entry 812 made the edit; the desktop has no entry 812.
+++ Mario takes over now
The laptop is closed; the desktop becomes the driver and writes its next entry, which gets id 812: a different
message. The row now points to the wrong entry, for good.
:::

Each storage is consistent on its own. What is missing is one order across them: which change of `history.sqlite`
happened before which commit of the transcript. Every solution below is judged by whether it provides that order,
lets a replica work without the plugin's code, and keeps plugins able to model what they need.

# What We Tried and Dropped {#dropped lede="The solutions discussed on the way, and the reason each one failed."}

The first answers tried to avoid giving plugins storage at all. The later ones gave them storage and tried to sync it.

| Idea | Why it was dropped |
| --- | --- |
| Plugins' own databases hold only derived data (indexes, caches), rebuilt after an import | too limiting: some plugins need their own write model and queries (owner) |
| Export plugin directories as opaque files | needs a stopped session; a changing database cannot sync in small pieces |
| Plugin export and import hooks | every plugin would build its own incremental log for sync |
| Plugin record logs in the session log, the plugin's database rebuilt from them by an `apply` function | the plugin must keep `apply` deterministic and every record version forever |
| Several storages, each with an outbox inside its own transaction, ordered by one shared position counter | works (prototype), but many outboxes and a "safe cut" rule; SQLite's row-change records are per row (a 10k-row rename is 259–418 KB); schema changes are not captured |
| A SQLite store that records the plugin's SQL statements, checked by a hash of their effect | SQLite only; arbitrary SQL can give different results on replicas (`random()`, unordered `INSERT … SELECT`, SQLite versions) |
| Raw SQL reads with controlled writes | ties every backend to SQLite and needs a guard against SQL that writes |
| An IndexedDB-shaped API only (keys, indexes, ranges) | too weak for real queries (owner) |
| Chord's documents inside Durable's existing storage | covers Chord, not plugin tables |

The store design kept something from almost each: one order for everything (from the shared counter), recorded
operations instead of rows where possible (from the statement idea, made safe because the operations are the store's
own), and a small query language (from the IndexedDB shape, but over real tables).

Inside the store, more choices were dropped during the review:

| Choice | Why dropped |
| --- | --- |
| all rows of all tables in one generic table `rows(tbl, key, v, row JSON)` | the owner wants real tables; with table definitions in the outbox a replica needs no plugin code anyway |
| index entries maintained by the store in a separate table | an extra row per index per write; SQLite could no longer filter natively |
| ~~code point order (SQLite's native order) with lone surrogates replaced~~ | rejected at first, then chosen (owner, 2026-10-26, "Text is plain UTF-8, in code point order") |
| text only for equality, order only over integers (Durable's own approach) | ordered text, ranges and prefixes must be possible (owner) |
| JSON-field operands in bulk updates | they lean on SQLite's JSON functions; added only when a real case needs them |

# The Store {#store lede="Layers, tables owned by objects, and the one transaction API."}

The store sits between the backends and everything that persists data in a session.

:::flow wide | The layers. Durable keeps its existing storages and gets one more, the adapter; Chord and plugins use the store directly.
row "Owners" blue
box durable "Durable Session" "`StoreStorage` adapter"
box chord "Chord objects" "persisted documents"
box plugin "plugin objects" "`self.table(...)`"
row "Store" accent
box docs "documents engine" "records, revisions, versions" accent
box tables "tables" "query language, writes" accent
box commit "commit step" "seq, outbox, adoption" accent
row "Backends" muted
box sqlite "SQLite" "Node, Durable Objects, browser (WebAssembly)"
box memory "SQLite :memory:" "tests"
arrow durable -> docs
arrow chord -> docs
arrow plugin -> tables
arrow docs -> commit
arrow tables -> commit
arrow commit -> sqlite
note "Durable's memory, SQLite and JSONL storages stay (S15), with only the adopt argument added (S1); StoreStorage joins them."
:::

**A table belongs to one object**, like a document: only that object reads and writes it; its address is (host kind,
object type, table name), never a host instance such as the session id (W7), so a params change, a split or an import
never orphans data; other plugins see the data only through the object's
state and methods.

```ts
const Edits = defineTable("edits", {
  version: 2,
  columns: { id: str(), path: str(), entry: int(), at: int(), meta: json(EditMeta, { version: 1 }) },   // flat
  key: ["id"],
  indexes: { by_path: ["path", "at"], by_entry: ["entry"] },
});

host.serve(FileHistoryStore, (_, self) => {          // a local object with empty params
  const edits = self.table(Edits);
  return {
    record: (edit, ctx) => self.tx((tx) => { tx.put(edits, edit); }, ctx),
    versions: ({ path }, ctx) =>
      edits.page(query(Edits).where((e) => eq(e.path, path)).orderBy((e) => e.at, "desc"), 20, ctx),
  };
});
```

- A table's `columns` are a flat record: each column is a scalar (`str`, `int`, `bool`, `num`) or `json(...)`; nesting
  exists only inside `json(...)`. Every column is a real SQLite column. Scalars can be filtered and ordered; keys and
  indexed columns must be `str` or `int`. A `json(...)` column holds JSON text: typed when read, never queryable or
  indexable (the type checker refuses it).
- Tables and documents of an object are written in the same transaction API, `self.tx(fn, ctx)` (S14). The context
  comes last in every signature (owner's rule).
- Index **definitions** are recorded like other table changes: when the owning object starts on the driver, the store
  creates or drops the difference between declared and existing indexes, and every replica applies it. Index contents
  never travel; every backend maintains them from the rows. So every copy of the store is the same file.

# Writing It Down {#commit lede="One commit queue per store, one seq for every owner, and adoption inside the step."}

Two different things are serialized, and they must not be confused. A **line** serializes a whole transaction
callback: read, decide, write. Chord has one line per object, Durable one per Session. The **commit queue** serializes
only the final step: checks, writes, seq, the outbox's commit. It is short and there is one per store.

:::sequence animate | Two Chord objects and a Durable turn commit at the same time. Their callbacks never wait for each other; only the short commit steps queue.
actor a "object A" "its own line"
actor b "object B" "its own line"
actor d "Durable Session" "its own line"
actor q "commit queue" "one per store" accent
a -> a: draft notes …
b -> b: draft drafts …
d -> d: phase writes …
a -> q: commit
q => q: seq 41: write, outbox, adopt A
b -> q: commit
q => q: seq 42: write, outbox, adopt B
d -> q: commit
q => q: seq 43: write, outbox, adopt Durable
:::

Durable's seq is the store's seq. Durable sees gaps (other owners' commits in between), and that is harmless: every use
of a seq in Durable compares (`created_at <= at`, `seq > base`); nothing computes `seq + 1` to find a neighbour (checked
in the storages and the Session).

## Adoption inside the step (S1)

After a commit is on disk, each owner swaps its in-memory state to the committed version. If that happens later, in
the owner's own continuation, the order can flip:

```
disk:    40 file-history, 41 Durable
memory:  Durable adopts 41 first (one await fewer)
         a routine on "entry 812 committed" reads file-history → still at 39
```

So adoption runs inside the commit step, synchronously, before the next commit starts. Durable's storage interface
carries it as a new required argument:

```ts
commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq>;
```

Every storage calls `adopt(seq)` once its commit is durable and before its next commit. The Session catches its own
adoption errors; a rejection after adoption fails the Session without discarding the adopted changes.

## Adopt and mark in the step, flush right after (W1)

The step itself stays short: it writes, adopts (pointer swaps of every changed value, including Durable's views the
commit touched) and **marks** (dependent derives dirty, ops appended by reference to each touched hold's batch and each
watch's queue). Right after the step, synchronously and before any other code runs, the committing owner **flushes**:
it recomputes the dirty derives someone holds or watches, encodes one part per touched hold into one message per link,
and queues watch callbacks. So a source and the derives over it always travel in one message; a throwing derive fails
only its own member, never the commit.

```
step 40:  write · adopt notes · mark count dirty, notes' ops into tab 1's batch
flush 40: count = 3 → its ops join the batch · ONE message to tab 1 { notes: +1, count: 3 }
step 41:  write · adopt Durable's view · mark lastReply …
```

Watch listeners run afterwards, each in order; their order across owners may differ from the seq, but every listener
reads a complete prefix of the log.

## When a commit counts as done (S3)

The step ends only on the backend's terminal success: SQLite's `COMMIT` returned (with an asynchronous backend, the
transaction's final completion event, not its individual requests). Any backend error in the step stops the store
(`storage_failed`, Durable's rule): an ambiguous `COMMIT` cannot be told from a failed statement, so nothing more is
written or published.

:::review | Review: request success is not commit completion
Astra's trace: IndexedDB reports the puts of seq 40 successful, the store publishes 40, the transaction aborts later
(quota), 50 commits on top: memory has 40, disk does not. The rule above is the answer.
:::

## Ids

Each owner's id counter starts, when the store opens, above that owner's highest stored id: one index lookup per table
(S10). Chord's document ids are assigned in the commit step; for Durable's `mintId` (6b), an id handed out to a
transaction that never committed may be handed out again after a restart. Nobody can
notice, because nothing leaves a transaction before it commits (S2), so Durable's `mintId` contract is narrowed to say
exactly that.

# Reading {#reading lede="A small query language, one text order on every backend, and cursors."}

Queries are immutable data built in TanStack DB's style; S12 starts without joins, grouping and projections:

```ts
query(Edits).where((e) => eq(e.path, "src/app.ts")).orderBy((e) => e.at, "desc")
query(Edits).where((e) => and(gte(e.at, from), lt(e.at, to)))
query(Edits).where((e) => prefix(e.path, "a/"))
```

`where` takes `eq ne lt lte gt gte inArray isNull prefix and or not`. `limit` and the cursor are arguments of the
runner, not part of the query. `count(q)` is the one aggregate; others are computed in JavaScript over indexed scans
until a real case needs more.

## One text order

Text compares by Unicode code point on every backend (owner, 2026-10-26; this replaced the first design, UTF-16 BLOBs
in JavaScript order, S16 and W8). That is the order SQLite compares UTF-8 text in natively, and Durable Objects,
sqlite-wasm, Postgres (`COLLATE "C"`) and MySQL (`utf8mb4_0900_bin`) do too. Every `str()` column is plain UTF-8
`TEXT`: strings go to the driver and come back as they are, readable in `sqlite3` and in any other tool.

It differs from JavaScript's `<` and `sort()` in one range only: characters U+E000-U+FFFF (fullwidth forms such as
`～`, private use, U+FFFD) against characters above U+FFFF (emoji):

```
JS sort():    "测试😀" < "测试（一）"
store order:  "测试（一）" < "测试😀"
```

The store exports `compareText(a, b)` for plugins that sort store text themselves. Page with the store's cursors and use `prefix()`; a hand-built bound such as
`p + "\uffff"` misses every `p` followed by an emoji.

UTF-8 cannot hold a lone surrogate, so every `str()` value written, and every query operand, goes through
`toWellFormed()`: a lone surrogate becomes U+FFFD, as `TextEncoder` does. A string cut in the middle of an emoji by
`slice()` is stored with U+FFFD in its place; cut text with `[...s].slice()` to keep it whole. A `str()` value may not
contain NUL (`invalid/args`); content belongs in `json(...)` columns, which escape both. There is no Unicode
normalization: "é" written as one code point and "e" plus a combining accent are two keys.

| 100k path-like keys | UTF-16 BLOB (the first design) | UTF-8 TEXT |
| --- | --- | --- |
| insert, one transaction | 125 ms | 113 ms |
| read | 106 ms | 32 ms |
| bytes of an 18-character ASCII path | 36 | 18 |

## Running queries

A query is immutable data; the table handle runs it, and the context comes last:

```ts
const edits = self.table(Edits);
const byPath = query(Edits).where((e) => prefix(e.path, "src/")).orderBy((e) => e.path);

const page = await edits.page(byPath, 100, ctx, { after: cursor });   // { rows, next? }
for await (const row of edits.rows(byPath, ctx)) { … }                 // all pages
const e1 = await edits.get({ id: "e1" }, ctx);                         // keys are objects of the key columns

await self.tx(async (tx) => {
  for await (const row of tx.rows(edits, byPath)) {                    // committed rows, stable during the tx
    tx.update(edits, { id: row.id }, { dir: dirname(row.path) });         // writes are synchronous, buffered
  }
  const again = await tx.get(edits, { id: "e1" });                     // sees this transaction's own writes
}, ctx);
```

Inside a transaction, `tx.page` and `tx.rows` return committed rows: a stable view, because only the owning object
writes its tables and its transactions run one at a time. They do not show the transaction's own writes; `tx.get` does.
The rule in one sentence: queries inside a transaction see the state before it; your own writes become visible after
the commit. After an `updateWhere` or `deleteWhere` on a table, `tx.get` on that table throws `read_after_bulk`
(W10): the store would need a second evaluator to know what a bulk operation did to one row.

## Cursors and consistent reads

Every index ends with the primary key, so order is total and cursors are stable. A cursor is opaque, carries its
direction and its last key as logical values, is bound to its query's order, and is refused by another query or the
other direction.

Reads outside a transaction see committed state, one query at a time. A read that needs several queries, like a
document assembled from its base and later revisions outside its owner's line (Durable's reads, 6b), runs in one backend
read transaction (S4); Chord's own loads run on the object's line and need none. Two separately
awaited reads in object code are not a snapshot, and the guide says so.

# Documents {#documents lede="One documents engine in the store, used by Durable's adapter and by Chord."}

Durable and Chord both persist documents the same way: a record per incarnation, revisions made of a base and later
deltas, versions, `checkpointWhen`, one live document per address. The store implements it once (S13):

```ts
type DocAddress = { namespace: string; owner: string; kind: string; key?: string };

interface Documents {                                   // reads, committed state
  find(address: DocAddress, at: At, context: Context): Promise<DocRecord | undefined>;
  load(id: number, at: At, context: Context): Promise<StoredDoc | undefined>;   // base + deltas, applied once
  list(query: DocListQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<DocRecord>>;
}
interface DocumentWrites {                              // inside the commit step
  create(record: NewDocRecord, base: BaseContent): number;
  change(id: number, content: DocContent): void;
  retire(id: number): void;
}
```

The `owner` string is opaque to the engine; each adapter fills it:

| | namespace | owner | kind | key |
| --- | --- | --- | --- | --- |
| Durable session document | `pi-durable` | `session` | `pi.settings` | |
| Durable conversation document | `pi-durable` | `conversation:7` | `pi.provider` | |
| Durable task document | `pi-durable` | `task:31` | `pi.codemode` | |
| Chord persisted document | `chord` | `session:notes.store` | `notes` | `n-42` |

What the owner string means (a conversation's documents fork and rewind with it, a task's are retired with the task)
stays in the adapter. The engine keeps nothing in memory; Durable's Session and Chord's objects keep their Delta
trackers, cache, pin and evict exactly as Durable does today. A fork's document copies are reconstructed by
`StoreStorage` before it enters the commit step (S11), so the step never replays revisions while every owner waits;
the outbox only ever carries the resulting documents.

# Writing Many Rows {#bulk lede="Bulk operations recorded as operations, and migrations that run only where the code is."}

A full-row put per changed row makes the rename of `a/` to `b/` over ten thousand 4 KB rows cost about 40 MB in the
outbox. The store's writes are therefore five:

| Write | Records |
| --- | --- |
| `tx.put(table, row)` | the whole row |
| `tx.update(table, key, set)` | the changed columns of one row |
| `tx.delete(table, key)` | the key |
| `tx.updateWhere(table, where, set)` | one operation, plus the affected row count |
| `tx.deleteWhere(table, where)` | one operation, plus the affected row count |

```ts
await self.tx((tx) => {
  tx.updateWhere(edits, (e) => prefix(e.path, "a/"), (e) => ({ path: replacePrefix(e.path, "a/", "b/") }));
}, ctx);
```

```sql
-- on SQLite: one statement; path is UTF-8 TEXT, "a/" is 2 code points
UPDATE "session:file-history.store:edits" SET path = :to || substr(path, 3) WHERE path >= :lo AND path < :hi
```

```
outbox, seq 57 (about 150 bytes):
{ kind: "updateWhere", table: "session:file-history.store:edits", where: { prefix: ["path", "a/"] },
  set: { path: { replacePrefix: ["a/", "b/"] } }, count: 10000 }
```

A replica runs the same operation, without plugin code, and compares the number of affected rows. A different number
means divergence: it stops applying that store and restores it from a snapshot. The `set` expressions touch only real
columns (plain values, or column references in a callback): `add`, `sub`, `max`, `min`, `concat`, `replacePrefix`,
`coalesce`, `when`. They are the store's
own, specified once and checked on every backend by one conformance suite, which is why there are no SQL subqueries,
joins, case folding or floats: each of those behaves differently somewhere.

## Migrations (S17)

Adding, renaming or dropping a column is a recorded table change (`alter`); a new column gets its default without a
bulk rewrite. A change of the shape **inside a `json(...)` column** (a field added, renamed, restructured) **migrates on
access** (W11): each `json(...)` column has its own version and a value-only migration,
`json(MetaV2, { version: 2, migrate: (old, from) => … })`, stored with its value; reading an older value migrates it,
writing the column stores the new shape and version. Nothing is rewritten in bulk and indexes are unaffected. The row's
`$v` counts only eager steps (below); `update`, `updateWhere` and `deleteWhere` never set it. Old code refuses a newer
table version or a newer JSON column version.

A change to a key or an indexed column must be **eager**, because an index over a column filled only on access would
silently miss rows. It runs when the owning object starts on the driver, before the object goes live:

```ts
const EditsV4 = evolveTable(EditsV3, (t) =>
  t.add("dir", str({ default: "" })).rows((row) => ({ dir: dirname(row.path) })).index("by_dir", ["dir"]));
const EditsV5 = evolveTable(EditsV4, (t) =>
  t.add("size", int({ default: 0 })).update({ where: (e) => lt(e.size, 0), set: { size: 0 } }));
```

Each version is its own materialized definition (as contracts' `evolve`), so a store at version 3 replays 4 and then 5,
each with exactly its own columns.

:::steps | Migration 4 on the driver
+++ The table change
Commit 80 records `alter: add column dir` and marks table version 4 as `migrating`. Every replica adds the column
from the record.
+++ The scan
The store reads rows with `$v < 4` in key order, 100 at a time (about 1 ms per commit step), applies `rows` to each and writes the changed columns
plus `$v = 4` in the same write. One commit per chunk, so other owners' commits interleave and the commit step stays
short. (A full-row `put` also sets `$v`; partial and bulk writes never do.)
+++ Ready
The last chunk marks version 4 `ready`. The store creates the `byDir` index and records it, and `FileHistoryStore`
goes live.
+++ After a crash in the middle
The next start finds `migrating`, scans again from the first key and skips rows with `$v >= 4`. Each row is
transformed exactly once, even when the transform is not idempotent. A key change is never a `rows` step: it is a
recorded `rebuild` that every replica performs itself.
:::

A replica, with or without the plugin, applies the recorded column changes and the column updates; it never runs a
migration itself. Chord documents keep their own per-document `migrate` on access, and
Durable versions its records itself.

# The Easy Parts {#easy lede="Blobs and derived data: why they need none of the store's ordering machinery."}

Two kinds of session data stay outside the store's tables, and both are easy for the same reason: nothing about them
ever changes in place. A blob is final once written; derived data has no data of its own.

## Blobs

Artifact versions, uploads and sent files are **blobs**: files in the session directory, named by the hash of their
content (`blobs/sha256/9f/9f3a…`), never changed. They are app layer, not store: any process may write one, because a
file named by its content cannot conflict with another writer. The order is the whole trick: the blob is written first,
then the row or document that names it.

:::sequence animate | Saving artifact "chart" version 3. The blob exists before anything refers to it.
actor tool "artifact tool"
actor blobs "blobs/" muted
actor store "store" blue
tool -> blobs: write sha256:9f3a… (tmp, fsync, rename)
tool => store: seq 41: chart.versions[2] = { blob: "sha256:9f3a…" }
tool => store: seq 42: entry 812 "chart v3 saved" (Durable)
:::

- **Export** copies `blobs/` together with the store snapshot. Every blob a record up to the export's `lastSeq` names was
  written before that record, so it is in the directory. **Import** copies them back and checks each hash.
- **Sync:** before uploading a batch, the sync layer uploads every blob file that is present and not yet uploaded. No
  reference tracking is needed: a blob is always written before the commit that names it, so a replica never sees a
  hash whose file is missing.
- **Deleting:** no blob is deleted before its session is deleted. A blob that nothing references any more (a crash
  between the write and the commit, a retired document) only costs disk; a garbage collector would have to know every
  reference in every table.

## Derived data

A full-text index, a cache, a plugin's own search database: **derived data** can be recomputed from the store and the
blobs, so it is never exported or synced. Its owner keeps it current with a routine that compares it with the store.
The artifacts plugin's full-text index in its own SQLite file:

```ts
host.serve(ArtifactStore, (_, self) => {
  const artifacts = self.state(Artifact);                         // keyed documents in the store
  const blobs = self.get(SessionBlobs, {});
  const index = self.open(async () => openIndex(join(dir, "derived/artifacts/index.sqlite")), (db) => db.close());

  self.onLive(async (ctx) => {                                     // the index repairs itself
    for await (const name of artifacts.keys(ctx)) {
      const a = await artifacts.get(name, ctx);
      if (a && index.value.versions(name) !== a.versions.length)
        index.value.put(name, a.versions.length, await blobs.read(a.versions.at(-1)!.blob, ctx));
    }
  });
  …
});
```

:::steps | One routine, three situations
+++ Normal save
`save` writes the blob, commits the document, then updates the index. The routine finds nothing to do.
+++ Crash after the commit
The process dies between the commit and the index update. The document says version 3, the index still has version 2.
On the next start the routine sees the difference, reads the blob of version 3 and indexes it.
+++ Import or sync
On the desktop `derived/artifacts/` does not exist. The routine finds every artifact missing and indexes them all from
the documents and blobs that came with the session.
:::

This routine visits every artifact on each start: fine for hundreds, slow for millions. A large derived store keeps
the last seq it applied and reads only what changed after it.

# Moving a Session {#sync lede="Outbox, replicas (no compaction yet), takeover, export and import."}

With an outbox (optional: a store opened with `{ outbox: true }`), every commit's writes go into it, written in the
same backend transaction as its data, so a crash keeps both or neither. Sync is a layer above the store; it follows Armin's transport and fencing with the rules the review added.

- **Uploading:** the driver may upload batches in parallel, resubmits each until Radius acknowledges it, and trims a
  batch from its outbox only after its acknowledgement (S5).
- **Applying:** every batch carries `from` and `to`. A replica applies a batch only when its `from` equals the
  replica's `lastSeq` (the seq of the last commit it applied), as a whole, in one backend transaction together with
  its new `lastSeq`. A later batch
  waits for a missing one. A crash leaves all of a batch or none of it.
- **No compaction at first (W9):** batches carry the ordered operations exactly as committed. "Keep the last write per
  row" would lose rows built from `put` plus partial `update`s; a later compaction must merge those and treat bulk
  operations as barriers.
- **After a power loss** the driver's local `lastSeq` may be behind what Radius has; it first pulls back its own uploaded
  batches, then continues (S3).
- **Blobs** go up before the batch that may name them: every blob file present and not yet uploaded (chapter VIII).

## Losing the driver role (S7)

:::sequence animate | The laptop learns the desktop took over. Nothing is rolled back.
actor laptop "laptop" "driver, epoch 3"
actor radius "Radius" blue
actor desktop "desktop"
desktop -> radius: take over S1
radius => desktop: epoch 4
laptop -> laptop: commits 40, 41 locally (a routine, a late tool result)
laptop -> radius: upload 40–41 (epoch 3)
radius --> laptop: refused: epoch 4
laptop => laptop: the copy becomes session S1′ (new id)
note laptop..desktop: S1 continues on the desktop; S1′ on the laptop; they never sync again
:::

Rolling back is not possible: tools ran, files were written, natives and derived data followed the tail. The laptop's
copy becomes a separate session with a new id and keeps running; commits in flight land in it. The catalog shows both,
the split-off copy marked with its origin.

## Export and import (S4)

An export holds the commit queue while it reads, so the archive is the state after one seq, its `lastSeq`: Durable's records, Chord's
documents and every plugin table, including tables of plugins that are not installed, plus the session directory's
blobs (chapter VIII). The archive is written in the outbox's own operations (a manifest, `table`, `index`, `put` and `document.create`
records, an `end` record), as one batch from 0 to its `lastSeq`, so an import is applied by the same code as a
replica's batches. An import restores the archive into a fresh store in one transaction; the server then mirrors the
session into its catalog. The encoding is pluggable (the store yields and takes records); plain JSONL ships first.
Derived data (full-text indexes, caches) is never exported; it is rebuilt where it is needed.

# Rules for Plugin Authors {#rules lede="What the store does not do for you."}

**Nothing leaves a transaction before it commits (S2).** Ids are handed out inside the transaction that creates them.
Reference what is committed: the file-history plugin references the tool-call entry, which is committed before the tool
runs, never the tool-result entry, which does not exist yet.

**Work that finishes out of order is yours (S8).** A routine that starts a slow job per change can let an old result
overwrite a newer one. The handler calls of one routine never overlap, so either chain through the routine or drop
stale results inside the destination's transaction:

```ts
self.on(conversation.entries, async ({ value: entries }, ctx) => {
  const run = await summarize.start({ upTo: entries.at(-1)!.id }, ctx);
  await run.outcome(ctx);                                  // the next handler waits for this run
});
```

**Text compares by code point.** Do not sort keys yourself to page through a table; use the store's cursors, or
`compareText`. Normalize text yourself if two spellings must be one key.

**Bulk changes are operations.** Prefer `updateWhere` and `deleteWhere` over loops of puts; a loop records every row.

# What's Next {.epilogue lede="What is decided, and the order in which it gets built."}

The direction and all seventeen review items are decided (decision log, 2026-10-21). The store is new code; the parts
outside it are small changes in pi:

- **pi, one change:** `Storage.commit(writes, adopt, context)` with every storage calling `adopt` (S1), the
  Session's handling of rejections after adoption, the narrowed `mintId` comment (S10), `traceIn(options, fn,
  context)` (context last), Durable's `WatchHandle`/`WatchEnd` moved into Chord with generic end reasons and explicit
  retirement (W2), and Durable's state getters and the `replicatedState` family removed (W14).
- **The store** in `packages/chord/src/next`: commit step and outbox, tables and the query language, the SQLite
  backend with the text encoding, the documents engine, bulk operations and migrations, export and import;
  about 1,650 lines by Fable's estimate, plus its tests.
- **`StoreStorage`**, passing Durable's existing storage conformance suite.
- **The sync layer** (upload, apply, pull-back, epochs, splitting a session) on top, when Radius sync is built.

Open, to settle while building: how a split-off session gets its new id (store metadata, directory, catalog), and a Postgres backend once a serverless target needs one (W14).

# Decisions {.appendix}

| # | Decision |
| --- | --- |
| The store | one transactional store per session under Durable (adapter), Chord documents and plugin tables |
| S1 | adoption inside the commit step; `Storage.commit(writes, adopt, context)` |
| S2 | nothing leaves a transaction before it commits; no mechanism |
| S3 | a commit is done on the backend's terminal success; ambiguous outcomes stop the store; pull-back after restart |
| S4 | export holds the commit queue; multi-query reads in one read transaction; no global snapshots |
| S5 | parallel uploads, resubmit until acknowledged, trim after acknowledgement; apply whole batches in order |
| S6 | (superseded by W9) |
| S7 | losing the driver role splits the session; no rollback |
| S8 | out-of-order work is an app concern; routine handlers never overlap |
| S9 | `lastSeq` (the seq of the last commit) is persisted with every commit |
| S10 | id counters derived at open; `mintId` contract narrowed |
| S11 | fork copies reconstructed by `StoreStorage` before the commit step |
| S12 | the query language starts without joins, grouping and projections |
| S13 | one documents engine in the store, opaque owner |
| S14 | one transaction API, `self.tx(fn, ctx)` |
| S15 | Durable's existing storages are kept |
| S16, text | real tables; text as plain UTF-8 in code point order (replaced W8's UTF-16 BLOBs) |
| S17, W11 | five writes, bulk operations recorded with a row count; JSON columns migrate on access with their own version; eager steps by scan with row `v` |
| W1 | adopt and mark in the commit step, one synchronous flush right after (derives, wire, watches) |
| W6, W7 | workers connect before loading; store addresses carry the host kind, never an instance |
| W9, W10 | no compaction at first; no `tx.get` on a table after a bulk operation in the same transaction |
| W14 | no IndexedDB backend (SQLite in WebAssembly in the browser); no `replicatedState` |
| index definitions | recorded in the outbox and applied by every replica; contents never travel |
| blobs, derived data | blobs are app-layer files named by hash, written before what names them, uploaded before each batch, deleted only with the session; derived data is rebuilt, never shipped |

# Glossary {.appendix}

**Adoption:** an owner updating its in-memory state to a committed write. **Blob:** a file in the session directory
named by the hash of its content, never changed. **Derived data:** data recomputed from the store and blobs, never
shipped. **Backend:** what the store runs on (SQLite,
memory). **Write:** one change of the store (`put`, `update`, `updateWhere`, `table`, `document.create`, …), the same in the
outbox and in an archive. **Commit** (in the outbox): the writes of one seq. **Batch:** the commits from `from` to `to`,
uploaded and applied as a whole. **Archive:** a manifest, the writes from 0 to `lastSeq`, and an `end`.
**Commit step:** the short, serialized part of a commit in which the store checks, writes, numbers and records it, and
owners adopt. **Driver:** the machine that writes a session. **Line:** the serialization of one owner's transactions
(per Chord object, per Durable Session). **Outbox:** the record of every commit, written in the same transaction.
**Owner:** the code that writes a piece of data. **Replica:** a copy of a session that applies the driver's batches.
**Seq:** the number of a commit, one sequence per store. **Store:** the transactional store of one session.
**Table:** a set of rows owned by one object, with a flat record of typed columns (scalars or `json(...)`).
