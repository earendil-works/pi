
# Computed Values {#derives lede="Derives, the one footgun that makes them expensive, mapShared, and presence: who is looking."}

The reader's notes without authors, a note count, the number of people viewing: values computed from other values.
Storing copies would go stale; recomputing them on every read would be wasteful and could not be watched. A
**derive** is computed once per change and sent to viewers as a difference.

## `self.derive`

```ts
const count = self.derive("count", [list], ([l]) => l.items.length);
const summary = self.derive("summary", [list, store.pinned], ([l, pinned], previous) => ({
  total: l.items.length,
  pinned: pinned.length,
}));
```

`self.derive(name, sources, (values, previous) => value)`. Sources can be documents, readables, other derives and
state members of references. The value is recomputed when a source changes and diffed into operations for the wire.
Derived values are adopted before ordinary observers run and share their source commit's wire batch, so a viewer
never sees a note list and a count from different commits.

`previous` is the derive's last value, kept across factory re-runs (reloads) by name. It is a cache, empty after a
host teardown, so a derive must be correct without it. A derive that throws fails its whole owner `broken`.

## How the difference is found

Chord compares the new value with the previous one using Delta's `diffRevisions`. Parts that are the **same objects**
as last time cost one `===` each. Parts that are new objects must be compared by content.

**The footgun.** A derive that builds new objects for unchanged data makes every commit cost the size of the whole
value, per view. The reader list from chapter IV, written naively:

```ts
self.derive("public", [list], ([l]) => ({ items: l.items.map((n) => ({ id: n.id, text: n.text, at: n.at })) }));
// one note added to 2,000: 2,001 new objects, every one compared by content
```

**`mapShared(f)`** keeps one result per source element: `f` runs only for new or changed elements, unchanged ones
return their previous result object.

```ts
import { mapShared } from "@earendil-works/chord/delta";

const stripAuthor = mapShared((n: Note): PublicNote => ({ id: n.id, text: n.text, at: n.at }));
self.derive("public", [list], ([l]) => ({ items: l.items.map(stripAuthor) }));
// one note added: one new object, 2,000 identical references; the diff emits one insert
```

:::review | Review: mapShared is planned, not available
Design §12 introduces `mapShared` as coming "from `@earendil-works/chord/delta`", but nothing in `packages/chord/src`
defines it yet, and Delta does not yet treat bytes as atomic leaves in `diffRevisions`. Design §28 lists both as the
step "Delta in pi", before the layered rebuild. Until then, keep a `Map` from source element to result yourself, which
is what `mapShared` will do.
:::

## Cookbook

| Case | How |
| --- | --- |
| select a field, look up by key, a small aggregate | compute it; the value is small |
| filter or map a list | `mapShared` over the elements |
| redaction | preferably separate documents per visibility; otherwise `mapShared`, computed once in the shared store, never per view |
| join two sources | `mapShared` plus the looked-up source's revision |
| a window over a large list | take a section of the source elements without rebuilding them; cache per-element measurements by identity; keep the window's start stable so changes arrive as appends |
| a large view combined from several sources | re-path the sources' operations, as Durable's `ConversationView` does; application code never interprets ops |

**Container width** (R24): structural sharing is O(change) along a path, not across a container's width. Changing one
item of a flat array copies the array's slots, and `mapShared` visits every element once (one identity comparison
each). Large collections are keyed documents or bounded windows. A benchmark of long arrays is to set the documented
limit.

## Readables that are not documents

Three small readables round out the toolkit:

- `constant(value)`: never changes. Start data uses it (chapter IX).
- `self.writable(initial)`: a host-local readable of any in-process value (functions included), compared by identity,
  with `set`. It never goes on the wire; it exists for registry contributions that change (chapter XIII).
- Source readables from elsewhere: a Durable view or document watch is already a Chord readable, because Durable and
  Chord v2 share the readable type (`chord/src/state.ts`), so it can feed a derive or be exposed as state directly.

:::review | Review: exposing a writable (Q14, open)
A `writable` may hold functions; nothing yet stops a factory from returning one as a state member, which would reach
the wire encoder. Review round 3 proposes that only members with a JSON schema in the contract are exposable, checked
when the object is served. Undecided.
:::

## Presence: who is looking

`host.references(Type)` is a readable of who holds references to objects of a type on this host: input, principal and
client. Client holds carry an opaque origin id, so two tabs are two clients.

```ts
host.serve(NoteStore, ({ session }, self) => {
  const viewers = self.derive("viewers", [host.references(Notes)], ([refs]) =>
    refs.filter((r) => r.input.session === session).length);
  return { …, viewers };
});
```

A link drop is a departure: accurate and simple. Smoothing (a phone switching networks makes the count flicker) is the
UI's job, for example a debounced count. Counts per person are derived by the app from principals and origins. There
is no consumer-side linger: a closed tab closes its link and keeps nothing. The provider's `linger` keeps a
just-closed object warm, and that also keeps the worker alive through `host.activity`.

**"Leaving" is never derived from an unmount.** A UI reload unmounts and remounts components; a component unmounted by
a reload has not left. Leaving is explicit navigation, or presence (a dropped reference). This replaces p2's presence,
viewer and login-abandon leases with one mechanism.

:::note | Built so far
Readables and derives are layer L2 (a readable is today's `replicatedState`, derives reuse today's derived cells over
it). Not started in the rebuild.
:::
