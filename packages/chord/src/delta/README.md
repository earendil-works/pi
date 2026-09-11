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
later flush returns the operations needed to transform the previously published
value into the current value. It returns `[]` when the value has not changed.

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

Only the value at flush time is published:

```ts
tracker.state.status = "starting";
tracker.state.status = "running";
tracker.flush(); // one set to "running"
```

Replacing an object or array is valid. Delta compares its properties and elements
with the previously published value:

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

Moving a bounded text window forward produces `t` followed by `a` when the old
suffix matches the new prefix:

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

All `push()` calls before one flush produce one tail `p`. Changes to older
elements remain separate, regardless of whether they happen before or after the
pushes. Changes to newly pushed elements are included in the pushed values.

Front or middle insertion, removal, sorting, reversing, `fill()`, and
`copyWithin()` are supported. A structural change combined with edits to elements
whose indices moved may compare and publish the retained suffix positionally:

```ts
tracker.state.items.shift();
tracker.state.items[0].status = "changed";
// A shift followed by push in the same flush has the same issue.
```

The emitted data can then scale with the retained suffix, or with the complete
array, rather than only the changed element. When batching is under your control,
flush the structural change before editing elements at their new indices.

Sparse arrays are unsupported. Writing beyond the next index throws. Increasing
`length` creates explicit `null` elements; decreasing it removes elements.

`fill()` and `copyWithin()` keep normal JavaScript reference semantics. Do not use
them to place one mutable object at multiple live paths.

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

The object passed to `track()` becomes tracker-owned. The same applies to objects
later assigned into state or inserted into arrays.

After insertion, a retained reference may be read but must not be mutated or
inserted at another live location. The tracker relies on this ownership rule; it
does not recursively validate values or detect aliases:

```ts
const item = { status: "new" };
tracker.state.item = item;

tracker.state.item.status = "ready"; // supported: tracked mutation
item.status = "broken"; // unsupported: bypasses tracking
tracker.state.other = item; // unsupported: one object at two live paths
```

The same restriction applies across separate array calls:

```ts
tracker.state.items.push(item);
tracker.state.items.push(item); // unsupported alias
```

Use distinct objects when values must appear at multiple paths. Perform
mutations through `tracker.state`; do not put a proxy read from `tracker.state`
back into tracked state.

Tracked state must be a mutable JSON tree:

- strings, booleans, finite numbers, `null`, arrays, and plain objects;
- no cycles or one mutable object stored at multiple locations;
- no sparse arrays, accessors, frozen objects, symbols, classes, functions,
  `Map`, or `Set`.

Do not keep a child proxy across an array operation that changes indices. Read
the child again from its new index.

## Tracker lifecycle

```ts
tracker.flush(); // publish changes since the previous flush
tracker.rebase(); // make the next flush a complete replacement
tracker.discard(); // accept current changes without publishing them
tracker.state = replacement; // replace the root; next flush is complete
```

`discard()` intentionally prevents current changes from reaching existing
replicas. Use it only when those replicas do not need the discarded changes.

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
- Object identity is not replicated. Tracked mutable state must be a tree;
  immutable inputs may share references, but replicas need not preserve them.
- Object key insertion order is not replicated. Do not compare or hash replicas
  using serialized key order.
- Array operations that change indices may publish a wider array region, as
  described under Arrays.
- Object-valued keys named `__proto__`, `constructor`, or `prototype` can be read
  and serialized, but cannot be mutated through that key. Replace the nearest
  ordinarily named parent instead.
