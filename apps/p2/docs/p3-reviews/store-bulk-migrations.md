# The store: bulk operations and migrations (S17, proposal)

Status: **decided (owner, 2026-10-21; decision log "S17")** with these changes: no JSON-field operands and no `json.set`/`json.remove`; per-row column updates are `tx.update(table, key, set)` records; JSON-part changes migrate on access; migration steps are `update` (one `updateWhere`) or `rows` (scan + `tx.update` in chunks). Builds on the decided store (decision log "The store",
S1-S16): real tables, keys and indexed columns typed text or integer, the rest of a row in a JSON column `row`; text in
JavaScript order (SQLite: UTF-16BE BLOBs for key and indexed text); every write goes through one commit step and is
recorded in the outbox; replicas apply records without plugin code; migrations run only where the owning code runs.

## 1. Problem

Two kinds of writes touch many rows at once, and recording them as one full-row put per row is expensive:

```
rename a/ → b/ over 10,000 edits of ~4 KB      → 10,000 puts, ~40 MB in the outbox (S17, Astra)
v2 of Edits adds `size` (default 0)            → every row rewritten: same cost
retire a document's 300 revisions              → 300 delete records
```

And a migration of a large table inside one commit would hold the commit step (every owner's commits) for its whole
duration.

## 2. Bulk operations: recorded as operations, executed by the store on every replica

```ts
await self.tx(async (tx) => {
  await tx.updateWhere(Edits, (e) => prefix(e.path, "a/"), { path: replacePrefix("a/", "b/") });
  await tx.deleteWhere(Revisions, (r) => eq(r.document, docId));
}, ctx);
```

Outbox:

```
{ seq: 57, ops: [
  { op: "update", table: "file-history/edits", where: { prefix: ["path", "a/"] },
    set: { path: { replacePrefix: ["a/", "b/"] } }, count: 10000 },
  { op: "delete", table: "pi-durable/revisions", where: { eq: ["document", 41] }, count: 300 } ] }
```

- `where` is the query DSL's predicate (S12 scope); `set` takes values or expressions from a fixed set:
  `value`, `add(n)`, `max(v)`, `min(v)`, `replacePrefix(from, to)`, `concat(…)`, `coalesce(v)`, and for the JSON part
  `json.set(path, expr)`, `json.remove(path)`.
- Deterministic by construction: only the store's own expressions, applied to the same prefix of the log. A replica
  executes the operation itself (compiled to one SQL `UPDATE`/`DELETE` on SQLite, a loop on the memory backend), no plugin
  code.
- `count` (rows affected on the driver) is recorded; a replica that affects a different number stops applying that
  store and restores it from a snapshot (divergence is loud, not silent). One integer per operation.
- Cost: the 10k-row rename is ~150 bytes in the outbox instead of ~40 MB; one SQL statement on each side.
- Not expressible (arbitrary JS per row): the plugin reads, computes and `put`s rows (full rows, as today).

## 3. Table changes (recorded, rendered by the store)

```
{ op: "table", table: "file-history/edits", version: 1, key: ["id"],
  columns: { id: "text", path: "text", entry: "int", at: "int" } }          // create; non-indexed fields live in `row`
{ op: "alter", table: "file-history/edits", version: 2,
  add: { size: { type: "int", default: 0 } } }                               // ALTER TABLE ADD COLUMN ... DEFAULT 0
{ op: "alter", …, rename: { at: "time" } }  { op: "alter", …, drop: ["entry"] }
{ op: "drop", table: "file-history/edits" }
```

- Only key and indexed columns are real columns; adding, removing or renaming a field in the JSON part changes no table.
- Changing a key or a column's type is a table rebuild: the store records `{ op: "rebuild", … }` and does it as
  create-copy-drop-rename on every replica (no rows in the outbox).
- Indexes are not recorded: each host creates the indexes its code declares (S-decided: local).

## 4. Migrations

```ts
const Edits = defineTable("edits", {
  version: 3,
  schema: obj({ id: str(), path: str(), entry: int(), time: int(), size: int(), meta: json(MetaV3) }),
  key: ["id"],
  indexes: { byPath: ["path", "time"] },
  migrations: {
    2: { alter: { add: { size: { type: "int", default: 0 } } } },                       // table change only
    3: { alter: { rename: { at: "time" } },
         update: { set: { meta: json.set("$.source", value("agent")) } } },              // bulk op, no row function
    // 4: { rows: (row) => ({ ...row, meta: rebuild(row.meta) }) }                      // arbitrary JS: full-row puts
  },
});
```

- A migration is a list of steps per version: table changes, bulk operations, and only when nothing else fits a row
  function (`rows`), which becomes full-row puts.
- Runs eagerly when the owning object activates, on the driver, before the object goes live (a readiness gate: calls
  wait, as for any activating object). Old code finding a newer table version refuses to open it, data intact (as R15).
- Large row-function migrations run in chunks of N rows per commit, so the commit step stays short for other owners;
  the table's version record moves `migrating → ready` around them. A replica without the plugin just applies the
  chunks; a replica with the plugin's code treats the table as not ready until `ready`.
- Chord documents keep their own per-document `migrate` on access; Durable versions its records itself. Table
  migrations are for tables only.

## 5. What it costs and adds

- The store gets an expression evaluator twice (SQL compiler, memory backend), checked by one conformance suite;
  about 300 lines (estimate).
- The DSL grows by `updateWhere`/`deleteWhere` and the `set` expressions; no change to queries.
- SQLite specifics stay inside the backend: `replacePrefix` on a UTF-16BE BLOB column is a byte prefix of
  `2 × length(from)`; `json.set` uses SQLite's JSON functions on the `row` column; the memory backend does the same in JS.

## 6. Open questions (one at a time)

1. Bulk operations recorded as operations executed on every replica, with a row count check (above), or resolved to
   per-row records on the driver (simple replicas, large outbox)?
2. The expression set for `set`.
3. Migrations: eager with a readiness gate and chunking (above), or lazy per row for changes to the JSON part only.
