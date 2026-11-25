# Documents and table rows belonging to a host (spec)

Builds the decision "Documents and table rows can belong to a host" (`decisions.md`, 2026-11-09). Context: p3's
session data on the server (`apps/p3/docs/decisions.md`, last entry; `status-2026-11-09.md` §6).

**Problem.** p3 keeps facts about a session on the server (title, pin, a channel binding) because they are needed
while the session's worker is off. They must travel with the session: `exportData(Session({ id: "S1" }))` must carry
them, `importData` must bring them back, a delete must remove them. Today nothing in the server's store says which
records and rows are about `S1`; a string key `"S1"` could be anything.

**Solution.** A document key or a table cell can be an address of a host kind. The store records the address key in
an indexed `host` column (documents) or in the table's one host column, so it can export, import and delete exactly
the data belonging to one address. Plugins write no export code.

## 1. Documents keyed by a host kind

```ts
const Meta = defineState("session-meta", {
  schema: obj({ title: str() }), version: 1, initial: () => ({ title: "" }),
  keyed: Session,                        // a host kind; `true` keeps string keys
  persist: true, checkpointWhen: () => true,
});
const meta = self.state(Meta);           // KeyedHandle<{ title: string }, Address<typeof Session>>
await meta.change(Session({ id }), (d) => { d.title = "x"; }, ctx);
for await (const address of meta.keys(ctx)) …           // addresses, decoded from their keys
self.tx(async (tx) => (await tx.draft(meta, Session({ id }))).title = "y", ctx);
```

- `defineState`'s `keyed?: true | HostKind`. `StateDefinition<T, K, P>` takes `K extends boolean | KindShape`;
  `definition.keyed` stays `boolean` (true for both), new `definition.host: HostKind | undefined`.
- `KeyedHandle<T, Key = string>`: `get`, `keys`, `watch`, `at`, `change`, `retire` take/yield `Key`. `HandleOf<D>`:
  `keyed: true` gives `KeyedHandle<T>`, `keyed: K` gives `KeyedHandle<T, Address<K>>`. `Tx.draft`/`Tx.retire` take
  `KeyedHandle<T, Key>` and `NoInfer<Key>`.
- A handle of a host-keyed definition takes **only addresses of its kind** (a trust boundary for JavaScript callers):
  a string (the empty string and an omitted key included: every keyed entry point, `tx.draft` and `tx.retire` too, goes
  through `slot.key(slot.keyOf(key))`; singleton slots ignore it), another kind or params that do not fit the kind's
  field types are `invalid/args`.
- **The canonical stored address key** (`keyOfAddress`): for an address a plugin hands in (a document key, a
  `host(...)` cell or operand, a keyed member's key) computed from the params (`addressKey`), never taken from its
  `.key`; the host data calls (export and delete selection, an import's copy target) take `address.key` as it is. Both
  then go through the `str()` text rules (`storedText`: a lone surrogate becomes U+FFFD, NUL is refused
  `invalid/args`). The same key is a document's key in memory and in the store, a `host(...)` cell, a record's `host`
  and the host-data selection. `keys()` decodes each stored key back into an address (`addressOfKey`: split the
  escaped key, `int()` fields to numbers, `bool()` fields to booleans; a key of another kind or number of parts
  throws). Decoded keys are not re-validated (owner, review round 2: no overzealous checks).
- A persisted host-keyed document's record gets `host = key`; a string-keyed or singleton one `host = NULL`, so a
  string key can never pose as an address. **The discriminator is checked on every find and load:** a host-keyed
  definition finding a record with `host` NULL (or another `host`), or a string-keyed one finding a record with a
  `host`, fails its object `broken` ("stored with string keys; declared keyed by session: convert it explicitly"), as a
  flipped `keyed` does. No implicit conversion; a conversion is an explicit one-off migration in the store (§9).
- Re-declaring a name with another `keyed` kind (string to host, or another host kind) fails the attempt `broken`, as a
  flipped `keyed` does today (`SlotDefinition.check`).
- **Keyed members carry the key kind.** `keyed(schema, Session)` declares a local contract's keyed member keyed by
  addresses of `Session` (`keyed(schema)` keeps string keys). The kind's name is part of the member's normal form
  (`{ keyed: <schema normal>, key: "session" }`, only when present, so existing fingerprints stay). Types:
  `KeyedWatchable<T, Key>`; the implementation of a host-keyed member is a `KeyedWatchable<T, Address<K>>` (a
  host-keyed handle is one). A reference's keyed member (`ReferenceKeyed`) checks and encodes addresses with
  `keyOfAddress` before they cross the wire; the wire, the pins and the provider's slot use the canonical key. `evolve`
  takes `keyed(member, schema, kind?)` / `addKeyed(member, schema, kind?)`; a changed key kind is a change of the
  member, and `checkAccepts` takes only `"refuse"` for it (a value mapping cannot map keys).

## 2. Store schema version 3

```sql
ALTER TABLE chord_documents ADD COLUMN host TEXT;
CREATE INDEX chord_documents_host ON chord_documents (host) WHERE host IS NOT NULL;
```

Appended to `MIGRATIONS` in `store/schema.ts`; `STORE_SCHEMA` becomes 3. `DocumentRecord.host?: string`;
`createDocument`'s address may carry `host`; `insertDocument` writes it, every record read returns it. The archive's
`RECORD` schema takes `host: opt(str())`; `importStore` checks it as well-formed text. Archives keep `format: 1`; their
manifest says `schema: 3` (older code refuses them by the schema check).

## 3. The `host(Kind)` table column

```ts
const Labels = defineTable("labels", {
  version: 1,
  columns: { session: host(Session), label: str() },
  key: ["session", "label"],
});
tx.put(labels, { session: Session({ id }), label: "red" });
await labels.page(query(Labels).where((t) => eq(t.session, Session({ id }))), 50, ctx);   // rows read back as Address
```

- `host(kind)` (new file `store/host-column.ts`) returns a column schema whose values are `Address<K>`. Stored as a
  non-`opt` `TEXT` cell holding the address key; for the store engine it is a `str` column (SQL, applier, evaluator,
  export need no new type). Its `ColumnRecord` is `{ type: "str", host: "<kind name>" }`; the `table` write and the
  catalog carry `host`, so the table fingerprint includes it (archive `column` schema: `host: opt(str())`).
- Rules (declaration errors): at most one host column per table; never `opt(...)`; no default. It may be a key column
  and an index column (`OrderColumn`, `KeyOf` give `Address<K>` for it).
- **Indexed automatically:** the definition adds the index `host` over the column unless the key starts with it (the
  primary key already covers it). A declared index named `host` is refused unless it is exactly that index (an
  `evolveTable` carries it over that way). Added by `defineTable` (or a new base) only: `evolveTable`'s `add` refuses a
  host column (no default); a `drop` drops its index; a `rename` renames the index's column.
- Values: `put`, keys, `set` and comparison operands take addresses of the column's kind, stored as the canonical key
  (§1, text rules included); reads decode keys into addresses. `eq`, `ne` and `inArray` compare host columns; `lt`/`lte`/`gt`/`gte`/`prefix`, `isNull`
  and expressions over a host column are refused `invalid/args`.
- The applier checks a recorded `host` only on a non-`opt` `str` column without a default, at most one per table.

## 4. Store operations (`store/host-data.ts`)

Public (`store/index.ts`), read-only:

```ts
exportHostData(store: Store, address: Address, context: Context): AsyncIterableIterator<ArchivePart>;
readHostArchive(parts: AsyncIterable<unknown> | Iterable<unknown>, context: Context): Promise<HostArchive>;
```

Internal, called only by the host's coordination (§5; the host's `importHostData`/`deleteHostData` are the public
way):

```ts
importHostData(store: Store, archive: HostArchive, plan: HostImportPlan, commit: HostCommit, context: Context): Promise<HostDataCounts>;
deleteHostData(store: Store, key: string, commit: HostCommit, context: Context): Promise<HostDataCounts>;
// plan: { target, existing, histories }; commit: { fence, after } (the host's fence and its reads in the step)
```

The host's options and result:

```ts
type HostImportOptions = {
  readonly address?: Address;                   // a copy under this address; default the archive's
  readonly existing?: "refuse" | "replace";     // default "refuse"
};
type HostDataCounts = { readonly documents: number; readonly rows: number };   // created or retired, put or deleted
```

**Export** (`export.ts`'s `StoreExport` with a selection `{ kind: "all" } | { kind: "host"; key }`): the existing
format, holding the commit queue as `store.export` does. Manifest with `host: <address key>` (new optional manifest
field; `importStore` refuses a manifest with `host`). Then, per recorded table with a host column (by SQL name), its
`table` write, the `put`s of rows whose host cell is the key (key order, pages of 100), its `index` writes. Then the
records with `host = key` (by id) as `document.create` without a base, each followed by its kept revisions. `end`.

**Read** (`readHostArchive`, a trust boundary): every part checked by the archive schema (`checkPart`), in order:
manifest (`format` 1, `schema` up to ours, `host` present, well-formed text), table groups, documents, `end` with the right count. Every table has exactly one host
column; every `put`'s host cell, every record's `host` and key equals the manifest's `host`; records are live, history
`none` (Chord's), well-formed text; revisions start at a base, deltas at its version. Each record's value is folded
(base plus deltas) once. Held in memory: one archive is one commit.

**Public surface.** Only `exportHostData` and `readHostArchive` are store functions apps may call (both read-only).
Import and delete change data live objects hold, so they are reached only through the host (§5); the store-level
`importHostData`/`deleteHostData` are internal (not exported from `store/index.ts`, not on `Store`); the host calls
them inside its coordination (§5).

**Import** into a store that may hold data (one commit through the commit queue, recorded in the outbox as ordinary
writes, so sync and backups see it):

1. Target key = `options.address?.key ?? archive.host`; another kind than the archive's is `invalid/args`.
2. `existing: "refuse"`: any record with `host = target` or any row with the target in a host column of the target's
   kind refuses the commit `invalid/args` ("… has data; import with existing: replace"). `"replace"`: those records are
   retired (`document.retire`) and those rows deleted (`deleteWhere`, counted) first, in the same commit.
3. Tables (the archive's metadata is not compared: a fingerprint is public, no security boundary; owner, review
   round 2):
   - **Not recorded here:** created from the archive's `table` and `index` writes (applier-checked); its rows put as
     recorded. Its owner's activation later checks and migrates it as for every table.
   - **Recorded here at the archive's version, both `ready`:** the rows are merged as they are.
   - **Recorded at a newer version, or the archive's table `migrating` (an export taken during an eager migration):**
     the rows are migrated in memory before the merge (below). An archive table newer than the recorded one, or a
     recorded table that is itself `migrating`, is refused `invalid/args`.
   - Every `put`, after the migration and the copy's rewrite, must hold the target in the **recorded** table's own host
     column (never the archive's); otherwise `invalid/args`. Each `put` is checked by the applier against the recorded columns; a row whose primary
     key exists already (another address's row) refuses `invalid/args` instead of being overwritten.

   **Migration on import** (decision: imported content migrates as all data does). It needs the plugin's code, the
   table's `evolveTable` history: the host takes it from the live owner's declaration of the table (activating the
   owner, a `local` type with empty params served here, before the import enters its exclusive phase; not served or
   failing to activate: refused `invalid/args`). The archive's version `a` (in the history; a `migrating` one with a
   data step to resume) is brought to the recorded version `n`
   row by row, as the eager migration would: for each version `w` from `a` (only for a `migrating` archive table: its
   data step) or `a + 1` to `n`: the edits before the step (`rename` moves the cell, `add` puts its default or leaves
   it absent, `json` changes nothing), the data step for a row with `$v < w` (`rows`: the patch on the row decoded with
   the step's table, its result checked and set, `$v = w`; `update`: its `where` evaluated on the stored row, its
   `set` applied, `$v = w`), the edits after it (`drop` removes the cell). `json(...)` cells keep their recorded
   versions (they migrate on access); a cell a step sets takes the column's version at that step. The result is a
   `put` at `$v` as computed, never inferred.
4. Documents: one `document.create` per record with a **fresh id and seq** (the commit's), its folded value as base
   at the record's version and fingerprint, `host = target`. Versions are kept: migration happens when the owning
   object loads it, as for every document.
5. **Copy** (target differs from the archive's): host cells and records' `host` become the target key, and a record's
   `key` too when it equals the archive's key. Nothing else: addresses inside JSON values are not rewritten.

**Delete**: one commit retiring every record with `host = key` and running `deleteWhere(col = key)` on every table
whose host column has the address's kind (a delete of an address without data still takes a seq; its outbox commit
records the `deleteWhere`s with count 0).

## 5. Live owners (host API)

The store operations change data live objects hold in memory (resident and pinned keyed documents, live queries,
table rows a transaction is reading). The host is the only public way to import and delete:

```ts
interface Host<P> {
  exportHostData(address: Address, context: Context): AsyncIterableIterator<ArchivePart>;
  importHostData(parts: AsyncIterable<unknown> | Iterable<unknown>, context: Context, options?: HostImportOptions): Promise<HostDataCounts>;
  deleteHostData(address: Address, context: Context): Promise<HostDataCounts>;
}
```

**The host data gate** (`host/host-data.ts`, one per host): a reader-writer gate between host data operations
(writers, one at a time, in call order) and the load phase of every activation (readers): from `documents.hydrate`
through the persisted loads, table preparation and live query loads of an attempt (a first activation, a retry, a
reload's successor). An operation's turn holds one or more exclusive sections: an activation arriving during one waits
before its load phase, and a section starts only once the load phases under way finished. So no owner can load data of
the address during an exclusive section, and the set of slots and live queries cannot change under it; between
sections (an import activating an owner for its table history) activations run. Lines are taken only inside an
exclusive section, in identity order, by one operation at a time: no lock-order cycle between two operations, and a load
phase never waits for an operation that waits for it.

Trace of `importHostData(parts, ctx, { existing: "replace" })` for `Session({ id: "S1" })`:

1. Outside a batch; the archive read and checked (cancellable).
2. Wait for the operation's turn (cancellable), then exclusively (the load phases under way waited for first, so a
   reload's successor or an earlier operation that changed a table is seen): the archive's tables whose rows must
   migrate, against the catalog as it is now, and their histories from the live owners' declarations. An owner without
   one is activated (`get` of the served `local` type) between exclusive sections, and the section runs again; still
   without one, the import is refused. The owners it activated are released when the operation ends, however it ends.
3. In the same exclusive section: **affected owners**: owners of a table with a
   `host(...)` column of the kind (catalog and archive), owners of records of the target (store) and of the archive's
   records, and live objects with a persisted slot keyed by the kind. Their live objects' lines are taken in identity
   order (cancellable; an abandoned acquisition releases the line when it comes): no transaction of theirs runs, so no
   `tx.get` sees rows change mid-transaction.
4. Rows migrated (§4), writes staged. The commit's fence admits only while the caller's context is not aborted
   (`released` otherwise, nothing written); after admission the commit runs to its end. No guard against calls after
   `host.close()` (owner, review round 2): the store's own close refuses them.
5. **Inside the commit step**, after the writes: for every affected object, every host-keyed slot and the target key,
   the stored document is found and loaded through the step (it sees the commit's writes) and decoded by the slot's
   definition (version check, `migrate`, the discriminator); every live query over an affected table re-runs on the
   step. Nothing is adopted yet; a refused step adopts nothing.
6. **Adoption** (the fence's `adopt`, after `COMMIT`, in one `host.batch.commit`): each slot's key takes its new
   value (a root replacement for its watchers), its retirement (`retired` frame) or stays when its record did not
   change; each query adopts its run. Derives recompute once and each link gets one message (W1), as for an ordinary
   commit. A document its owner cannot read (a failing `migrate`) changes nothing in its slot (its references keep the
   value they had) and fails that owner `broken` explicitly (`fail`, after the batch); a
   failing query is a failed member as in a commit. Neither stops the others. Adoption is synchronous: no context of
   the caller's can cancel it.
7. Lines, gate and owner references released.

`deleteHostData` is steps 1, 3 to 7 (no migration). Export needs neither gate nor lines: it holds the commit queue. Without a store or
inside a batch the calls reject (`invalid/args`).

## 6. The kit

- `exportData(address, path, ctx)`: the server first writes `host.exportHostData(address)` as JSONL to a staging file
  beside `path`; the tar gets it as `server.archive` (after `store.archive`, before `files/`). A running worker packs
  it into its tar (`HostData.exportTo` takes `server`, the staging path); otherwise `packData` does
  (`packData(dir, manifest, server, path, ctx)`, `packStore(store, files, manifest, server, path, ctx)`). The kit's
  archive `ARCHIVE_FORMAT` becomes 2 (`server.archive` required; format 1 archives are refused). The server's part
  and the worker's part are taken at two points in time: no transaction spans two stores (accepted).
- `importData(archive, address, ctx, options?: DataImportOptions)` (`{ existing?: "refuse" | "replace" }`): the
  manifest's address must have `address`'s kind; a copy when `address` differs from the manifest's.
- `deleteData(address, ctx)` (new): refused while its worker runs.

**One commit, last, under the worker's lock** (owner, after the delta review: no journal, no commit marker). The
server's host data commit is the one commit and the last step; what precedes it is undone when anything fails before
it.

`importData`:

1. Unpack the archive whole into a staging directory beside the address's (`unpackStaging`: the store made, files
   restored, `server.archive` kept). Fallible; nothing changed yet.
2. With `existing: "replace"`, move the old directory aside (`<dir>.aside-<uuid>`).
3. Rename the staging directory into place.
4. The server's import (`host.importHostData(parts, ctx, { address, existing })`), the one commit, last.

If anything before (4) fails, or (4) refuses definitely, the renames are undone (the new directory removed, the old
one put back), staging is cleaned up, and the import rejects. If (4) rejects with an unknown outcome (the store stopped
during or after `COMMIT`: `unavailable/storage_failed`), nothing is undone: the import rejects saying so, the new
directory in place and the old one aside. After (4) succeeded, `server.archive` and the aside directory are removed
(best effort: a leftover is harmless).

`deleteData` (refused while the worker runs): the server's delete first (one commit), then the directory removed.

**Crash windows** (documented, not recovered automatically):

- An import crashing between (3) and (4): the new directory is in place without its server data (and the old one
  lies aside). Fix: run the import again with `existing: "replace"`.
- A delete crashing after the server's delete: the directory stays, an orphan nothing refers to. A repeated
  `deleteData` removes it (the server's part is gone already, so nothing is refused).
- A crash before (3), or during the unpacking: staging directories (`.chord-import-*`) are left beside the
  addresses' directories; they hold nothing anybody reads.

## 7. Tests (one file per source file; all exist)

- `contracts/host-kind.test.ts`: `addressOfKey` round trip (str, int, bool, oneOf, escaped `|` and `\`, no params,
  another kind refused); `keyOfAddress` refuses strings, another kind, missing, extra or mistyped fields, and recomputes
  a forged `.key`.
- `contracts/declare.test.ts`, `contracts/accepts.test.ts`: host-keyed keyed members (kind in the data and the
  fingerprint, an undeclared kind refused; a changed key kind only refused).
- `documents/definition.test.ts`: `keyed: Session` sets `host`; types; an undeclared kind refused.
- `documents/handles.test.ts`: a host-keyed handle's `change`/`get`/`keys`/`watch`/`at`/`retire` with addresses (in
  memory); strings, the empty string and an omitted key refused.
- `documents/slot.test.ts`: re-declaring with another key kind fails.
- `documents/keyed-slot.test.ts`: a host data change's documents read in the step (`readChanged`: absent, unchanged,
  present) and adopted (`adoptChanged`: a pinned key's creation and retirement, a resident's); a `failed` one leaves
  the resident and the pinned key at their previous (non-`initial()`) value.
- `documents/persistence.test.ts`: host-keyed records store `host = key`, string-keyed `NULL`; the discriminator.
- `host/members.test.ts`: a host-keyed member read by address through a same-host reference and pinned by
  `at(address)` in another factory, strings refused; a handle keyed otherwise refused.
- `store/store.test.ts`: a schema 2 store migrates to 3 with its records.
- `store/engine.test.ts`: `host` written, read, listed by host; the partial index.
- `store/host-column.test.ts`: the helper, encode/decode, the canonical key (lone surrogate, NUL), refusals.
- `store/table.test.ts`, `store/columns.test.ts`: one host column, no `opt`, the automatic index (and none when the
  key starts with it), a declared `host` index, fingerprint changes with the kind, key and row types.
- `store/rows.test.ts`, `store/expression.test.ts`: puts, keys, `stored`/`addressed`, set, `eq`/`ne`/`inArray` with
  addresses; order comparisons, `isNull`, `prefix` and expressions refused.
- `store/table-changes.test.ts`: the `tx.get` overlay of a host column. `store/applier.test.ts`: host column records.
- `store/export.test.ts`: the host selection. `store/import.test.ts`: `importStore` refuses a host archive.
- `store/host-data.test.ts`: export; import into an empty store, into one with data (refuse, replace), a copy under a
  new address (keys and cells rewritten, JSON untouched); another kind, an older table without its owner's history
  and a key collision refused; forged archives refused (no host, no end, no host column, a foreign host cell or record,
  another history, no base); a base with deltas folded; rows checked by the recorded host column (a moved host
  annotation); a `migrating` table without history refused; selection by the canonical key; import and delete off
  the public surface; delete and its outbox writes.
- `store/import-migration.test.ts`: rows through edits and `rows`/`update` steps with `$v` exact, stopping at the
  recorded version, a `migrating` archive resumed, a `json(...)` cell a step sets taking the column's version (an
  untouched one keeping its own), a version outside the history refused.
- `host/host-data.test.ts`: the gate (exclusive sections, turns passed on when given up); pinned keys, residents and
  live queries following an import and a delete in one batch (a derive sees one frame); an owner of a table only
  coordinated (`tx.get` stable); an abort before admission writing nothing; a cancellation after admission committing
  and adopting; an owner that cannot read an import failing alone; an older table migrated (its owner activated), a
  newer one refused; an activation (a view pinning the board's key) waiting during an import; a reload during an
  import, with a queued import seeing the table its successor migrated; activated owners released when the import is
  refused; no store.
- `node/app/archive.test.ts`: the server part packed and unpacked into staging; refusals leave nothing.
- `node/app/app.test.ts`: export, import (copy, refuse, replace) and delete carry the server's records and rows; the
  ordering (undone before the commit, kept after an unknown outcome, delete on the server first, an orphan directory
  removed by a repeated delete).
- Example `test/examples/66-host-data.ts`: a server document and table rows keyed by a worker host address travel
  with that host's export and import (Chord level: `exportHostData`, `importHostData` as a copy, the refusal,
  `deleteHostData`; the kit does the same per address).

## 8. Not changed

Durable's documents (never host-keyed), sync batches (the writes are ordinary), `Files` (its per-address index on the
server is not host-keyed; a later change can give it a host column).

## 9. Open points (also in `slices.md` "Carry-over")

- Converting stored string-keyed documents to host keys: an explicit one-off store migration (none built).
- Adding a host column to an existing table (`evolveTable` refuses: no default; a new base works).
- Migration on import needs the owner served on the importing host; a store without its owner's code refuses older
  tables.
