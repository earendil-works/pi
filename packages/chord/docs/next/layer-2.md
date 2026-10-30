# L2: watchables and derives (spec, for the owner's approval)

Status: **superseded (owner, 2026-10-22)**: the L2 code built from this spec was discarded (too much generic
machinery for callers that did not exist yet: nodes, sinks, deliveries, publications) and the build switched to
vertical slices (`slices.md`). Still valid: the section "Decided while specifying" below, and Chord's shared watch
handle (`src/watch.ts`). Everything else here is background only; do not implement from it.

Original status: approved; open points decided (below). The single source for implementing L2; every rule comes from the decision log
(`packages/chord/docs/next/decisions.md`: "Watchable and one watch API", W1, W2, W3, W4, W12, W14, Q14, R23, R24,
"Changing contributions, `self.writable`", "Cost counters") unless marked **Decision needed**. Code style: the section
"Chord v2 Code Style" of the root `AGENTS.md`.

## What L2 is

Everything observable on one host, and how a change travels: a value changes inside a **publication** (one atomic step
that may change many sources), the derives over it are recomputed right after, and every consumer sees each
publication once, completely, in order. No objects, no storage, no links: L3 (store) publishes document commits
through it, L4 (objects) builds members from it, L6 (links) encodes what it flushes, L9 (registries) composes from it.

Source: `packages/chord/src/next/watch/` (one directory; files by concept). Reused unchanged: Chord's shared
`src/watch.ts` (the watch-handle types **and implementation**, moved there from Durable's `CommittedWatch` by a pi change
first, owner 2026-10-22; Durable uses the same implementation), `src/delta/` (`Op`, `diffRevisions`), `src/context/`,
`src/json.ts`, and L1's `next/data` errors (`invalid/reentrant`). Nothing from `next-frozen/`.

## 1. The two kinds

```ts
interface Watchable<T extends JsonValue> {          // documents, derives, reference members, constant(v), Durable views
  readonly value: T;
  watch(context: Context): Promise<WatchHandle<T>>;  // listener (value, ops, context)
}
interface NativeWatchable<T> {                       // writable(initial), composed registry values
  readonly value: T;
  watch(context: Context): Promise<NativeWatchHandle<T>>;  // listener (value, context)
}
```

- A `Watchable` carries JSON and changes with ops (Delta's `Op[]`): the ops turn the previous value into the next.
  Values are immutable by convention: a new value shares unchanged parts with the old one; nobody mutates a value.
- A `NativeWatchable` carries any in-process value (functions, runtimes); a change is a new value by identity
  (`!==`). Mutating a native value in place notifies nobody. It has no ops and can never be a contract state member or
  go on the wire (Q14, W4).
- Both carry a runtime kind tag (`"json"` / `"native"`), so L4 can refuse a native one as state with one comparison
  (no value walk).

## 2. Publications (W1, W12)

```ts
const publication = createPublication();             // one per host
publication.publish(() => {                          // one atomic step
  notes.set(nextNotes, ops);                         // adopt: pointer swap + mark
  index.set(nextIndex, indexOps);
});                                                  // flush runs here, synchronously, before publish returns
```

- `createPublication()` returns the host's publication. A **source** (`jsonSource(initial, publication)`,
  `writable(initial, publication)`) belongs to one publication.
- `publish(adopt)` runs `adopt` synchronously. Inside it, `source.set(value, ops)` (JSON) or `source.set(value)`
  (native) swaps the value and **marks**: dependent derives become dirty, and the ops are appended by reference to each
  watch's queue and each sink's batch. O(1) per dependent. Then, still synchronously and without any `await`, the
  **flush**:
  1. recompute every dirty derive that has a consumer, in dependency order (each derive once per flush, after all its
     sources), diffing its old and new value with `diffRevisions` into ops, and marking its own dependents;
  2. deliver each touched sink its batch for this publication (section 6);
  3. call the publication's flush listeners once (L6 uses this to send one message per link);
  4. schedule the queued watch frames (their listeners run later, asynchronously, in order).
- Every change goes through `publish`: L3's commit step (after the backend commit; S1), in-memory commits (no store
  seq, the publication's own counter, W12), `writable.set` (which publishes itself), registry recomposition and
  inbound wire batches. Each publication has a number (a counter per publication) for ordering and lazy checks.
- **Reentrancy:** during `adopt` and the flush, `publish`, `watch`, `attach`, a sink's `detach` and `writable.set`
  throw `invalid/reentrant` (W1: no new transaction, watch or release inside the step). Stopping a watch handle is
  allowed anywhere: it only detaches, and delivery tolerates removal during iteration.
- **Contexts** (context last, required, as in Durable): `createPublication(context)` keeps the host's context (it
  counts lazy-read computes, since a getter has none); `publish(adopt, context)` and `writable.set(value, context)` take the context
  that counts the flush's work and becomes the frames' context. `publication.number` is public (L3's in-memory commit
  number, W12); `publication.onFlush(listener)` returns its removal.
- **Source ends:** a JSON source has `set(value, ops)`, `retire()`, `end()` and `end({ error })`, all only inside
  `publish` (events in publication order), delivered in that publication's flush after its batch: watches retire, end
  or fail; sinks get a retirement as `update(null, [["r", null]])` then `end()`, an end as `end()`, a failure as
  `fail(error)`. A failed source's `value` throws its error, so derives over it fail with the same error; a retirement
  is a change to `null` for derives over it; an end changes nothing for them. `watch` or `attach` on an ended source
  returns a handle or sink ended the same way. A writable has only `set`.
- A source set outside `publish` throws (a programming error, `Error`, not a ChordError).

## 3. Derives (W1, W4, W14, R24)

```ts
const count = derive([notes], ([n]) => n.list.length, publication);
const visible = derive([notes, settings], ([n, s]) => ({ list: n.list.filter(...), theme: s.theme }), publication);
```

- `derive(sources, compute, publication)`: sources are `Watchable`s and `NativeWatchable`s (mixed) created by L2 on
  the same publication (sources, derives, writables, constants; a foreign watchable such as a Durable view becomes an
  L2 source first, L3d); `compute` is a synchronous pure function of their current values; the result is JSON and the
  derive is a `Watchable`.
- **Attached only while consumed:** a derive with at least one consumer (a watch, a sink, or a consumed derive over
  it) is attached to its sources and recomputed in the flush. A derive without consumers holds no subscription; reading
  its `value` recomputes it if any source's publication number moved since its last compute (lazy). So an unused
  derive never keeps work or memory alive, and nothing leaks when consumers go away.
- Ops: when a consumed derive recomputes, `diffRevisions(old, new)` gives its ops (identity short-circuit: unchanged
  shared subtrees cost one `===`). A native source's change marks the derive dirty without ops. A recompute that
  returns the identical value (`===`) publishes nothing.
- **Dependency order:** a derive's rank is one more than its highest-ranked source; the flush recomputes by rank.
  Sources exist before the derive, so cycles cannot be built (cross-object cycles are rejected at activation, Q5, L4).
- **A throwing derive** fails only itself: its `value` throws the error, its watches end `{ reason: "failed", error }`,
  its sinks get a failure, and derives over it fail with the same error. It stays failed (broken: no automatic
  retry; L4 rebuilds it on reload). The publication and every other consumer continue.
- No `previous` (W14). The footgun and its remedy are documentation: a derive that builds new objects for unchanged
  data costs O(value) per flush per consumer; `mapShared` (section 7) keeps unchanged elements identical.

## 4. Constant and writable (R23, W4)

- `constant(value)`: a `Watchable` that never changes; its watches never get a frame and end only by `stop` or
  cancellation. No publication needed. Used for start data.
- `writable(initial, publication)`: a `NativeWatchable` with `set(value)`; `set` publishes by itself (one publication
  per call); an identical value (`===`) publishes nothing. Used for registry contributions known only at runtime.

## 5. Watch handles (W2, W3; Chord's shared implementation)

L2 does not implement watch handles: it uses the one implementation in Chord's `src/watch.ts` (Durable's semantics,
moved there by the pi change). Sources create a handle per `watch(context)` and feed it: `advance` per publication
(during the flush, by reference), `retire`, `end`, `end({ error })`, cancellation from the context's signal.

- `watch(context)` returns the handle at once (the Promise resolves immediately for local sources; L5 reference
  members may wait). It holds the value current at acquisition and buffers every later publication.
- `start(listener)` installs the one listener; frames are delivered in order, each awaited, never inline; the listener
  gets a context without the abort signal.
- **Overflow:** after 100 pending frames the backlog collapses: JSON to one frame `[["r", newest]]`, native to the
  newest value.
- **Retirement** is an explicit source event (`source.retire()`, used by L3 for retired documents): the last frame is
  `[["r", null]]` with value `null`, then the watch ends `retired`. Never inferred from a `null` value (W2a).
- **Ends:** `stopped`, `cancelled`, `retired`, `ended` (the source ended), `failed { error }` (the source failed, e.g.
  a throwing derive), `listener_error { error }`; `stop` drops pending frames and never aborts or awaits a running call.
  Termination clears every reference into the source (W3).
- `NativeWatchHandle<T>`: the same lifecycle with listener `(value, context)`.
- **W2b** (routines delivering the acquisition value first) is L8's.

## 6. Sinks (internal, for L6 and L9)

A sink is a synchronous consumer inside the flush, used where a watch's asynchronous delivery is too late: the wire
encoder (L6: one part per hold, one message per link per publication) and registry composition (L9).

```ts
const sink = attach(watchable, { update(value, ops) {...}, fail(error) {...}, end() {...} });  // returns detach()
```

- `update` is called once per publication that touched the source, during the flush, with that publication's ops
  (several sets of one source within one publication arrive as one batch, in order). Native sources: `update(value)`.
- A sink counts as a consumer (derives over the source stay attached). `detach()` removes it; detaching inside the
  flush throws `invalid/reentrant`.
- Not exported to apps; L4-L9 import it from `next/watch`.

## 7. `mapShared` (W14, design §12)

`mapShared(f)` returns a function over arrays that calls `f` only for elements it has not seen (by identity) and
returns the previous result for unchanged ones, so a derive over a list of 2,000 notes with one change builds one new
object and `diffRevisions` emits one op. The cache is a `WeakMap` from source element to result.

## Cost per hop

| Hop | Work |
| --- | --- |
| a publication | per set source: pointer swap, O(1) per dependent (mark, append ops by reference) |
| flush | each dirty consumed derive: one compute plus one `diffRevisions`; nothing for unconsumed derives |
| a watch frame | the value and ops by reference; no copy, no diff |
| a sink update | the ops by reference |
| an unconsumed derive read | one compute if a source moved, else nothing |
| constant | nothing |

**Counters** (telemetry, the function doing the work counts it): `chord.watch.computes` (derive computes) and
`chord.watch.diffs` (`diffRevisions` calls). No walks or copies anywhere in L2.

## Footguns

- A derive that rebuilds unchanged data costs O(value) per flush per consumer (use `mapShared`; R24: changing one
  item of a flat array still copies the array's slots).
- Mutating a value in place breaks every consumer silently (immutable by convention).
- Async work in a derive is impossible by design; it belongs in a routine (L8) writing an in-memory document.

## Tests (one group per mechanism, every case)

- Publication: several sources in one publication reach a watch as consecutive frames and a sink as one batch;
  publication numbers increase; setting outside `publish` throws.
- Derives: dependency order (diamond: A→B, A→C, B+C→D computes D once, after B and C); identical result publishes
  nothing; native source marks without ops; lazy read recomputes only after a source moved; attach on first consumer,
  detach after the last (no subscription left; GC); a chain A→B→C where B throws (C fails, A's other consumers
  continue); a failed derive stays failed.
- Two sources published alternately with a derive over both: the derive sees every combination exactly once per
  publication.
- Reentrancy: `publish`, `watch`, `attach`, `writable.set`, `detach` inside a derive and inside a sink throw
  `invalid/reentrant`; `stop` inside a sink or listener is allowed and delivery continues correctly.
- Watch handles (the handle itself is tested in Chord's shared tests): through L2 sources, a watch started after 150
  publications; retire; end and fail from the source; stop during a running call; cancellation by the context.
- Constant and writable: constant never delivers; writable identical set publishes nothing.
- `mapShared`: unchanged elements return the identical result; a changed element is recomputed.
- Sinks: one batch per publication; failure and end; detach.
- Cost guards: computes and diffs per hop (an unconsumed derive computes nothing on publish).
- GC: stopped handles hold no source; unconsumed derives hold no subscription and are collected with their sources;
  `mapShared` caches drop with their elements; retained revisions after overflow are bounded (W1's GC count).

## Size

Target: about 500 source lines, tests excluded.

## Decided while specifying (owner, 2026-10-22)

- **Watchable state is JSON only.** No bytes in documents, derives, reference members or any watchable value; bytes
  appear only in method arguments and results (passed whole, carried as raw byte segments by L6) and in chunked
  transfers. Delta stays JSON-only. Supersedes W4's "JSON plus bytes" for watchables.
- **`mapShared` lives in `next/watch/`** for now; it moves into Delta when v2 goes upstream.
- **C10 rejected:** `constant` (JSON `Watchable`) and `writable` (`NativeWatchable`) stay two, because Q14 needs the
  kind distinction.
- **One publication per host** (`createPublication()`, created by the host and passed to every source, derive and
  writable on it; apps never see it), never a module-level singleton.
- **No CBOR:** the wire stays JSON plus raw byte segments (R1, Q4); revisit only if L6 benchmarks show encoding as a
  bottleneck.
