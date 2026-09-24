# Chord Delta

Chord Delta produces immutable JSON revisions and exact operation batches for
ordered replicas. Import it from `@earendil-works/chord/delta`.

Immutability is an ownership contract. Nothing is frozen or defensively copied,
so an illegal mutation is not detected. It silently corrupts state.

```ts
import { applyImmutable, track } from "@earendil-works/chord/delta";

const initial = { output: "", entries: [] as { id: number }[] };
const tracker = track(initial); // `initial` is transferred: never mutate it again

const change = tracker.beginChange();
change.state.output += "done\n"; // the draft is mutable only while the change is open
change.state.entries.push({ id: 1 }); // placed values are cloned; the caller keeps its object
const prepared = change.prepare(); // draft handles are unusable from here on

// tracker.value, prepared.base, prepared.value, and prepared.ops (including paths
// and payloads) are immutable by contract.
tracker.adopt(prepared); // tracker.value === prepared.value

// Shares containers with prepared.base and the op payloads: never mutate it either.
const replica = applyImmutable(prepared.base, prepared.ops);
```

## Mutation rights

| Value | May it be mutated? |
| --- | --- |
| Root passed to `track()`, `prepareReplace()`, `replicatedState()`, or `replace()` | No. Ownership moved to the tracker. |
| `change.state` and handles read from it | Yes, only while that change is open. After `prepare()`, `abort()`, or another adoption, every use throws. Writes through a handle whose element was removed from the draft are ignored. |
| External value after assigning or inserting it into a draft | Yes. The draft stored a validated clone. |
| `tracker.value`, `prepared.base`, retained older revisions | No. |
| `prepared.value`, `prepared.ops`, op tuples, paths, permutations, payloads | No. Payloads may be the same objects as parts of `prepared.value`. |
| `applyImmutable()` inputs and result | No. The result shares containers with both inputs. |
| Values from replicated state (`value`, listener values, loopback consumers) | No. In-process consumers may share the provider's containers. |
| Mutable replica passed to `apply()` | Only through `apply()`, with batches it owns exclusively. Code that edits it between batches breaks convergence. |
| Batch passed to `apply()` | Consumed. `apply()` adopts payload containers into the replica. Use a detached copy for exactly one replica and never touch it again. |

## Replaying batches

Immutable replay is the preferred in-process path. One batch can fan out to any
number of immutable replicas:

```ts
let replica = tracker.value; // shared with authority; never mutated
// For each adopted batch, in order:
replica = applyImmutable(replica, prepared.ops); // replica must equal prepared.base
```

Mutable replay needs a detached starting root and a detached copy of every batch
for every replica. Never apply one in-memory batch to two mutable replicas:

```ts
import { apply } from "@earendil-works/chord/delta";

const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let replica = detach(tracker.value); // exclusively owned starting root
// For each adopted batch, in order:
replica = apply(replica, detach(prepared.ops)); // fresh copy for this replica only
// Only apply() may change `replica`; do not edit it in application code.
```

Parsing a separately serialized message per replica is also a valid detachment.
`decode()` does not copy payloads, so decoding one in-memory `WireOp[]` for two
mutable replicas makes them alias each other.

## Do and don't

- Do build a fresh root and then transfer it; validate untrusted roots at your ingestion boundary.
- Do keep structural sharing between revisions, for example `replace(ctx, { ...state.value, changed })`.
- Do clone or serialize before handing any published value to code that may mutate it.
- Do settle every change with `prepare()` or `abort()`.
- Don't reuse one container at two places in a transferred root.
- Don't mutate anything the tracker owns, published, or received from a batch.
- Don't keep draft handles past their change or place a settled handle.
- Don't infer meaning from op shape. Only the resulting value is contractual.

## Roots and placements

Full roots are trusted. `track()` and `prepareReplace()` take ownership in O(1)
and never walk the tree. Roots must be alias-free, acyclic strict JSON: dense
plain arrays, plain or null-prototype objects with enumerable own data
properties, strings, booleans, finite numbers, and `null`. Violations have
unspecified behavior. For example, a container shared by two keys can make
`prepared.value` diverge from what replicas compute from `prepared.ops`.

Draft placements are copied, and that copy walk also validates. Placements come
from property writes, index writes, `push`, `unshift`, `splice`, `fill`, and
`copyWithin`. A non-strict value throws `TypeError` before the draft changes;
for example, `push(valid, invalid)` inserts nothing. Rejected values include:
cycles, accessors (never invoked), symbol keys, class instances, sparse or
non-plain arrays, functions, bigint, `NaN`, infinities, and `undefined`.
Null-prototype objects are accepted and preserved. Placing a draft handle clones
its current content. Placing one value at several paths yields independent
containers.

`undefined` rules:

- `draft.obj.key = undefined` deletes `key`.
- `arr[i] = undefined`, `push(undefined)`, `unshift`, `splice`, and `fill` with `undefined` throw.
- `undefined` nested anywhere inside a placed object or array throws. It is not dropped like `JSON.stringify` does.

Arrays stay dense. Writing past the next index and deleting an element throw.
Growing `length` inserts `null`; shrinking it removes elements.

## Lifecycle

`tracker.value` is the latest adopted revision. `beginChange()` opens an overlay
draft over it and never modifies it. A draft may stay open across `await`.
`prepare()` materializes the candidate and ops and does not change authority.
`adopt()` checks the preparation and swaps the root pointer.

Several changes may be open or prepared from one revision. Adopting one makes all
others stale: open drafts become unusable and their `prepare()` throws, and
prepared competitors are rejected by `adopt()`. `adopt()` also rejects foreign,
aborted, and already consumed preparations. `Change.abort()` or
`Prepared.abort()` after `prepare()` prevents adoption. The candidate stays
readable.

No-op batches:

- Empty `ops` means `prepared.value === prepared.base`. Writes restored to their original value and deeply equal container assignments usually normalize to empty.
- Equality ignores key order and prototype. A deeply equal assignment keeps the previous revision's order and prototype, even if the draft showed the new ones.
- Structural array edits may emit a nonempty exact batch even when the result is deeply equal.
- Adopting a no-op still advances `tracker.revision` and stales competitors. Replicated state does not publish no-ops.

`prepareReplace(value)` is a whole-root operation, not a diff. If `value` is
deeply equal to the current root, `ops` is empty and the current root is kept
(the comparison may traverse both trees). Otherwise `ops` is `[["r", value]]`
and `prepared.value === value`, so replicas receive the complete root.

Array mutators: `push`, `pop`, `shift`, `unshift`, `splice`, `reverse`, `sort`,
`fill`, and `copyWithin`. Held handles follow elements through reindexing.

## Operations

Paths contain object keys and non-negative integer array indices.

| Tuple | Meaning |
| --- | --- |
| `["r", value]` | Replace the complete value. |
| `["s", path, value]` | Set an object property or array element. |
| `["d", path]` | Delete an object property or remove an array element. |
| `["a", path, text]` | Append to a string. |
| `["t", path, count]` | Remove `count` UTF-16 code units from a string's front. |
| `["p", path, index, remove, items]` | Splice an array. |
| `["m", path, permutation]` | Reorder an array: `new[i] = old[permutation[i]]`. |

Batches are exact but not canonical. The same change may use different tuples,
and large edit sets may fold into a region splice, an ancestor `s`, or `r`.

Reserved keys: the tracker never emits `__proto__`, `constructor`, or
`prototype` as a path segment. A mutation at or below such a key is folded into a
set of the nearest safe ancestor, or `r` at the root. `apply()`,
`applyImmutable()`, and `decoder()` reject those segments with `UnsafePathError`.
The appliers write values as own data properties, never through a prototype setter.
Appliers check op shape and path safety but not payload strictness. Chord's
replicated-state replicas validate each resulting revision.

`encoder()` interns repeated paths into `WireOp` tuples; `decoder()` validates
and restores `Op` tuples. Use one encoder/decoder pair per ordered state stream.
Path IDs span batches and an `r` resets both dictionaries. After a decode or
apply error, discard the decoder and replica and recover from a later `r`.

## Limits and footguns

- No freezing. Mutating any immutable value corrupts state silently.
- Loopback sharing: in-process service consumers may receive the provider's containers. A consumer mutation corrupts authority and makes remote replicas diverge.
- A change inside a large flat array copies that array's pointer storage for the new revision.
- Placement validation costs time and memory on bulk inserts. In a benchmark unshifting 100k three-field objects, it added about 19 ms and 20 MiB of transient heap.
- External proxies as placements, argument coercion callbacks that mutate the draft, non-primitive array indices, and non-numeric comparator results are out of contract. So are sort comparators that mutate, prepare, abort, or adopt. Behavior is unspecified.
- Object identity is not replicated. Each path is an independent value placement.
- One tracker is one revision sequence. Delivery order and persistence belong to the surrounding protocol.
