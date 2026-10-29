
# One Store, Many Views {#shared-store lede="Local types, and the pattern every Chord plugin uses: shared data once in a store, per-caller views in front of it."}

Every caller has its own `Notes` object, which is what makes per-caller variants possible. But data must exist once.
The fix is the most common pattern in Chord: a **shared store**, a `local` object that holds the data and does the
heavy work once, behind thin per-principal **views**, the `remote` objects callers get.

## `local` types

```ts
// notes/contract.ts
export const NoteStore = local("notes.store", {
  version: 1,
  input: obj({ session: str() }),
  members: {
    notes: obj({ items: arr(Note) }),                          // state: a schema
    public: obj({ items: arr(PublicNote) }),
    add: method(obj({ text: str(), by: str() }), str()),       // methods: method(...)
    remove: method(obj({ id: str() })),
  },
});
```

A `local` contract has flat `members` and no variants. The differences:

| | `remote` | `local` |
| --- | --- | --- |
| reachable from | any host, across links | its own host only |
| identity | (type, input, principal key) | (type, input) |
| principals, variants | yes | no |
| factory | `(input, principal, self)` | `(input, self)` |
| arguments | stripped to the provider's schema and validated, for every caller | see the review note below |
| values on the same host | passed by reference, never copied | passed by reference, never copied |
| `ctx.principal` | the caller | none |
| may persist documents | no (chapter V) | yes |

A local object has no principal: it is trusted code on its own host, acting for the host. So attribution ("who wrote
this note") is passed as data (`by`), by the view that knows who called. Clients serve only local types, because
nobody can address a client.

## The pattern

```ts
// notes/worker.ts
export default defineFacet((host, self) => {
  host.serve(NoteStore, ({ session }, self) => {
    const list = self.state(NoteList);
    const pub = self.derive("public", [list], ([l]) => ({ items: l.items.map(stripAuthor) }));
    return {
      notes: list,
      public: pub,                                   // computed once, for every reader
      add: ({ text, by }, ctx) =>
        self.tx(async (tx) => {
          const id = uuidv7();
          (await tx.draft(list)).items.push({ id, text, by, at: Date.now() });
          return id;
        }, ctx),
      remove: ({ id }, ctx) => list.change((d) => { d.items = d.items.filter((n) => n.id !== id); }, ctx),
    };
  });

  host.serve(Notes, ({ session }, principal, self) => {
    const store = self.get(NoteStore, { session });   // a reference, declared: held for the view's life
    if (canWrite(principal, session)) return {
      variant: "editor",
      notes: store.notes,                             // the store's readable, exposed as-is
      add: ({ text }, ctx) => store.add({ text, by: authorOf(principal) }, ctx),
      remove: (args, ctx) => store.remove(args, ctx),
    };
    return { variant: "reader", notes: store.public };
  });
});
```

:::flow wide | One store, three views. The redaction runs once in the store; both readers read the same value.
row "Per-principal views (remote)" blue
box ve "Notes { S1 }" "owner · editor" blue
box vr1 "Notes { S1 }" "guest Ann · reader" blue
box vr2 "Notes { S1 }" "guest Bob · reader" blue
row "Shared store (local)" accent
gap
box store "NoteStore { S1 }" "notes, public (a derive)" accent
gap
arrow ve -> store "self.get"
arrow vr1 -> store "self.get"
arrow vr2 -> store "self.get"
note "Authority is the view's: the reader variant has no add. The store does not check; it is trusted and acts for the host."
:::

`self.get(NoteStore, { session })` in a factory declares a **reference** that the view holds for its whole life; Chord
binds it during activation and waits until the store is live (chapter VI). The view exposes the store's readables
directly. Owner, Ann and Bob now give three `Notes` objects, one `NoteStore`, one note list and one redacted list.

Any heavy or shared part belongs in a store like this: a pi-durable watch, a file watcher, a sandbox, a search index.
Base code uses the same pattern with the same primitives; nothing about it is special to core.

## Derived values, briefly

`self.derive(name, sources, fn)` computes a value from readables and recomputes it when a source changes; viewers get
only the difference. The reader's list above is one. Chapter VIII covers derives in depth, including the one footgun
that matters: `stripAuthor` must return the *same* object for an unchanged note, or every commit costs the size of the
whole list. The tool for that is `mapShared`.

## Arguments are checked at the provider

Trusted code is not type-checked code: plugins are bundled with esbuild without type checks, and agents write
JavaScript plugins. So the provider checks arguments itself (decision R7): every method's arguments are stripped to
the **provider's own** schema (unknown fields removed) and validated with it, whoever the caller is, and never with a
schema a peer sent. Schemas are compiled lazily on first use and cached per schema object. Bytes are checked as leaves
(`instanceof Uint8Array` plus an optional length bound), never walked. Stripping copies only when a field was removed;
the caller's value is never mutated (proposal Q12, in the L1 draft). Results and state are not validated: they come
from the provider.

On the same host nothing is copied: arguments and results are passed by reference. Values are **immutable by
convention** (Delta's rule, as in Durable): nobody mutates a value it received, and Chord neither copies nor freezes
values to enforce it. There is no development mode that would freeze them; one behaviour everywhere (R9).

:::review | Review: are local arguments validated? (Q15, open)
Design §5's table says `local` arguments are "neither validated nor copied"; §3 and R7 say arguments are validated
"for every caller". Review round 3 raised this as Q15 (apply R7 to `local` too, or keep `local` as the one exception),
and `layer-1.md` lists it as open. Until it is decided, write local methods so that they do not depend on either
answer: trust the shape, but never trust content (lengths, ids) that came from a remote caller without the view
checking it. `chord-next-walkthrough.md` concept 6 still describes the older rule ("validated only when the caller is
not a host principal"), which R7 replaced.
:::

## Choosing between the two

Use a `remote` type for what callers address: views, things with per-caller authority. Use a `local` type for what
exists once per input on one host: stores, caches, owners of OS handles, and the core objects a host provides
(chapter IX). If a type is reached across a link, it is remote; if a type persists documents, it is local (or a
host-lifetime object, chapter V).
