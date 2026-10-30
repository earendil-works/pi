
# Writing It Down {#documents lede="Documents and transactions: how an object stores data, changes it atomically, survives restarts and migrates it."}

Notes must be stored, changed safely while others read them, sent to viewers as small changes, and survive a worker
restart. An object's data lives in **documents**: named JSON values the object owns, changed only in
**transactions**. The design is a port of pi-durable's store, so most rules will look familiar; this chapter states
them for Chord.

## Defining a document

```ts
// notes/worker.ts
const NoteList = defineState("notes.list", {
  schema: obj({ items: arr(Note) }),
  version: 1,
  initial: () => ({ items: [] }),
  persist: true,                                                   // stored; default: memory only
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase > 64,
});

const Draft = defineState("notes.draft", {                         // one unfinished note per author
  schema: obj({ text: str() }),
  version: 1,
  initial: () => ({ text: "" }),
  keyed: true,                                                     // many per object, by key
  persist: true,
  checkpointWhen: () => true,                                      // small: a full base per write
});
```

`checkpointWhen` is required on every definition, with no default (R14, as in Durable since pi `5c1736f82`): it says
when a commit stores a complete base instead of a delta, which bounds how much is replayed on load. Small documents
checkpoint on every write; growing ones after a number of deltas.

A document's root is always a JSON object (lists live in a field). Documents hold JSON only; bytes are a value and wire
type, not a document type.

## Singleton and keyed

```ts
host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);      // THE note list of this object
  const drafts = self.state(Draft);       // all drafts of this object
  …
});
```

| | singleton (no `keyed`) | keyed |
| --- | --- | --- |
| how many | one per object | many per object, by a short key |
| loaded | at activation, kept in memory | on demand |
| read | `list.value` (synchronous) | `await drafts.get(key)`: the value or `undefined` |
| list | (it is one value) | `for await (const key of drafts.keys())` pages keys |
| expose as state | yes: the handle is a readable | no: expose a method or a singleton index |

There is no live key list. A collection shown live is a singleton (an object holding a list or a map); a large
collection is a method returning pages.

## Transactions

All writes go through `self.tx(fn, ctx)`. Inside, `await tx.draft(handle, key?, { tags? })` returns a draft of the
current document, or a draft over `initial()` if it is absent. Drafts record operations (assignments, `push`,
`Object.assign`); asking for the same document twice in one transaction returns the same draft. `tx.retire(handle,
key?)` removes a document. There is no `tx.get`: reading is drafting, and a draft is an overlay over the current
value, so nothing is copied. A draft you do not change commits nothing, so reading never stores an absent document.

```ts
saveDraft: ({ author, text }, ctx) =>
  self.tx(async (tx) => { (await tx.draft(drafts, author)).text = text; }, ctx),
```

Shorthands for one document: `handle.change(fn, ctx)` (keyed: `handle.change(key, fn, ctx)`) (loads the document, then runs the synchronous `fn` on
its draft) and `handle.retire(ctx)` (keyed: `handle.retire(key, ctx)`).

### Four patterns

Two decisions (R12 and R13, both as in Durable) shape how transactions are written. **Drafts are revoked when the
transaction settles**, so a transaction returns at most plain values, never something taken from a draft. And
**there is no existence check inside a transaction.**

```ts
// 1. Return data: write in the transaction, read after the commit.
await self.tx(async (tx) => { (await tx.draft(list)).items.push(note); }, ctx);
return list.value.items.length;                    // the committed revision, or a newer one

// 2. Remove if present: retire of an absent document is a no-op.
await drafts.retire(author, ctx);

// 3. Create with tags if missing: the draft creates it, only if it changes.
await self.tx(async (tx) => {
  (await tx.draft(drafts, author, { tags: [SessionTag(session)] })).text = text;
}, ctx);

// 4. Branch on existence: read first, outside the transaction.
if ((await drafts.get(author)) === undefined) { … }
```

### Durable's rule

Inside the callback, only `await tx.*`. No other objects, no network, no models, no processes, no second `self.tx`, no
reads past `tx`. Breaking it is not an error but a hang: the object's line is held while the callback waits. Fetch
first; decide and write inside.

```ts
// Wrong: a fetch inside the transaction holds the object's line.
await self.tx(async (tx) => { (await tx.draft(list)).items.push({ …, title: await fetchTitle(url) }); }, ctx);
// Right: fetch, then write.
const title = await fetchTitle(url, ctx.signal);
await self.tx(async (tx) => { (await tx.draft(list)).items.push({ …, title }); }, ctx);
```

## What a commit does

:::flow wide animate | The commit sequence, Durable's. Nothing is copied, frozen or revalidated; viewers get one batch per commit.
row "Inside self.tx" accent
box line "wait for the line" "per object"
box run "run the callback" "drafts record ops" accent
box prep "prepare" "Delta checks placed values"
box write "storage batch" "deltas or a base" accent
row "After the write" blue
box adopt "adopt" "pointer swap"
box local "notify locally" "once, with the ops" blue
box wire "send" "one batch per link"
box revoke "revoke drafts" "touching one throws"
arrow line -> run
arrow run -> prep
arrow prep -> write
arrow write -> adopt "stored"
arrow adopt -> local
arrow local -> wire
arrow wire -> revoke
note "An error or an abort before the storage write discards everything. Storage commits are serialized per host."
:::

Lines are per object, never across objects; reads outside a transaction do not take the line. Subscribers on the same
host get the new value and the commit's operations by reference. Remote viewers get the commit's operations, never the
document again; chapter XVII shows how one commit touching several holds still arrives as one message.

## Tags and deleting by tag

Tags are typed tokens set when a document is created:

```ts
export const SessionTag = defineTag<string>("studio.session");     // base code, shared by every plugin
await self.tx(async (tx) => { (await tx.draft(drafts, author, { tags: [SessionTag(session)] })).text = text; }, ctx);
// when the session is deleted
await store.retireByTag(SessionTag, "S1");                          // every document tagged S1
```

The design names the operation `store.retireByTag(tag, value)` without saying who holds the store; session delete is
one of the app decisions still open (#18, chapter XIX).

## Who may persist

`persist: true` is allowed only in `local` objects and `lifetime: "host"` objects: identities without a principal. A
`remote` object's identity contains the principal key, which changes with the access path and the grant revision. Its
stored documents would scatter across access paths and be orphaned after a reconnect. The rule is enforced at the type
level (`self.state` in a remote factory accepts only non-persisted definitions) and at declaration ("persist needs a
stable identity: put the documents into a local shared store"). This is the second reason for the shared store.

What survives a host teardown (a crash, a restart) is exactly what is persisted. In-memory documents live as long as
their object: they survive reloads and native restarts of a live object, and go when it ends. Everything else
(natives, derives, routines, references) is rebuilt on activation.

## Facet documents

A facet has its own identity (its plugin's name) and may hold documents too, for plugin-wide data such as
preferences. Objects the facet serves may read and write their facet's documents, and one transaction may span the
object's own documents and its facet's (lock order: own line, then the facet's). The facet never touches a served
object's documents.

## Ownership across plugins

No plugin reads or writes another plugin's documents, Chord or Durable. Data crosses plugins only through state and
methods. Data that core enforces lives in a format core owns and is handed to core through its API when the data is
created (as with Durable's `createConversation({ init })`), never written into core's documents.

## Versions and migration

A change of shape or meaning raises `version` and adds a pure `migrate(old, from)`:

```ts
const NoteList = defineState("notes.list", {
  schema: obj({ items: arr(NoteV2) }),           // NoteV2 adds `pinned`
  version: 2,
  migrate: (old, from) => ({ items: old.items.map((n) => ({ ...n, pinned: false })) }),
  initial: () => ({ items: [] }),
  persist: true,
  checkpointWhen: (_v, _o, info) => info.deltasSinceBase > 64,
});
```

Documents migrate on access by the new definition: singletons during activation (hydration counts as access), keyed
ones on their next access. The migrated base is persisted with the next commit; right after a bump, a read-only
transaction writes it.

Chord does not walk values against schemas. Instead, each definition computes a **schema fingerprint** once
(descriptions and titles ignored), and every stored record keeps the fingerprint it was written with. On access Chord
compares them: the same version with a different fingerprint fails the object `broken` ("schema changed without a
version bump"). So every structural change needs a bump, an additive one with a trivial `migrate`. The one exception
to "no value checks" (R8): the result of `migrate` and of `initial()` is validated against the new schema once, when
produced. A failed check, a throwing `migrate`, or old code meeting a newer document refuses the access, keeps the
stored data and fails the owning object. A changed meaning without a schema change cannot be detected; that is on
you.

## Storage

Behind the store is a `DocumentStorage`, passed as `createHost({ storage })`; memory by default. The server has one
shared storage, each worker one for its session.

```ts
interface DocumentStorage {
  commit(writes: readonly DocumentWrite[]): Promise<Seq>;            // create/change/retire, atomic
  find(address: DocumentAddress): Promise<DocumentRecord | undefined>;
  load(id: string): Promise<StoredDocument | undefined>;             // version, value, deltasSinceBase
  scan(query: { owner: string; definition: string }, limit: number, cursor?: string):
    Promise<{ keys: string[]; next?: string }>;
  byTag(tag: string, value: string, limit: number, cursor?: string): Promise<{ ids: string[]; next?: string }>;
  mintId(): Promise<string>;
}
```

Chord ships a memory storage and a SQLite storage (over `@earendil-works/chord/sqlite`, the driver layer that moved
from Durable; Node and Durable Object drivers). Storages check only metadata (incarnation, version, sequence, address
occupancy, fingerprint) and write the supplied delta or base; they never rebuild or validate content on a commit.
Chord documents never commit together with Durable transcripts: Chord has its own storage, not an adapter over
Durable's. Your own storage can prove itself with `registerDocumentStorageConformance(runner, name, withStorage)` from
`@earendil-works/chord/testing`.

Keyed persisted documents that nobody reads, writes or watches for 10 minutes leave memory and reload on the next
access. A storage error ends the store and closes the host; `onError` receives `{ kind: "storage_failed" }` and the
app decides (chapter I).

## Kinds of state

| Kind | For | API |
| --- | --- | --- |
| document | data the object owns | `self.state`, `self.tx` |
| derive | computed values | `self.derive` (chapter VIII) |
| source readable | external data: Durable views, files, logs | value plus ordered changes; feeds derives |
| paged method | large or queryable collections | a method returning pages (chat history) |
| plugin database | full-text search, large blobs | a native opened by its owner (chapter IX) |

App state lives in Chord documents. Only transcript-bound data, which must fork and rewind with a conversation, lives
in Durable.

:::review | Review: does an absent singleton read `undefined` or `initial()`? (Q11, open)
Design §9 says "whether a document exists is read outside the transaction (`handle.value` / `handle.get` give
`undefined` for an absent one)" and also "a singleton that does not exist yet reads `initial()` through its handle;
retiring resets it to `initial()`". Review round 3 proposes: singletons always read `initial()`, only absent keyed
documents read `undefined`, and singleton existence needs no API. This guide follows the proposal (`list.value` is
never `undefined`); it is not decided.
:::

:::note | Built so far
Documents, transactions and storages are layer L3, a port of Durable's session store; not started. The frozen kernel
has a working version with a JSONL storage, which the design rejected.
:::
