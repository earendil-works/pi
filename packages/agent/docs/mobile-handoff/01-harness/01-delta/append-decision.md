# Decision: no explicit text append/truncate API

**Status: closed.** Do not add `appendText`, explicit truncate, a text-specific dirty-node kind, or proxy-to-tracker lookup machinery.

## Why it was considered

The tracker marks dirty paths and compares them with its accepted baseline at `flush()`. For a growing or rolling string, confirming the relationship can scan the retained string even though the producer already knows it appended or evicted text.

The original benchmark made this look expensive because its append fast path used `after.startsWith(before)`. V8 walked the producer's cons string character by character. Production Chord now uses:

```ts
if (after.length > before.length && after.slice(0, before.length) === before) {
  // emit append
}
```

The slice flattens once and comparison uses the native string path. Flush-time dirty tracking also removed the prototype's retained-op amplification.

## Local confirmation

Measured 2026-09-01 against `origin/dev` at `1a7bc80e7`, using `packages/chord/src/delta/index.ts` directly under Node 26.0.0 on an Apple M5 Max. Each workload used 3,000 warmups followed by 11 samples of 10,000 mutation-plus-flush iterations; a second process reproduced the result.

| Workload | Median µs/flush, run 1 | Median µs/flush, run 2 |
| --- | ---: | ---: |
| 200 KB assistant string, append 8 characters | 18.68 | 17.81 |
| 50 KB rolling window, slide 32 varied characters | 2.46 | 2.43 |
| Transcript push, one small entry | 0.74 | 0.78 |

The assistant tracker started with 200,000 varied characters, appended `" abcdef"`, and flushed each append. The rolling tracker started with 50,000 varied characters, then assigned `text.slice(32) + chunk` using a distinct 32-character `chunk:<base36 index>:durable-stream` value on every flush; every flush was asserted to emit `t` + `a`. The transcript tracker pushed `{ id: "e<index>", text: "message <index>" }` and asserted one `p` per flush. Setup and garbage collection were outside each timed loop.

At 100 assistant updates per second, the growing-string case consumes about 1.8 ms/s, approximately 0.18% of one core. The measured rolling-window cost is itself too small to justify the abandoned explicit API.

## Why the API is rejected

The prototype required a text-specific dirty-node state, proxy-to-tracker lookup, repeated-append/drop folding, and interaction rules for later whole-value replacement. It produced subtle silent failures: one implementation fell through to the ordinary differ while tests still passed, and another drifted when drops reached into earlier appends.

That complexity does not justify saving microseconds below the surrounding replication, isolation, and rendering costs. Keep ordinary string mutation and the generic Chord op vocabulary.

Reopen only when a production profile shows delta flush time is a meaningful fraction of a real workload. Re-measure the generic fast path first; a regression there is cheaper and safer to fix than adding a producer-specific API.
