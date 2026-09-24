# Chord delta investigation findings

## Decision and scope

The standalone ID-addressed graph tracker experiment was removed. It solved
reference reassignment and replicated identity, but its memory, import, and
hydration costs were unacceptable for the drawing workload. This rejects the
measured implementation, not every possible graph representation.

Keep the existing tree/path delta implementation, its weak proxy-cache changes,
and the spread-first cloning improvement. Keeping the weak-cache patch is not a
claim that its performance is satisfactory: permanent retention improved greatly,
but exhaustive reads still allocate gigabytes and became slower.

The graph prototype never had a package export or Chord service integration.
Removing it does not change State/ReplicatedState or adopt graph semantics in the
Pico specifications. Existing delta alias behavior remains a separate correctness
problem; this investigation did not establish general mutable-graph correctness
for the tree protocol.

## Workload and measurement rules

Measured on an Apple M5 Max with 128 GiB RAM, Node v26.0.0. The document contains
20,000 strokes with 100 separately allocated `{ x, y, pressure }` point objects
each: two million points, approximately 2.04 million total objects/arrays. It is
not a packed numeric buffer. Full traversal uses a flat strokes array; mutation
benchmarks partition strokes into layers and include a 200 KB string.

The plain document occupies about **139.5 MiB of JavaScript heap**. Its roughly
66 MB serialized representation is a different measurement.

- Use independent processes, three trials per configuration, and rotated variant
  order. Report medians. Large graph/traversal workers used an 8 GiB V8 heap limit.
- Separate initial import, snapshot publication, mutation, flush, JSON encoding,
  decoding, and replica application. Fixture construction is outside mutation
  timing; importing a newly assigned object is inside it.
- Measure producer-only and producer-plus-replica memory separately. Release raw
  graph inputs and emitted batches in separate call frames before retained-heap
  measurements; otherwise temporary references can pin entire extra documents.
- Ready/retained heap is measured after GC, relative to the warmed empty process.
  Sampled heap includes temporary allocations and uncollected garbage. It is not
  an exact allocation peak. Maximum RSS includes heap capacity and native/runtime
  allocations, not just live JavaScript objects.
- Weak-reference reclamation requires real job/event-loop boundaries, not merely
  a synchronous `global.gc()` after a loop. Yield, collect, and let finalizers run.
- Validate serialized replay outside timing. Graph correctness must compare
  identity/topology as well as values: deep equality alone misses lost aliases.
- Raw-object and minimal-proxy controls perform no replication. They are local
  cost floors, not equivalent implementations.

The historical measurements below predate the final spread-first clone change
unless explicitly stated. They are not new measurements of the current source.

## Operation log versus cloned baseline

The operation log at `2c995acf4` compares whole-container assignments immediately
and coalesces recorded operations. The baseline design at `86bac52f9` marks dirty
paths, compares against a retained copy at flush, and refreshes that copy.

A layer swap illustrates the difference. Two independently allocated layers can
have equal geometry and different names. Both designs eventually emit just two
name sets, **73 bytes**, but still inspect the geometry to discover that result.
The baseline additionally refreshes its copy. Tiny output does not imply cheap
mutation or flush.

For a fair clone-cost comparison, only the baseline's `cloneJson` helper was
replaced with the exact helper from `2c995acf4`. No diff, coalescing, baseline
refresh, or proxy behavior changed. This was the earlier dynamic-assignment
helper, not the later spread-first helper.

Mutation plus flush, milliseconds:

| Workload | Original baseline | Matched-clone baseline | Operation log |
| --- | ---: | ---: | ---: |
| One stroke swap | 0.114 | 0.086 | 0.085 |
| Swap 1,000-stroke layers | 89.940 | 47.924 | 21.048 |
| Swap 10,000-stroke layers | 906.390 | 483.264 | 214.425 |
| Ten 1,000-stroke swaps before flush | 90.598 | 49.455 | 209.346 |
| Sixty selections before flush | 0.121 | 0.101 | 2.346 |
| Swap dissimilar 100-stroke layers | 12.097 | 7.515 | 168.273 |

Batching favors the baseline because it compares the final dirty region once;
the operation log pays assignment-time comparison repeatedly. Ten swaps restore
the original value and emit no operations in all three variants. The dissimilar
case triggers the operation log's 4,096-metadata threshold and publishes a roughly
66 MB root replacement; the baselines emit about 2 MB of patches. This difference
is not caused by the cloning helper.

All 63 independent-process configurations completed. Small-fixture checks and
full-size serialized replay checks passed; original and matched-clone baselines
emitted identical batches in the checked cases. RHS references came from
`tracker.target` to model unwrapping. These benchmarks do **not** establish general
alias correctness.

### Semantics cannot be inferred from passing performance cases

Historical probes found replica divergences around aliases, held references,
reindexing, and detach/reinsert, despite the existing tests passing. The baseline
also diverged for shared initial objects and held elements after `unshift`.

For example, selecting an item by reference and subsequently editing it means
two producer paths observe one object. A tree replica holds two separate copies;
it needs updates at both paths. Keeping a reference across an array insertion
also means subsequent writes must follow the object's new position, not its old
index. Neither cloning a baseline nor caching a proxy at a path automatically
solves these cases.

Other approaches considered:

- Deep copy-on-assignment changes alias semantics and adds traversal/allocation.
  Earlier clone measurements were about 7.4 ms for 1,000 strokes, 76.6 ms for
  10,000, and 153.8 ms for 20,000. Adding copies increased a large swap from about
  213 ms to 385 ms. Those figures predate spread-first cloning.
- Persistent trees share unchanged structure and avoid a permanent complete
  baseline copy. They do not independently solve live aliases or relocation.
- A path-based wire copy operation needs ordering barriers: existing operation
  coalescing can otherwise change the source before the copy executes.
- Declared reference fields/application IDs, stricter tree ownership, and explicit
  path setters change the contract. No replacement API was selected; ordinary
  JavaScript mutation syntax remained the desired interface.

## What the graph experiment did

Each object/array became a canonical node with a numeric ID. Scalars were stored
inline; object edges referenced canonical nodes. A map indexed nodes by ID, a
weak map recognized imported raw objects, and lazy producer proxies exposed
ordinary mutation syntax. This was normalized graph storage, not a reverse-edge
index layered beside a second complete document.

Wire references used `["@", id]`, with separate object/array definitions and
ID-addressed set, delete, splice, length, and release operations. Revisioned
snapshots allowed recovery. Replicas allocated shells before linking definitions,
materializing actual JavaScript objects with aliases and cycles. Incremental
updates preserved held replica identities; rebasing reset identities.

Known-object assignments became reference writes. Swapping two huge layers no
longer walked their descendants. Fresh independently reconstructed equal objects
were new identities, however, and needed complete definitions rather than a
small value diff. Detached nodes remained resident until explicit collection.

Fifty tests covered topology, cycles, held references, array operations, import
rollback, revision recovery, collection, and deterministic mixed mutations. The
full benchmark completed 120 independent processes with value validation and
held-identity checks for graph swaps. The initial full-traversal comparison added
12 processes. Correctness on these cases did not make the implementation cheap.

### Graph mutation and publication costs

Historical sibling delta before the weak-cache change versus graph, mutation
plus flush:

| Workload | Tree delta ms | Graph ms | Tree bytes | Graph bytes |
| --- | ---: | ---: | ---: | ---: |
| 100 scattered edits | 0.265 | 0.158 | 5,243 | 2,235 |
| Swap 1,000-stroke layers | 21.523 | 0.002334 | 73 | 111 |
| Swap 10,000-stroke layers | 221.373 | 0.002584 | 73 | 109 |
| Ten 1,000-stroke swaps before flush | 211.370 | 0.015083 | 2 | 471 |
| Sixty selections before flush | 0.768 | 0.046125 | 66 | 102 |
| Append one new 100-point stroke | 0.011 | 0.095 | 3,357 | 7,567 |
| Fresh equal-geometry 1,000-stroke layer | 12.311 | 78.716 | 37 | 7,440,956 |
| Append ten characters to a 200 KB string | 0.010 | 0.000958 | 29 | 200,299 |

Graph bytes include its envelope; tree bytes are decoded operation arrays, not
path-dictionary encoding. The formats provide different identity guarantees.
The graph retained ordered reference writes for cancelled swaps. Its missing
string append/truncate compression was a prototype limitation, not an inherent
cost of graph addressing.

With JSON encode/decode and replica application included, the fresh-layer case
cost **165.773 ms** for graph versus **12.017 ms** for tree delta. The 10,000-stroke
swap pipeline cost **0.009958 ms** versus **214.119 ms**. Initial import and
hydration are not included in those incremental numbers.

Twenty thousand hot nested reads cost about **20.84 ms** for graph, **9.12 ms** for
tree delta, **6.79 ms** for a minimal proxy, and **0.082 ms** for raw objects. This
small working set touched only 1,000 points and missed exhaustive-read allocation.

### Initial graph costs and lifetime

Representative scalar-workload measurements:

| Metric | Tree delta | Graph |
| --- | ---: | ---: |
| Ready producer heap | 139.5 MiB | 430.4 MiB |
| Ready producer plus replica | 279.3 MiB | 719.3 MiB |
| Initial import | 0.020 ms | 1,118.907 ms |
| Snapshot flush | 169.218 ms | 594.904 ms |
| Snapshot wire size | 66,364,338 bytes | 147,487,101 bytes |
| Snapshot JSON encode | 176.961 ms | 366.942 ms |
| Snapshot JSON decode | 159.388 ms | 1,179.166 ms |
| Snapshot apply | 0.027 ms | 1,417.161 ms |
| Pipeline-process maximum RSS | 852.8 MiB | 4,978.0 MiB |

Snapshot phase timings came from a separately requested rebase. Tree application
adopts the already decoded snapshot; graph application validates and materializes
objects. RSS includes earlier import/hydration allocations and is not a minimum
live-set requirement.

Five fresh 1,000-stroke layer replacements grew graph producer heap from **430.2
to 563.9 MiB**. Explicit collection removed 510,010 nodes in **705.5 ms**, emitted
a **7.14 MB** release batch, and left **486.3 MiB** retained. Producer plus replica
went from **719.2 to 967.0 MiB**, then **831.2 MiB** after collection. Lookup-table
capacity and externally held values can prevent a return to the ready footprint.

Automatic collection, immutable historical snapshots, bounded logs, hardened
transport limits, and service integration were not implemented.

## Full traversal exposed the memory problem

Reading every point through producer proxies allocated wrappers for nearly every
container. Historical retained-heap results, after traversal and GC:

| Variant | Ready MiB | After full read MiB | Cold read ms | Warm read ms |
| --- | ---: | ---: | ---: | ---: |
| Raw document | 139.47 | 139.49 | 8.00 | 2.95 |
| Minimal cached read-only proxy | 139.47 | 452.50 | 705.10 | 550.35 |
| Tree delta before weak caches | 139.26 | 3,525.93 | 2,720.98 | 470.89 |
| Graph prototype | 430.39 | 2,159.75 | 1,437.65 | 388.74 |
| Historical matched-clone baseline | 294.22 | 2,228.71 | 827.13 | 360.95 |

The baseline row was measured in a later three-process run using asynchronous GC
boundaries, not extrapolated from its ready heap. Its immediately sampled heap
was **2,245.37 MiB** and maximum RSS **2,456.30 MiB**. No diff was running: this was
read-only traversal. All three historical trackers strongly cached wrappers.

### Existing delta: permanent retention fixed, allocation volume not fixed

A separate matched before/after run measured the weak-cache patch:

| Metric | Before | After |
| --- | ---: | ---: |
| Ready producer heap | 139.50 MiB | 139.50 MiB |
| Retained after traversal, job boundaries, and GC | 3,526.17 MiB | 203.54 MiB |
| Immediately sampled heap after cold read | 3,531.93 MiB | 2,491.78 MiB |
| Maximum RSS | 3,858.11 MiB | 3,391.06 MiB |
| Cold traversal | 2,397.40 ms | 6,298.76 ms |
| Warm same-job traversal | 466.43 ms | 844.13 ms |

These are separate runs from the preceding table. Warm time is the median of
three traversals per process after collection: the first reconstructs collected
wrappers and the following two reuse same-job caches.

The patch separates public proxies from entry/placement metadata, uses weak
ordinary caches and incarnation-safe finalizer cleanup, and keeps explicit alias
metadata separately. Held descendants retain ancestor metadata so array
reindexing still works if ancestor public proxies were collected. Assigned known
proxies are unwrapped, avoiding wrappers embedded in raw targets. Placement reuse
prevents duplicate splice emission after reindexing or reattachment. Shared
handlers, lazy child maps, and job-local caches reduce some overhead.

But one point read can still allocate a proxy, handler, tracking entry, placement
record, placement set, weak references, cache entries, and finalization records.
Across roughly two million containers, this is gigabytes. `WeakRef` targets newly
created or dereferenced during an uninterrupted synchronous traversal must remain
alive through that job. The temporary strong caches also survive until scheduled
microtask cleanup. Collection afterward does not prevent the allocation peak.

The remaining roughly **64 MiB** above the raw document after collection is
bookkeeping/index overhead; its exact composition needs a heap profile. The
roughly **1.2 KB per visited container** of additional immediately sampled heap is
an aggregate average, not an allocation-by-allocation attribution.

Eleven isolated GC regressions cover unused proxy reclamation, tracker disposal,
held identities and descendants, array reacquisition/reindexing, alias rewrapping,
detach/reinsert, root rebasing, blocked views, and repeated wide-root read windows.
Twelve windows over a 10,000-object root array retained about 0.35 MiB bookkeeping.
Normal mutation correctness must not depend on finalizers running promptly.

This patch does not resolve the general tree-protocol alias problem. Bulk
read-only inspection through `tracker.target` avoids proxy construction, but
writing through it bypasses tracking. That escape hatch does not make normal
producer-proxy traversal cheap.

## Clone layout: a separate, smaller improvement

Why did a 139.5 MiB document plus a baseline occupy 294.2 MiB rather than 279 MiB?
V8 layout inspection on this Node version showed:

- A literal `{ x, y, pressure }` occupies 48 bytes, with three in-object slots.
- Building `{}` by dynamic assignment occupies 56 bytes, with one unused slot.
- Two million points times eight bytes accounts for **15.26 MiB** extra.

The old clone therefore occupied about **154.7 MiB**, not 139.5 MiB. The discrepancy
was not hidden proxy allocation.

Shallow object spread followed by recursive replacement of object-valued children
kept the compact layout. Arrays retain their recursive array branch; null-prototype
objects retain a null prototype. Full-fixture clone-only measurements, three fresh
processes per method:

| Clone construction | Additional retained heap | Median clone time |
| --- | ---: | ---: |
| Dynamic property assignment | 154.725 MiB | 162.338 ms |
| Spread first, then recurse | 139.466 MiB | 93.924 ms |

This helper was adopted in existing delta. Regression tests cover detached nested
values, null prototypes, inherited-name collisions, independent expansion of
shared input values, and published payload isolation. V8 layouts/timings are
engine-specific. `structuredClone()` still produced the 56-byte point layout in
the layout probe; JSON round-trip produced 48-byte points but introduces text
encoding/decoding and temporary text allocation.

A baseline using the new helper would be expected to need about **279 MiB** for
document plus copy. That is an inference from measured clone sizes, not a rerun
of the complete historical baseline. The improvement does not address gigabytes
of proxy bookkeeping during traversal.

## Retained reproduction and provenance

From the repository root:

```sh
node --expose-gc packages/chord/test/delta-traversal.bench.ts --quick --out /tmp/delta-traversal-quick.json
node --expose-gc packages/chord/test/delta-traversal.bench.ts --out /tmp/delta-traversal.json
node --expose-gc packages/chord/test/delta-traversal.bench.ts --modes delta --out /tmp/delta-only.json
```

The retained benchmark supports raw, minimal-proxy, and current tree-delta modes.
It checks traversal results, uses separate processes, records source hashes, and
allows multiple event-loop/GC turns. It no longer contains the removed graph
implementation or reproduces the historical graph/mutation comparison.

Targeted tests from `packages/chord`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/delta.test.ts test/delta-clone.test.ts test/delta-tracker/retention.test.ts test/services.test.ts test/service-wire.test.ts test/facets.test.ts
```

Historical source identifiers:

- Baseline: `86bac52f9`; matched clone helper / operation log: `2c995acf4`.
- Pre-retention sibling delta SHA-256:
  `af008c77367a0ba362637b3b0422576c752a205339a33eb26479a41ac087957f`.
- Weak-cache delta before spread-first cloning:
  `7a51c9295543b6fb47e06d8460f122242ee9a96a0ef5653d5595b8219792a6d8`.
- Removed graph implementation:
  `90893bfa02a7aeb0fc1da9fdd62f53027ab3d22728337d00f7040c19344fec6c`.

The graph code was an uncommitted experiment; its hash identifies the measured
source but does not provide a Git revision from which to restore it. Historical
raw outputs were left in `/tmp/chord-graph-prototype/` (`full.json`,
`traversal-final.json`, `retention-before.json`, `retention-final.json`, and
`baseline-traversal.json`). Matched-baseline data was in
`/tmp/pi-copy-cost.QAlME4/`; clone-only samples in `/tmp/chord-clone-compare.jsonl`.
These are optional local artifacts, not durable dependencies of this document.

## Requirements for a future attempt

Start with exhaustive producer reads, not only small hot working sets and
mutation/flush benchmarks. Measure cold allocation, warm access, cross-job
reclamation, held identities, alias/reindex behavior, import, hydration, and
fresh-object replacement separately. Never present post-GC retained heap as peak
memory, tiny patches as proof of cheap comparison, or successful value replay as
proof of identity correctness.

No measured design in this investigation simultaneously achieved low retained
and transient memory, cheap ordinary reads, cheap large reference reassignment,
and the desired broad mutable-JavaScript semantics.
