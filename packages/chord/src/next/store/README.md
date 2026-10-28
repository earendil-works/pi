# store

The store (slice 6a): one per host, opened by the app over a backend (SQLite: `chord/sqlite/node`, Durable Objects'
storage), holding the host's tables, persisted documents and outbox; one commit queue serializing only the commit
step; eager table migrations; export and import.

## For apps (`index.ts`)

```ts
import { defineTable, evolveTable, importStore, json, openStore, query, sqliteBackend } from "./index.ts";

const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), ctx, { outbox: true });
const host = createHost({ store, onError });          // one open host per store; the app closes the store after it

const EditsV1 = defineTable("edits", {
	version: 1,
	columns: { id: str(), path: str(), at: int(), done: bool({ default: false }), meta: opt(json(Meta, { version: 1 })) },
	key: ["id"],
	indexes: { by_path: ["path", "at"] },
});
const EditsV2 = evolveTable(EditsV1, (t) => t.add("dir", str({ default: "" })).rows((row) => ({ dir: dirname(row.path) })));

host.serve(History, (_, self) => {                     // a local type with empty params (P3)
	const edits = self.table(EditsV2);                 // created or migrated at activation
	const q = query(EditsV2).where((e) => prefix(e.path, "src/")).orderBy((e) => e.at, "desc");
	return {
		add: async (row, ctx) => self.tx(async (tx) => tx.put(edits, row), ctx),
		list: async ({ after }, ctx) => edits.page(q, 50, ctx, { after }),
	};
});

for await (const part of store.export(ctx)) write(part);              // or encodeJsonl(store.export(ctx))
const copy = await importStore(sqliteBackend(db), decodeJsonl(bytes), ctx);
```

- `openStore(backend, ctx, { outbox? })`: the store's own schema migrations, a UTF-8 check, the metadata read once;
  `outbox` turns the outbox on (from the current `lastSeq`) or off; omitted, the stored setting stays. A failure
  closes the backend. `store.lastSeq`, `store.outbox` (`read(afterSeq, limit, ctx)` from its floor, `trim(throughSeq, ctx)`),
  `store.close(ctx)` (idempotent; waits for a running step; `ctx` ends only the caller's wait).
- `defineTable(name, { version, columns, key, indexes? })`: flat columns of `str int num bool`, `opt(...)` of them,
  `json(schema, { version, migrate? })` (one JSON cell, migrated on access); defaults; a key and index columns of
  non-`opt` `str`/`int`. `evolveTable(prev, (t) => t…)` appends the next version: `rename`, `add`, `json` before an
  optional data step (`rows(fn)` or `update({ where?, set })`), `drop`, `index`, `dropIndex` after it.
- Queries: `query(Table).where((t) => cond).orderBy((t) => col, dir)` with `eq ne lt lte gt gte inArray isNull prefix
  and or not` (SQL's `NULL` rules); pages `{ items, next? }` with opaque cursors, `rows()` paging by 100, `count`.
- Writes in `self.tx`: `put` (an upsert), `update(key, set)`, `delete(key)`, `updateWhere(where, set)`,
  `deleteWhere(where)`; a `set` is values or expressions (`add sub max min concat replacePrefix coalesce when`); key
  columns never change. `tx.get` sees the transaction's own single-key writes, not after a bulk one (W10).
- Text is UTF-8 compared by code points (`compareText`); NUL is refused, lone surrogates replaced.
- `store.export(ctx)` holds the commit queue from its first `next()` until it ends, is closed or `ctx` aborts; parts:
  the manifest, per table its `table` write, `put`s and `index` writes, the live documents, `end`. `importStore`
  checks every part (a trust boundary) and applies the archive in one backend transaction; JSONL via `encodeJsonl` and
  `decodeJsonl`.

## For adapters (`../index.ts`, marked internal)

Durable's `StoreStorage` keeps its records in the store: `StoreOwnerTables` declares and prepares an owner's tables
(claimed, `"<owner>:<table>"`), `OwnerTable` encodes rows at staging, writes them in a step (`put`, with a step-stamped
column) and reads them through queries compiled once (`prepare`, `prepareFirst`, `prepareGet`, `reader`); the documents
engine's writes (`insertDocument`, `writeContent`, `retireRecord`) and reads at a point (`findDocument`, `loadContent`,
`listDocumentEntries`, …); `store.commitInBatch` adopts in the attached host's batch; `store.mintId()` and `store.ids`
are the one allocator (D3); `store.claims` holds what can collide; `store.readTransaction` reads several queries at one
state. A step's own error is a refusal (the commit rejects with it, the store goes on); `refusalOf` classifies it for
Chord's owners. `applyBatch(store, commits, ctx)` replays outbox commits (the sync layer's entry point): refused at its
call and at its turn while an owner holds a claim or once the store diverged, and no claim is taken while it applies.

## For Chord's layers

`ChordStore` (`store.ts`: `commit(staged, fence, ctx)`, `read(fn, ctx)` guarded as Durable's `GuardedStorage`,
`take()` for an export, the catalog), the commit `Step` and `StagedWrite`s in their `WriteOrder` (`step.ts`), the documents engine
(`engine.ts`), the catalog (`catalog.ts`), the write vocabulary (`writes.ts`, `table-writes.ts`), rows and columns
(`rows.ts`, `columns.ts`, `json-column.ts`), the compiled where/set vocabulary (`expression.ts`) and its JS evaluator (`evaluate.ts`),
SQL (`sql.ts`), the table handle and a transaction's table changes (`table-handle.ts`, `table-changes.ts`), table
histories and migrations (`table.ts`, `table-evolve.ts`, `table-history.ts`, `table-migration.ts`), the outbox
(`outbox.ts`), archives (`archive.ts`, `export.ts`, `import.ts`, `applier.ts`, `jsonl.ts`), the store's SQL schema
(`schema.ts`) and backends (`backend.ts`).

Tests: `test/next/store/` (one file per source); the benchmarks in `test/next/bench/store.ts` (results in
`docs/next/benchmarks.md`). Examples: `20-tables.ts`, `22-migrations.ts`, `25-export-import.ts`.
