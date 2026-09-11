# 01-delta: known defects and measured findings

Everything here was found **after** `delta.md` and the prototype implementation beside it were written. None of it is applied to the code in this directory. Production now lives in `packages/chord/src/delta/index.ts`: flush-time dirty tracking resolves D1, and production remeasurement closes D2 without a new API. See [`append-decision.md`](append-decision.md). Each item below remains the original problem, evidence, and candidate-fix record.

Every number was measured with **`node --experimental-strip-types`**, not `tsx`.
That matters: tsx transpiles through esbuild and inflated the same benchmark by
**2.6x** (183 µs vs 63 µs per write). Do not benchmark this module through a
transpiler.

---

## D1. Interleaved paths defeat coalescing (correctness-adjacent, unbounded memory)

**Severity: high.** This is the one to fix first.

### Problem

`flush()` coalesces only **adjacent** ops. A producer that alternates between two
paths therefore never coalesces anything, and the ops array grows with the number
of writes rather than with the size of the value.

This is not hypothetical. It is exactly what bash does: it updates the output text
and a byte counter on every chunk.

```ts
const next = t.state.content[0].text + chunk;
t.state.content[0].text = next.length > CAP ? next.slice(next.length - CAP) : next;
t.state.truncation.totalBytes += chunk.length;    // <- the other path
```

### Evidence

50 KB window, 200-byte chunks, no flush in between:

| held-back writes | ops | bytes |
| --- | --- | --- |
| 1 | 3 | 0.3 KB |
| 100 | 201 | 26 KB |
| **1000** | **2001** | **264 KB** |

Without interleaving the same workload gives 1 op and 51 KB. The window is
bounded at 50 KB; the ops describing it are not.

### Why it matters beyond memory

Any design where the sink **holds back** — rate limiting, backpressure, a slow
consumer — depends on held-back writes costing nothing. They currently cost
everything. See `../../04-tool-output/rate-limiting.md`.

### Candidate fix

Fold at **record** time, keyed by path rather than by adjacency: one slot per
path holding at most two ops (`[s]`, `[d]`, `[t]`, `[a]`, or `[t, a]`), emitted in
first-touch order.

A prototype reached **2 ops / 51 KB** on the same workload. It is not included
here because it was not verified to the standard the rest of this unit meets.

**Four folding rules, each a specific claim about the vocabulary:**

1. A later `s` supersedes an earlier `s` on the same path — but **not** an earlier
   `d`, which must survive or the key changes position on reinsertion (§5.1).
2. Consecutive `a` merge. Once the merged append is **strictly longer** than the
   value, the window has been sliding and the append is the more expensive
   spelling, so collapse to `s`. Strictly: while a string is still *growing*
   toward its cap the append equals the value, and collapsing there would resend
   the whole string every batch.
3. `t` and `a` on one path **commute** — the truncate drops from the front, the
   append adds to the end — so a rolling window's `t,a,t,a,...` folds to one of
   each. Without this, pairwise merging never fires at all.
4. `t` or `a` following a pending `s` changes nothing: the `s` already means "this
   path becomes its current value".

**The trap that prototype hit.** Slots emit in first-touch order, which loses the
fact that a child write happened *before* a later parent write:

```
script  : a={x:1}; a.b=99; a={c:2}
producer: {"a":{"c":2}}
replica : {"a":{"c":2,"b":99}}      <- WRONG
```

A set or delete must invalidate every pending slot **below** its path, at record
time. The existing `verify-dead` style test passed 1190 sequences while this was
broken, because its generator only nested one level. Any test for this must
generate genuinely nested paths with parent overwrites interleaved between child
writes.

---

## D2. `overlap()` was 94.5% of prototype tracker time — closed

**Historical severity: high. Production decision:** do not add an explicit append/truncate API. The prototype profile was dominated by a slow `startsWith` path; production uses a flattened-slice comparison and measured 17.8–18.7 µs per 200 KB assistant append flush and 2.43–2.46 µs per 50 KB rolling-window flush locally. See [`append-decision.md`](append-decision.md). The original evidence follows.

### Problem

The tracker infers "you appended and evicted" by searching two 50 KB strings.
Each new value produced by `next.slice(-CAP)` is a V8 `SlicedString` — a lazy
substring — and `indexOf`/`endsWith` force it to **flatten**, copying 50 KB per
call.

### Evidence

CPU profile of a 20 000-write rolling-window loop, node, flush at the end:

```
  94.5%  overlap
   2.7%  (anon)
   1.2%  (garbage collector)
   0.5%  set
   0.3%  emit
   0.0%  fold
```

And the flattening is directly observable:

| `overlap()` on a 50 KB window | µs |
| --- | --- |
| the same two strings reused | 37 |
| **a fresh sliced string each call** | **149** |

An earlier benchmark reported 29 µs because it reused two already-flattened
strings 2000 times — a case that never occurs in the real loop. **Do not benchmark
string operations against a reused fixture.**

### Candidate fix

Do not infer what the producer already knows. `ToolOutput` performs the windowing,
so it can emit the ops directly rather than assigning a new string and having the
tracker search for the difference:

```ts
out.append(chunk);       // -> ["t", path, dropped], ["a", path, chunk]
```

Two integers — chars appended, chars evicted — describe everything that happened
between any two observations of a bounded window. A prototype of this shape held
**exactly the window** in memory under every load, with no ops array, no overlap
detection and no folding rules at all.

This does **not** remove `overlap`: it stays for the general case where a producer
assigns a whole new string and the delta genuinely has to be discovered. It
removes it from the hot path.

### Do not

Do not "optimise" `overlap` itself before doing the above. Its algorithm is
already correct and bounded (`maxOverlapScan`); the cost is string flattening,
which no probe strategy avoids.

---

## D3. Nested-path proxy overhead is next, and currently invisible

**Severity: unknown — measure before acting.**

`overlap` dominates so completely that nothing else shows in a profile. But two
benchmarks disagree in a way that points at path depth:

| | µs per write |
| --- | --- |
| top-level path (`{ text }`) | 63 |
| nested path (`{ content: [{ text }] }`) | 244 |

4x for depth alone. Each nested property access wraps a child proxy and builds a
cache key by joining the path, so a read of `content[0].text` allocates on every
access.

**Re-profile only if production delta cost becomes material.** This may be the next bottleneck or it may be
nothing; the current numbers cannot distinguish them because `overlap` swamps both.

---

## D4. Things measured and found NOT worth doing

Recorded so nobody repeats the work. All were under **1.5% combined** in the
profile above.

**A path trie replacing `JSON.stringify(path)` keys.** Genuinely faster in
isolation — 6x on the `LaneSnapshot` shape, 93x at 500 distinct paths — because
stringify cost scales with path depth while a trie walk is one `Map.get` per
segment. But the whole slot layer is 0.5% of runtime. Build it only if a current production profile says so.

**Trie as storage vs trie as index.** If a trie is ever built, it should map path
to a **position in the ops array**, not hold the ops. Holding them loses first-touch
ordering and forces a sort at flush to rebuild it. Measured difference: none
(1.4x / 0.9x / 1.0x). The argument is structural, not performance.

**A `maxDepth` heuristic to skip descendant scanning.** Rejected: the flat map was
losing on the common case too, so the heuristic would have hidden a real cost
rather than removed it.

**Eager string concatenation in the `a`+`a` merge.** Real (it rebuilds a growing
string per write) but worth ~5%. Compare lengths and materialise only when
emitting.

---

## D5. Measurement errors made while producing these numbers

Listed because each one produced a confident wrong conclusion, and the same traps
are still there.

- **Benchmarking through `tsx`** — inflated everything 2.6x.
- **Reusing a flattened string** in a string benchmark — hid the real cost 4x.
- **Repetitive fixtures** (`"x".repeat(n)`) — overlap detection hits its candidate
  bound and gives up, so the benchmark measures the fallback path, not the real one.
  Use varied text.
- **Measuring a cache hit as if it were work** — `Markdown.render()` returns
  `cachedLines` when text and width are unchanged, so a repeat-the-same-call loop
  measured 0.065 ms for something that costs 0.86 ms.
- **Reasoning about complexity while the constant dominated** — twice.
- **Measuring heap instead of retained size** — a fixture generating 800 x 1 MB
  strings reported 40 MB of "growth" that was its own garbage.
