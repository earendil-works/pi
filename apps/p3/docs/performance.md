# Memory and performance

p3 runs dozens to hundreds of session workers on one machine, a phone among the targets. Every package measures what
it touches and reports the numbers in its Linear issue; a number that gets worse says why.

## The budget: 55 MiB per session worker

No session worker's USS (the memory only that process holds: what one more worker costs) may exceed 55 MiB, in any
phase. The memory test (`apps/p3/test/release/memory.test.ts`, run by `npm run release:p3:local`) checks it: four
workers, each with Durable's harness, the coding tools, a subagent tool, real pi-ai providers against a local HTTPS
stub and telemetry; idle, one streamed answer, a burst of 20 turns with tool calls, five subagents streaming at once.

Where it stands (slayer, Node 26.11.1, the release, USS MiB, median of 20 workers):

| idle | after an answer | burst peak | after the burst | 5 subagents, peak |
| --- | --- | --- | --- | --- |
| 17.9 | 28.6 | 41.4 | 33.8 | 46.7 (worst worker 47.9) |

The margin is about 7 MiB. **A package that adds to the worker shows the memory test before and after.** Known
costs to plan for: code mode inline adds about 10 MiB after its first script and peaks near the budget; an SSH
environment adds under 1 MiB in the worker plus 1.6 MiB for its `ssh` process; a provider's first request loads its
SDK and Node's HTTP client.

What keeps it there (do not undo): each process has a bundle of its own (a worker loads none of the server's code);
the provider SDKs are bundled and load per provider on first use; the worker's V8 flags (`WORKER_V8_FLAGS` in
`apps/p3/src/install.ts`: `--liftoff-only`, `--optimize-for-size`, `--max-semi-space-size=4`,
`--gc-memory-reducer-start-delay-ms=8000`, `--managed-zone-memory`); the compile cache flushed after a worker starts.

## Other numbers

| What | slayer, release | the phone, from source |
| --- | --- | --- |
| server launch to listening, warm | about 105 ms | 1.6 to 1.9 s |
| worker start, warm | about 70 ms | about 1 s |
| idle worker, settled | about 18 MiB | 19.6 MiB |
| server, settled | about 34 MiB | 44 to 46 MiB |
| plain `p3` to its owner link | about 250 ms | 3.4 to 3.9 s |
| the owner's list, open / `more`, at 100,000 sessions | 0.6 / 0.45 ms | 3.4 to 5.3 / 2.6 to 4.5 ms |

- **Every start builds every plugin again** (no build cache): about 30 ms for one plugin today, one esbuild call per
  facet. A package with large facets says what it adds to the start, on the phone too.
- **Telemetry:** a healthy turn should store no spans; at most 1 KB of metrics per process per 10 s; the store
  bounded by size (slice 28's targets, `slices/28-telemetry.md`).
- **Bytes on the wire:** none measured per action yet. A UI package sets a budget for its common actions (opening a
  session, switching conversations, a streamed answer) and measures it with `chord.link.bytes`. The page bundle starts
  at about 140 KB gzipped for Chord's web client alone.

## How to measure

- **Memory:** USS = `Private_Clean + Private_Dirty` from `/proc/<pid>/smaps_rollup`; PSS from the same file for
  several processes at once. Read **settled**: V8 shrinks the heap some seconds after work, so wait until the USS
  moves less than 0.25 MiB over 4 s (the memory test's rule) or 40 s.
- **Time:** medians of 20 or more runs, min and max beside them, the first (cold) run reported apart.
- **Compare** A and B built from the same commit, alternating in the same runs, on a quiet machine; slayer is shared,
  so note its load.
- **Where:** slayer and the phone; source and release. Name the machine, the Node, the layout, the date and n.
- **A bench per package:** `apps/p3/bench/<name>.ts`, modelled on `bench/slice-1.ts` (launched processes, both
  layouts, `--release <install>`). `NODE_DEBUG=p3` prints what a start spends building.

## Rules

- No work on a hot path that nobody asked for: no walks, copies, compilations or allocations per call.
- Caches are `WeakMap`s keyed by their owner, with a GC test. No module-level strong caches: after a reload they keep
  the old code alive.
- Plugins load whole at start (no `import()`). Keep worker facets small; put rarely used heavy code on the server, not
  in every worker. A heavy library in a worker facet: measure its cost per idle worker and bring it to Mario first.
- Two plugins inlining the same library load it twice per process: share it through a contract or a registry.
- Open natives (sandboxes, connections) on first use and reuse one per worker; a process or thread per task is
  expensive.
- Hot values (streaming text, progress) never go into a table a list reads.
- No new dependency, flag or process without a measurement before and after.
- No `--enable-source-maps` in workers: Node parses the whole map at the first stack trace (tens of MiB).

## Traps seen so far

| Trap | Cost | Fix |
| --- | --- | --- |
| recording every telemetry span (p2) | 1 GB and a third of a core in 15 h on the phone | keep failed or slow traces only |
| a worker thread per code-mode script (p2) | 10 to 28 MiB per worker | QuickJS inline, opened on first use |
| several SSH connections opened one after another (p2) | about 2 s on the phone | one connection per worker, reused |
| the worker sharing a bundle chunk with the server | 5 MiB per worker | a bundle per process |
| SDKs loaded from `node_modules` instead of bundled | 4 to 5 MiB per worker | bundled, per provider |
| WebAssembly compiled a second time, optimized | 8 to 10 MiB per worker | `--liftoff-only` |
| a memory reading taken right after work | readings too high | settled readings |
| a list cost measured once after a start | 2.3 ms reported, 0.7 ms real | medians, cold run apart |
| an ordered `inArray`, a count behind a hot column, one index for two lists | every row read, every page sorted | see `chord-practices.md`, Rules |
