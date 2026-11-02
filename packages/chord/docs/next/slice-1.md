# Slice 1: one host, local objects (spec, for the owner's approval)

Status: **approved (owner, 2026-10-22)**, after Astra's and Fable's spec reviews. The single source for building slice 1,
together with the feature map in `slices.md` (entries assigned to slice 1) and `design.md`, read in full (the most
relevant sections: §3 host, §5-§7, §8, §9, §11, §12, §16, §18); rules come from the decision log
(`packages/chord/docs/next/decisions.md`); code style: the section "Chord v2 Code Style" of the root `AGENTS.md`. Builds on
L1 (`src/next/contracts`, `src/next/data`) and Chord's shared watch handle (`src/watch.ts`).

## What an app can do after this slice

```ts
const Notes = local("notes.store", {
  version: 1,
  params: {},
  members: {
    notes: obj({ list: arr(Note) }),
    titles: arr(str()),
    count: int(),
    add: method(obj({ text: str() })),
    saveDraft: method(obj({ conversation: int(), body: str() })),
  },
});
const Draft = local("notes.draft", {
  version: 1,
  params: { conversation: int() },
  members: { summary: str() },
});

const NotesDoc = defineState("notes", { schema: obj({ list: arr(Note) }), version: 1, initial: () => ({ list: [] }) });
const Drafts = defineState("drafts", { schema: obj({ body: str() }), version: 1, initial: () => ({ body: "" }), keyed: true });

const facet = defineFacet<AppPrincipal>((host) => {
  host.serve(Notes, (_, self) => {                                // empty params: lives as long as the host
    const notes = self.state(NotesDoc);
    const drafts = self.state(Drafts);                             // keyed: one document per conversation (P3 pattern)
    const title = mapShared((note: Note) => note.text.slice(0, 20));
    return {
      notes,
      titles: self.derive([notes], ([n]) => title(n.list)),
      count: self.derive([notes], ([n]) => n.list.length),
      add: async ({ text }, ctx) => {
        await self.tx(async (tx) => { (await tx.draft(notes)).list.push({ text }); }, ctx);
        return null;
      },
      saveDraft: async ({ conversation, body }, ctx) => {
        await self.tx(async (tx) => { (await tx.draft(drafts, String(conversation))).body = body; }, ctx);
        return null;
      },
    };
  });
  host.serve(Draft, ({ conversation }, self) => {                  // params: lives while referenced
    const store = self.get(Notes, {});                              // declared here, live before this object is
    return { summary: self.derive([store.count], ([c]) => `conversation ${conversation}, ${c} notes`) };
  });
});

const host = createHost({ onError: (error) => log(error) });       // no address: local types only
await host.load([{ name: "@app/notes", facet }], ctx);
const notes = await host.get(Notes, {}, ctx);                      // live and hydrated
await notes.add({ text: "milk" }, ctx);
notes.count.value;                                                 // 1
const w = await notes.count.watch(ctx);
w.start(async (value) => console.log(value));
notes.release();                                                   // ends w; the object lives on (empty params)
await host.close(ctx);
```

## 1. Host and facets

- `createHost({ telemetry?, onError? })`: a host without an address; it serves only `local` types in this slice.
  `telemetry` is the adapter (NOOP by default); `onError` receives background errors (a throwing watch listener).
- `defineFacet<P>(setup)` returns a facet typed for the app's principal type `P` (base code binds it once; nothing is
  checked at runtime). `setup(host, self)` runs synchronously inside `host.load` and only declares: `host.serve(Type,
  factory)` and facet documents through `self.state(Def)` (C16, owner: built now). `host.serve` outside a setup
  throws.
- **Facet documents (design §9, §16):** the facet is a pure object with the host's lifetime; its documents live as long
  as the host. Objects the facet serves may read the facet's handles and draft them in their own `self.tx`, together
  with their own documents, atomically (lock order: the object's own line, then the facet's line). The facet never
  drafts a served object's documents; objects of other facets cannot use them.
- `host.load(facets, context)`: `facets` is `[{ name, facet }]` with npm-style plugin names; duplicate names or a type
  served twice are refused. After every setup ran, every served `local` type with empty params is activated (Q-A, the
  start barrier); `load` resolves when all are live. If one fails, `load` ends everything it activated and rejects;
  the host is then empty. A `host.get` made before `load` resolves waits for it.
- `host.close(context)`: rejects new calls, ends every object (in reverse activation order) and resolves when all have
  ended.

## 2. Objects

- **Identity:** one object per `(type, params key)` (L1's `checkParams` and `identityKey`; local has no principal).
- **Lifetime (Q-A):** a local type with empty params is created at `load` and lives until `close`; a type with params
  is created by the first `get` and ends when its last reference is released.
- **Factory:** `(params, self) => implementation`, synchronous and declarative, run once per object. The
  implementation has exactly the contract's members: a state member is a JSON `Watchable` of its value (a document
  handle, a derive, a member of a reference), a method is `(args, ctx) => Promise<result>`. L1's `Implementation<C>`
  types state members as `Watchable<Static<schema>>` (owner, 2026-10-22).
- **Activation (design §6):** run the factory; acquire the references it declared with `self.get` (activating their
  objects if needed) and wait until they are live; check the members (exactly the contract's, state members JSON
  watchables, Q14); compute every derive's first value; then the object is live and calls proceed. A throw anywhere
  in activation (factory, a dependency's activation, a member check, a first derive compute, `initial()` failing its
  schema) rejects the `get` (or `load`) with that error, releases everything acquired and leaves no object. Failure
  states, backoff and retries are slice 2.
- **Ending:** new calls on the object fail `released`; the context of each of its running calls is aborted; from then
  on its `self.tx` throws `released` (a still-running method can no longer change anything); its derives are detached
  from their sources (no source keeps a reference to an ended object's derive); its references are released; its
  documents are dropped; every watch on its members ends `ended`. Ending does not wait for running calls (the drain
  arrives with natives in slice 2, design §3).

## 3. References

- `host.get(Type, params, context)` returns a reference once its object is live; `self.get(Type, params)` declares one
  in a factory: it is live by the time the object goes live, and released when the object ends.
- A reference is a plain object built from the contract's member list (no proxy): `ref.<state>` is a `Watchable`
  (`value`, `watch(ctx)`), `ref.<method>(args, ctx)` calls the method, `ref.release()` releases it (idempotent). After
  release, every use throws `released`.
- **Calls:** arguments and results pass by reference; arguments are checked at the provider with L1's `checkArgs`
  against the current version (`bindProvider(contract, {})` at serve): unknown method `invalid/member`, bad arguments
  `invalid/args`; results are not checked; no-argument methods take `null`.
- **Per-reference watches** (owner): watches obtained through a reference end (`ended`) when it is released, even
  while other references keep the object alive.
- **Contract match** (owner): at `get`, the caller's contract must have the provider's version and fingerprint (the
  same declaration, or an identical one), otherwise `contract_mismatch`. Older versions through `accepts` come with
  slice 7.
- **Reserved member names** (owner): `then`, `release`, `state` and `retry` are refused as member names at
  declaration (an L1 check in `remote`, `local` and `evolve`), because a reference has them (`release` now, `state` and
  `retry` in slice 2) and `then` would make an awaited reference thenable.
- **Cycles (Q5, one host; owner):** at `self.get` during an activation, Chord follows the chain of objects waiting for
  activation; reaching the object being activated fails that activation with `invalid/cycle`, naming the cycle
  (`a → b → a`); nothing is kept.
- `ctx` in this slice is a plain `Context` (cancellation and telemetry); `ctx.get` and `ctx.principal` come with
  slice 3.

## 4. Documents in memory (§9, P2)

- `defineState(name, { schema, version, initial, keyed? })`: the root is a JSON object. `checkpointWhen` is required
  only for persisted documents (slice 6; owner, 2026-10-22). `migrate` comes with slices 6 and 7.
- `self.state(Def)` returns a handle bound to this object; every document is in memory, instance state of the object
  (P2), gone when it ends.
- **Singleton handle:** `handle.value` is the current value, `initial()` until written or after a retire (Q11); the
  handle is a `Watchable`.
- **Keyed handle:** `await handle.get(key)` gives the value or `undefined`; `handle.keys()` is an `AsyncIterable` of
  the present keys (the shape persistence keeps); keys are strings. A keyed handle is not a `Watchable` (a live
  collection is a singleton holding a list or map).
- `initial()` is checked against the schema once, the first time a definition's `initial()` is used (R8).

## 5. Transactions (§9, R12, R13)

- `self.tx(fn, ctx)`: an object's transactions run one at a time (its line). `fn` gets `tx`: `await tx.draft(handle,
  key?)` returns the document's draft (Delta's `track`, `beginChange`; the same document gives the same draft within
  one transaction); `tx.retire(handle, key?)` removes a document (a no-op when absent). `self.tx` returns what `fn`
  returns.
- **Commit:** when `fn` resolves, if `ctx` is aborted the transaction is discarded; otherwise every draft is prepared
  (Delta's `prepare`: ops recorded, only placed values checked), unchanged drafts commit nothing, and all changed
  documents are adopted (pointer swap) in **one batch** (section 6). A throw discards everything.
- Drafts are revoked when the transaction settles (touching one throws, R12); a transaction returns plain values and
  data is read from the handle after the commit.
- A transaction drafts only its own object's documents and its facet's (any other handle throws). Inside `fn`: no
  second `self.tx`, no calls to other objects (Durable's rule; documented, not detected).
- **Shorthands (C14, owner: built now):** `handle.change(fn, ctx)` (keyed: `handle.change(key, fn, ctx)`) runs one
  transaction that loads the document and calls the synchronous `fn(draft)`; `handle.retire(ctx)` (keyed:
  `handle.retire(key, ctx)`) retires it. Both are thin wrappers over `self.tx`.

## 6. Derives and the batch (W1, §11, §12)

- `self.derive(sources, compute)`: sources are JSON `Watchable`s (this object's handles and derives, members of
  its `self.get` references); only the declared sources are tracked. `compute` is a synchronous pure function of their
  values; its result is JSON.
- **Pull model.** A commit only marks: every derive that depends on a changed document, directly or through other
  derives, including derives of other objects on the host, is flagged dirty (O(dependents), flags only). A derive's
  `value` recomputes when it is dirty, after reading its sources' values (which recompute first if they are dirty);
  so each derive computes at most once per batch and always after its sources, diamonds included.
- **The batch** (one per host): a commit's adoptions happen inside it; after the last adoption, still synchronously,
  every watched value that changed is read (watched derives recompute through the pull), its ops computed
  (`diffRevisions(old, new)` for a derive, the commit's ops for a document), and its watches get one frame each. A
  derive is recomputed in the batch only if something watched depends on it; otherwise it stays dirty until read.
  Reading `.value` once does not make it watched.
- A derive that throws fails only itself: its `value` throws the error and its watches end `failed`; a derive over it
  throws the same error when read. A derive that fails during activation fails the activation (section 2). A failed
  derive stays failed until the object is rebuilt.
- **Reentrancy:** inside the batch (adoptions, derive computes, including lazy computes outside a commit), `self.tx`,
  `watch`, `release`, `get`, `load` and `close` throw `invalid/reentrant`. One flag per host, cleared in a `finally`.
- `mapShared(f)`: maps an array calling `f` only for object elements not seen before (by identity), returning the
  previous result for unchanged ones; primitive elements are mapped every time; the cache is a `WeakMap`.
- `constant(value)`: a JSON `Watchable` that never changes (start data, §18); usable as a state member and a source.
- State is JSON only (L2 decision): no bytes in documents or derives.

## 7. Watching

`watchable.watch(ctx)` returns Chord's shared `Watch` (`src/watch.ts`): the value at acquisition, then one frame per
batch that changed it, `(value, ops, ctx)`, in order, asynchronously, with its overflow, `stop` and end semantics.
Each frame is consistent with its commit; two different watches are not ordered relative to each other. A retired
singleton gives the frame `[["r", initial]]` (it changes back to `initial()`; a singleton always has a value). `ctx`'s
abort cancels the watch. A listener that throws ends its watch `listener_error` and is reported to `onError` (taken
from the carry-over).

## Cost per hop

| Hop | Work |
| --- | --- |
| a call | L1's three lookups and one compiled check; arguments by reference |
| a commit | Delta prepare per changed document, pointer swaps, dirty flags per dependent, then per watched changed value one read (derives recompute once) and one frame per watch, by reference |
| an unwatched derive | nothing until read |

Counters (telemetry, where the work happens): L1's, plus `chord.derive.computes` and `chord.derive.diffs`.

## Carry-over taken by this slice

From `carry-over.md` (L4 section): watch listener errors reported to `onError`; native watchables refused as state
(by the member check: only JSON watchables exist in this slice); `defineFacet` typed by `P`. Left for
later: plugin error shape, old-version calls (7), `broken()` (2), cuts C5, C6, C7, C13 (2).

## Tests

- Host: load runs setups, activates empty-params types, rejects duplicates and double serves; a failing activation
  makes `load` end what it activated; `get` during load waits; `serve` outside setup throws; close ends everything.
- Objects: one object per params key; params type created on first get and ended on last release (documents gone,
  watches end `ended`, its derives detached from other objects' members); empty-params type lives across releases;
  activation failures (factory, dependency, member check, first derive, `initial()`) reject the get and leave nothing;
  a method running while its object ends cannot commit (`self.tx` throws `released`) and sees its `ctx` aborted.
- References: hydrated on get; members watchable; calls checked; released reference throws; `self.get` dependency
  kept alive and released on end; per-reference watches; contract mismatch; reserved member names refused at
  declaration; a two-object and a three-object cycle fail with `invalid/cycle` and leave nothing.
- Documents: singleton initial, retire back to initial; keyed get, keys, retire; `initial()` checked once.
- Transactions: serialized per object; same draft twice; unchanged commits nothing; throw and abort discard; drafts
  revoked after settle; another object's handle refused; a served object's transaction over its own and its facet's
  documents commits both in one batch; shorthands.
- Batch and derives: two documents in one transaction reach a derive over both in one compute and a watch in one
  frame; a derive over another object's member updates in that object's commit's batch; diamond computes once;
  unwatched derive stays lazy and a one-off read does not make it eager; a throwing derive fails only itself and its
  dependents; reentrancy throws in commits and lazy computes and the flag clears after a throw; `mapShared` identity.
- Watching: frames in order, retire frame, cancellation, listener error reported.
- Cost guards per the table. GC: an ended object with its documents, derives and watches is collected; a released
  reference and a stopped watch hold nothing; a detached derive is not held by its former sources.

## Size

About 1,100 source lines.
