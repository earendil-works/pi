# Chord Delta

Chord Delta synchronizes JSON values from an authoritative producer to an
ordered replica. It is available from `@earendil-works/chord/delta`.

A change is represented by an `Op`: a JSON tuple for replacing, setting,
deleting, updating a string, or splicing an array. Producers use `track()`;
replicas use `apply()` or `applyImmutable()`.

```ts
import { apply, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "", entries: [] as string[] });
let replica = apply(undefined, tracker.flush());

tracker.state.output += "done\n";
tracker.state.entries.push("result");
replica = apply(replica, tracker.flush());
```

The first `flush()` returns one operation containing the complete value. Each
later flush returns operations whose application transforms the previously
published value into the current value. It returns `[]` when no tracked mutation
is pending, but a mutation window that restores its starting value may still
produce a redundant batch.

`applyImmutable()` copies only containers along changed paths and shares
unchanged subtrees. It does not mutate, clone, or freeze either complete input.
Chord's replicated-state producers mutate a tracked proxy and publish operation
batches; consumers still observe complete immutable values.

## Sending or storing changes

`flush()` produces decoded `Op[]` with complete paths. This is convenient for
local use but repeats long paths on the wire or disk.

`encoder()` compresses those paths and returns `WireOp[]`. `decoder()` validates
the encoded tuples, restores complete paths, and returns the `Op[]` required by
`apply()`:

```ts
import { apply, decoder, encoder, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "" });
const enc = encoder(); // producer side
const dec = decoder(); // consumer side
let replica: { output: string } | undefined;

const send = () => {
	const ops = tracker.flush();
	const wire = enc.encode(ops); // serialize or store WireOp[] here
	const received = dec.decode(wire);
	replica = apply(replica, received);
};
```

Encoding is optional for local application. Never pass `WireOp[]` directly to
`apply()`.

An encoder and decoder are stateful. Use one pair for each ordered stream. The
encoder assigns numeric IDs to paths used across batches; the decoder remembers
the corresponding definitions. A complete-value operation resets both path
dictionaries, so replay can begin at that batch with a fresh decoder.

Path omission is local to one batch. Numeric path IDs may span batches. Each
independently hydrated replicated-state stream needs its own encoder and decoder.
Do not share a pair between state members or subscriptions, even when their
batches use the same ordered transport connection.

## Operation vocabulary

A path is an array of object keys and array indices:

```ts
["operation", "message", "content", 0, "text"]
```

### Decoded `Op`

`track().flush()` returns these tuples, and `apply()` accepts them:

| Tuple | Meaning |
| --- | --- |
| `["r", value]` | Replace the complete value. |
| `["s", path, value]` | Set a property or array element. |
| `["d", path]` | Delete an object property. |
| `["a", path, text]` | Append to a string. |
| `["t", path, count]` | Remove UTF-16 code units from a string's front. |
| `["p", path, index, remove, items]` | Splice an array. |

Except for `r`, every decoded operation carries its complete path. `s`, `d`,
`a`, and `t` cannot address the root. `p` may address a root array.

### Encoded `WireOp`

A `PathRef` is either an inline path or a non-negative numeric path ID.
`WireOp` supports the following tuples:

| Tuple | Meaning |
| --- | --- |
| `["r", value]` | Complete replacement; identical to decoded form. |
| `["#", id, path]` | Define a numeric path ID. |
| `["s", pathRef, value]` | Set with an inline or interned path. |
| `["s", value]` | Set using the previous path in this batch. |
| `["d", pathRef]` | Delete with an inline or interned path. |
| `["d"]` | Delete using the previous path. |
| `["a", pathRef, text]` | Append with an inline or interned path. |
| `["a", text]` | Append using the previous path. |
| `["t", pathRef, count]` | Front-truncate with an inline or interned path. |
| `["t", count]` | Front-truncate using the previous path. |
| `["p", pathRef, index, remove, items]` | Splice with an inline or interned path. |
| `["p", index, remove, items]` | Splice using the previous path. |

For example, adjacent decoded operations on one path:

```ts
[
	["t", ["output"], 200],
	["a", ["output"], "next chunk"],
]
```

encode to:

```ts
[
	["t", ["output"], 200],
	["a", "next chunk"], // reuses ["output"]
]
```

When `output` is used again in a later batch, the encoder defines an ID on its
second explicit use:

```ts
[
	["#", 0, ["output"]],
	["a", 0, "more"],
]
```

Later batches can use `0` directly until a complete-value operation resets the
dictionary.

## Producing changes

Read and mutate `tracker.state` as a normal object:

```ts
tracker.state.status = "running";
tracker.state.settings.theme = "dark";
tracker.state.messages.push(message);
delete tracker.state.retry;
```

Operations are coalesced within a flush window when doing so is cheap and safe:

```ts
tracker.state.status = "starting";
tracker.state.status = "running";
tracker.flush(); // one set to "running"
```

The operation sequence is not canonical. Equivalent changes may use different
verbs, and mutations that cancel can still produce a nonempty batch. Consumers
must depend on the resulting value, not the exact tuples or their minimality.

Replacing an object or array is valid. Delta compares its properties and elements
with the outgoing value at assignment time:

```ts
tracker.state.settings = {
	...plainSettings,
	theme: "dark",
};
```

Unchanged properties produce no operations. Changed nested strings and arrays
still use string and splice operations.

### Strings

Appending text produces an `a` operation:

```ts
tracker.state.output += "next line\n";
```

Moving a bounded text window forward produces `t` followed by `a` when the
previous suffix matches the new prefix:

```ts
tracker.state.output = tracker.state.output.slice(200) + nextChunk;
```

An unrelated replacement produces `s`.

### Arrays

Use normal array methods:

```ts
tracker.state.messages.push(first);
tracker.state.messages.push(second);
tracker.state.messages.splice(3, 1, replacement);
```

Adjacent `push()` calls are normally coalesced into one tail `p`. Intervening
operations may keep them separate to preserve ordering. Changes to older
elements remain separate, and changes to newly pushed elements may be folded
into the pushed values when no structural operation intervenes.

Front or middle insertion and removal are recorded directly. Edits before and
after an index-changing operation remain ordered against the array generation
they addressed. Sorting, reversing, `fill()`, and `copyWithin()` emit a snapshot
of the affected array; repeated whole-array mutators can therefore produce a
redundant snapshot even when their combined result restores the prior value.

Sparse arrays are unsupported. Writing beyond the next index throws. Increasing
`length` creates explicit `null` elements; decreasing it removes elements.

`fill()` and `copyWithin()` keep normal JavaScript reference semantics; an object
they place at several indices is published at each.

### Large mutation windows

#### Build once, assign once

Every object or array assignment is diffed immediately. Do not repeatedly assign
large intermediate values before one flush:

```ts
// Avoid: traverses every intermediate tree.
for (const frame of frames) tracker.state.view = render(frame);

// Prefer: only the final tree crosses the tracked boundary.
const nextView = frames.reduce((view, frame) => renderInto(view, frame), initialView);
tracker.state.view = nextView;
```

For a few changes, mutate the leaves directly:

```ts
for (const update of updates) {
	tracker.state.view.rows[update.index]!.status = update.status;
}
```

#### Do not cancel whole-array mutators

`sort()`, `reverse()`, `fill()`, and `copyWithin()` record snapshots. Cancelling
them still publishes the final snapshot:

```ts
// Avoid: final value is unchanged, but a snapshot may still be sent.
tracker.state.items.reverse();
tracker.state.items.reverse();

// Prefer: decide before mutating tracked state.
if (needsReverse) tracker.state.items.reverse();
```

#### Publish large inserts and edit sets in chunks

Pending inserted values are cloned for replica ownership. Very large unflushed
pushes therefore temporarily retain both the live values and their operation
payloads. Long operation/path histories may also collapse to a complete base
batch, increasing snapshot and wire cost.

```ts
for (const chunk of chunks(items, 1_000)) {
	tracker.state.items.push(...chunk);
	replica = apply(replica, tracker.flush()); // send each batch in a real producer
}
```

Use the same pattern for large sets of unrelated edits: apply a bounded chunk,
publish it, then continue.

### Optional properties

Optional object properties use absence. They do not require `null`:

```ts
type Settings = { label?: string; count: number };
const tracker = track<Settings>({ count: 0 });

tracker.state.label = "active";
tracker.state.label = undefined; // produces d
// `delete tracker.state.label` is equivalent
```

`undefined` is accepted only as assignment syntax for deleting an object
property. It is not a JSON value. Initial and assigned objects cannot contain own
`undefined` values, and array elements cannot be `undefined`. Use `null` when an
array position or explicit empty value must remain present.

## State ownership

The object passed to `track()` becomes tracker-owned, as does any object later
assigned into state or inserted into an array. Mutate through `tracker.state`:

```ts
const item = { status: "new" };
tracker.state.item = item;

tracker.state.item.status = "ready"; // tracked
item.status = "broken"; // NOT tracked: silently diverges from the replica
```

A reference retained from `tracker.state` stays correct across operations that
renumber it, and across the removal of the element it points at:

```ts
const held = tracker.state.items[2];
tracker.state.items.unshift(other);
held.name = "edited"; // publishes items[3].name

tracker.state.items.splice(3, 1);
held.name = "gone"; // element is no longer in the tree: mutated, nothing published
```

One object may occupy several paths. Each live path is published:

```ts
tracker.state.a = tracker.state.items[0];
tracker.state.items[0].k = 1; // publishes both a.k and items[0].k
```

Tracked state must be a mutable JSON tree:

- strings, booleans, finite numbers, `null`, arrays, and plain objects;
- no cycles;
- no sparse arrays, accessors, frozen objects, symbols, classes, functions,
  `Map`, or `Set`.

## Proxy lifetime and large reads

Proxy caches are weak. Reading a subtree does not permanently retain its proxies
just because the underlying plain objects remain in the document. A proxy still
held by application code keeps its identity; held descendants retain the ancestor
tracking metadata needed to follow array reindexing. Explicit alias locations are
remembered separately from the lifetime of their public proxies.

Collection is automatic, not a `flush()` side effect. JavaScript keeps newly
created or dereferenced `WeakRef` targets alive until the current job ends, and
finalizer cleanup can run later. A synchronous traversal can therefore still have
a substantial allocation peak. Retained-memory measurements must allow event-loop
turns as well as GC; a synchronous `gc()` immediately after the traversal is not
sufficient to measure weak-cache reclamation.

This does not eliminate proxy construction/trap costs or full comparisons on
container assignment. `tracker.target` is available for read-only bulk inspection
without creating proxies. Never mutate through it; all tracked mutations must go
through `tracker.state` or a proxy obtained from it.

See the [delta investigation findings](../../../durable/docs/chord-delta-findings.md)
for the full-traversal regression, measured trade-offs, and reproduction commands.

## Tracker lifecycle

```ts
tracker.flush(); // publish changes since the previous flush
tracker.rebase(); // make the next flush a complete replacement
tracker.discard(); // accept current changes without publishing them
tracker.state = replacement; // replace the root; next flush is complete
```

`discard()` intentionally prevents current changes from reaching existing
replicas. Use it only when those replicas do not need the discarded changes.

`flush()` guarantees convergence, not a minimal or canonical diff. Any nonempty
batch advances replicated-state sequence numbers and notifies subscribers, even
if applying it leaves the value deeply equal to the previous revision. To bound
pending operation and path history, a sufficiently long mutation window may
collapse to a complete base batch automatically. This bounds accumulated log
metadata, not payload bytes or peak allocation, and trades one full-value
snapshot for an additional recovery point.

`apply()` adopts object and array payloads from its input batch. Do not freeze a
batch before applying it, and do not apply one in-memory batch to multiple
mutable replicas unless each replica owns that batch. A serialized and decoded
batch is already detached. `applyImmutable()` instead treats its previous value
and operation payloads as immutable, so one batch can safely fan out in-process.

A `decode()`, `apply()`, or `applyImmutable()` error terminates that stream.
Discard its decoder and replica, then recover from a later base batch. `apply()`
is not transactional; operations before the failing operation may already have
changed the replica.

## Limits

- Delta assumes one authoritative writer and ordered delivery. Sequence numbers,
  gap detection, retries, and persistence policy belong to the surrounding
  protocol or storage format.
- Object identity is not replicated. One object at several paths publishes each
  path separately, and a replica holds a distinct value at each.
- Object key insertion order is not replicated. Do not compare or hash replicas
  using serialized key order.
- Array operations that change indices may publish a wider array region, as
  described under Arrays.
- Object-valued keys named `__proto__`, `constructor`, or `prototype` can be read
  and serialized, but cannot be mutated through that key. Replace the nearest
  ordinarily named parent instead.
