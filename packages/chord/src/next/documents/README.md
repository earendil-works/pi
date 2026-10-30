# documents

Documents: definitions, the handles an object's attempts get, the object's documents (in memory, or persisted in the
host's store), keyed watches and `at(key)`, retirement, and transactions over documents, tables and job runs.

## For apps (`index.ts`)

```ts
import { defineState } from "./index.ts";

const Notes = defineState("notes", { schema: obj({ list: arr(Note) }), version: 1, initial: () => ({ list: [] }) });
const Drafts = defineState("drafts", { schema: obj({ body: str() }), version: 1, initial: () => ({ body: "" }), keyed: true });
const Prefs = defineState("prefs", {
	schema: obj({ theme: str() }), version: 2, initial: () => ({ theme: "light" }),
	migrate: (old, from) => ({ theme: "light" }),          // a stored or in-memory value of an older version
	persist: true,                                          // in the host's store (a local type with empty params)
	checkpointWhen: (value, ops, { deltasSinceBase }) => deltasSinceBase >= 50,   // store a new base, not a delta
});

const notes = self.state(Notes);   // a singleton: a Watchable, `initial()` until written
const drafts = self.state(Drafts); // keyed: get(key, ctx), keys(ctx), watch(key, ctx), at(key) in the factory
const pinned = drafts.at("c1");    // a Watchable of one key (a state member, a derive or `on` source)
await self.tx(async (tx) => {
	(await tx.draft(notes)).list.push({ text });
	(await tx.draft(drafts, "c1")).body = text;
	tx.put(edits, { id, path });     // tables (`store/`) in the same commit
}, ctx);
await drafts.change("c1", (draft) => { draft.body = ""; }, ctx); // one-document shorthand
await notes.retire(ctx);           // back to initial(), watches get `retired: true`
```

- `defineState(name, { schema, version, initial, keyed?, migrate?, persist?, checkpointWhen? })`: the root is a JSON
  object. `initial()` is checked against the schema once, when the declaring definition is first used (retaken only
  when the declaring version or fingerprint changes). `persist: true` requires `checkpointWhen` (types and
  declaration) and a `local` type with empty params with a store on its host (P3).
- Singleton handle: `value`, `watch(ctx)`, `change(fn, ctx)`, `retire(ctx)`. A retirement reaches watches as
  `initial()` with ops `[["r", initial]]` and `retired: true`; a retirement and a recreation in one transaction are one
  root replacement, flagged.
- Keyed handle: `get(key, ctx)` (`undefined` when absent), `keys(ctx)` (code point order), `watch(key, ctx)`
  (`undefined` when absent; it follows the address through retirements and recreations), `at(key)` (in the factory
  only: `initial()` while absent, loaded before the object goes live, pinned until the next attempt's factory
  returned), `change(key, fn, ctx)`, `retire(key, ctx)`. A persisted key is loaded on its first read on the object's
  line (one load per key, shared by its readers), cached while read, pinned or watched, and evicted after ten
  minutes idle; an absent key is not cached.
- `Tx`: `await tx.draft(handle, key?)` (the same draft for the same document within one transaction; a cold persisted
  key loads first), `tx.retire(handle, key?)` (a no-op when absent), `tx.start(job, args, { key? })` (`jobs/`), and
  the table writes and reads of `store/` (`put`, `update`, `delete`, `updateWhere`, `deleteWhere`, `get`, `page`,
  `rows`). Every `tx.*` that returns a promise must be awaited before the callback returns.

Rules:

- Documents belong to their object, not to an attempt: a retry or a native restart keeps them, a new attempt's
  `self.state` gets handles to the same documents (an old handle below the slot's version is refused
  `released/version`). Persisted documents load once per object. An ending attempt's handles are sealed: they read
  synchronously, anything taking the line is refused `released` (a cold read queued before the seal too); its open
  transaction is discarded (drafts aborted, its callback's result rejected `released/discarded`).
- An object's transactions run one at a time on its line. A transaction covers only its own object. An in-memory-only
  transaction commits synchronously in Chord's batch; one with a persisted document or a table write enters the
  store's commit step, and once admitted it is adopted whatever happens to its attempt.
- When the callback resolves, an aborted `ctx` or an ending attempt discards the transaction; a throw discards it too.
  Unchanged drafts commit nothing. Drafts are revoked once the transaction settles: return plain values, read data
  from the handle after the commit.
- Inside the callback: only `await tx.*`; no second `self.tx`, no calls to other objects (not detected: it hangs).
- The shorthands `handle.change` and `handle.retire` run on the object's line from anyone holding the handle. That
  only the object writes them is a convention, like the rule for `tx.draft`: keep handles inside the owner.
- A stored document of a newer version, a `migrate` that throws or returns a value outside the schema, or the same
  version with another fingerprint fails the object `broken` (at activation, or while live for a keyed load); the data
  stays.

## For Chord's layers (`internal.ts`)

- `Documents`: one object's documents and line: slots by name, `hydrate(declared, pins, ctx)` after each factory
  (drops undeclared in-memory slots, takes the pins), `load(ctx)` (the persisted singletons and pinned keys, a line
  job; `undefined` when nothing is persisted), `tx(fn, token, ctx)`, `fence(token)` (cuts the attempt's transaction at
  its seal), `seal()` and `end()` at the object's end.
- `SealToken`: one per attempt; sealed when the attempt ends. Transactions and handles check it.
- `Singleton`, `Keyed`: the handles (`slot`, `token`, `version`); `KeyDeclarer` is what `at(key)` pins through.
- `KeyedSlot`, `KeySource`: a keyed slot's residents, per-key sources (the targets of `at(key)` and keyed members,
  with their pins) and shared cold loads.
- `DocumentSlot`, `AnyDefinition`: a slot as transactions draft and adopt it.
- `Transaction`, `Staged`: Chord's own changes staged in a transaction (a job's run records), adopted with the
  documents in the same commit, then told how the transaction ended once the line is free.

Inside the directory: `definition.ts` (`defineState`, versions, fingerprints, `migrate`), `slot.ts` (singleton slots
and the slot contract), `keyed-slot.ts`, `address-source.ts` (the frames of one document address: changes, root
replacements, retirements), `persistence.ts` (a slot's stored side: load, find, keys, the writes of a commit),
`residency.ts` (keyed residents and their eviction: Durable's idle structure, one timer per object), `handles.ts`,
`fence.ts`, `transaction.ts`, `line.ts` (one holder at a time, in order) and `documents.ts`.

Tests: `test/next/documents/` (one file per source). Examples: `02-documents.ts`, `21-persisted-documents.ts`,
`23-keyed-watches.ts`.
