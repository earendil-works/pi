# Memory and performance

p3 must be fast and use little memory (`../decisions.md`, "Efficiency is a requirement"): dozens to hundreds of
session workers on one reasonably beefy machine, a phone among the targets, and a snappy UI. Every package measures
what it touches, on slayer and on the phone, and reports the numbers in its brief. A package that makes a number worse
says why.

This guide copies the numbers in, each with where it comes from, so it needs no private file. Paths are relative to
`apps/p3/` unless they start with `packages/`, `apps/p2/` or `../`.

## Budgets and numbers

### The session worker: 55 MiB USS, always

**The budget.** No session worker's USS (the memory no other process shares: what one more worker costs) may exceed
**55 MiB** in any phase (`../decisions.md`, "Session worker memory levers and a budget"; `../slices/26-release.md`,
"Session worker memory").

**The memory test** (`test/release/memory.test.ts`, with `test/memory/`; run by `npm run release:p3:local`): four
workers at once, each with a real Durable harness, the coding tools, a subagent tool, pi-ai's Anthropic and OpenAI
providers against a local HTTPS stub, and telemetry sent every second. The schedule: idle; one streamed answer (8 KB
over 15 s); a burst of 20 turns with tool calls; five subagents streaming at once; idle after each phase. USS is
sampled every 250 ms; the test fails when any sample exceeds 55 MiB, naming the phase, the peak and the settled
values.

**Why 55, not lower.** After five parallel streams glibc keeps about 10 MiB it freed (`malloc_info`: 10 to 11 MiB
kept free); the session's own data is about 4 MiB of the heap. A glibc setting returns it, on Linux only, so it was not
taken. At 50, Node 26's workers failed one run in five before the last two flags.

**Where it stands** (slayer, Node 26.11.1, the release, all levers, 5 runs × 4 workers, USS MiB, median
[min–max]; `../slices/26-release.md`, 2026-11-18):

| Reading | USS |
| --- | --- |
| idle, settled | 17.9 [17.7–20.1] |
| after the first streamed answer | 28.6 [27.7–30.0] |
| burst of 20 turns, peak | 41.4 [40.8–42.9] |
| after the burst | 33.8 [33.1–34.5] |
| five subagents, peak | 46.7 [44.8–47.9] |
| highest of a run | 46.7 [44.8–47.9]: 7.1 MiB below the budget at the worst worker |

Before the levers the same test peaked at 77.3 MiB (in the burst). The margin is small: **a package that adds to the
worker shows its effect on the memory test.**

**The worker's V8 flags** (`WORKER_V8_FLAGS` in `src/install.ts`; in the worker's `execArgv`, never only in
`npm test`):

| Flag | Why |
| --- | --- |
| `--liftoff-only` | WebAssembly (undici's HTTP parser) is never compiled a second time, optimized: that compile's freed memory stayed with the process, 8 to 10 MiB with several streams |
| `--optimize-for-size` | a smaller heap and young generation in a burst, for a few percent of CPU |
| `--max-semi-space-size=4` | a young generation of at most 4 MiB a semi-space |
| `--gc-memory-reducer-start-delay-ms=8000` | V8 shrinks the heap 8 s after work, not 30 s (Node 26's default): after a burst 37.2 instead of 42.8 MiB |
| `--managed-zone-memory` | V8 pools its compilers' zone memory instead of taking it from malloc, so glibc keeps less: 1 to 6 MiB lower in every reading, no CPU cost measured |

Background recompilation stays on: turning it off saves 1.5 to 2.5 MiB for up to 25% more CPU.

**The other levers** (`../slices/26-release.md`): a bundle per process, so a worker loads none of the server's code
(−5 MiB per idle worker, a warm start 12 ms faster); the provider SDKs bundled into the worker, in lazy chunks per API
(−4 to −5 MiB); Chord's worker base minified (names kept); `flushCompileCache()` after a worker started
(`src/kit/worker.ts`), so later workers start warm.

### Starts, the server, the commands

slayer (Linux x64), 2026-11-16, `bench/slice-1.ts`; medians; from `../slices/26-release.md` ("Numbers", "The
worker-only entry"). Source is the checkout (`--conditions=source`), release the installed package.

| | Source | Release |
| --- | --- | --- |
| process launch to listening, cold (empty compile cache) | 480–485 ms | 125–137 ms |
| process launch to listening, warm | 154–157 ms | 101–109 ms |
| the server's plugins built at start (one plugin) | 27 ms | 32–34 ms |
| the worker base built after the listen | 125–138 ms | 88–121 ms |
| worker start, cold (the first after a start) | 212–256 ms | 136–145 ms |
| worker start, warm (median of 10) | 90–92 ms | 69–71 ms |
| an idle worker's USS, settled | (not measured settled) | 18.7–18.9 MiB |
| the server's USS, settled (release); `RssAnon` (source) | 74.5 MiB `RssAnon` | 34.2–34.8 MiB |
| the supervisor's USS, settled | | 10.8–10.9 MiB |
| plain `p3`: a background start to its owner link (median of 20) | 398 ms | 252 ms |
| `p3` with the server running: a fresh link | 161 ms | 90 ms |
| `p3 status` | 170 ms | 109 ms |
| `p3 stop`, until the directory is free | 197 ms | 133 ms |

**The phone** (Android, Termux, Node 26.3.1), 2026-11-18, as reported by Mario's planning session (not yet in a
brief): an idle worker 19.6 MiB settled; a warm worker start about 1 s; the server 44–46 MiB settled; plain `p3` to its
owner link 3.4–3.9 s from source. The phone is about ten times slower than slayer at starts: measure there.

**A start builds every plugin again** (`../decisions.md`, "No build cache"): one esbuild call per facet, so the
server's start grows with every plugin (27–34 ms for the one plugin today; with the 60 or so p3 will have, most of a
start). A package with large facets says what it adds to the start.

### Code mode and remote environments

**Code mode** (`../slices/10-agents.md`, "Worker memory", mem-audit on the memory test's worker, Node 26.11.1, USS MiB,
medians):

| | idle | after the first script | after 20 scripts | after the burst | peak | runs over 55 |
| --- | --- | --- | --- | --- | --- | --- |
| no code mode | 21.7 | – | – | 36.2 | 51.2 | 0 of 6 |
| a worker thread per script (as p2) | 23.0 | 37.4 | 44.4 | 51.7 | 57.0 | 3 of 3 |
| QuickJS inline, in the worker's thread | 21.8 | 38.2 | 38.6 | 47.5 | 52.8 | 0 of 3 |

Decided: the sandbox runs inline (about 10 MiB less after the first script, 28 MiB less with five scripts at once; a
script takes 14 ms instead of 30); opened on first use (1.2 MiB less while unused), never closed when idle (a reopen
costs 21 to 37 ms); one sandbox per worker. Inline code mode plus an SSH environment peaks at 51 to 58 MiB: about one
worker per run over the budget. Durable keeps about 8 MiB more heap after 21 code mode turns with 63 nested calls;
trimming that is the first place to look. If that fails, the budget for code mode sessions is decided again (60 MiB
was proposed).

**Remote environments** (`../slices/08-environments.md`, "Worker memory"): an SSH environment costs the worker 0.3 to
0.8 MiB; the `ssh` client process on the Pi's machine 1.6 to 1.7 MiB; the far side (sshd and the `pi-env` daemon)
about 2.1 MiB. Decided: one connection per worker, reused for everything, subagents included. Sharing connections
across workers of one host is not built now.

**Models** (`../slices/07-models.md`, "Worker memory"): before the levers, a worker's first request added about 20 MiB
(Node's HTTP client with its WebAssembly parser and its optimized compile about 12, the provider SDKs 5–6, compiled
code 4, data under 1). Slice 7 measures again when the harness and real providers arrive.

### Telemetry (PROPOSED targets, `../slices/28-telemetry.md`)

p2 recorded every span; on the phone that was 1.8M spans, 1 GB and about a third of a core in 15 hours, and p2 turned
telemetry off. p3's targets, for slice 28 (`bench/slice-28.ts`, PROPOSED):

| What | Target | p2, measured |
| --- | --- | --- |
| spans stored for a healthy prompt | 0 (at most rare always-kept ones) | 211 |
| a worker's telemetry bytes on its link per turn | none beyond its metrics | about 22 KB |
| metrics on the wire per process | ≤ 1 KB per 10 s | 5.7 KB/min for the worker |
| disk written per hour, one busy agent | ≤ 10 MB | 2.7 GiB at the phone's rate on a 1 GB file |
| the store file | ≤ the budget (256 MB) plus one flush | no limit |
| recording a span (slayer) | ≤ 4 µs | 3.0 µs |
| the recorder's buffer per worker | ≤ 1 MiB | one second of spans |
| `findTraces` on a full 256 MB store | ≤ 50 ms | 265 ms at 1 GB |

Telemetry cost does not show in CPU at these rates; the cost is disk writes (36 times write amplification in SQLite's
WAL with scattered index inserts) and reads of a large file.

### Lists and queries

From `../slices/01-base-and-sessions.md` ("Numbers") and design §30. The owner's list over the WebSocket (50 rows),
medians of 30:

| | 1,000 sessions | 10,000 | 100,000 |
| --- | --- | --- | --- |
| open | 1.0–1.3 ms (first, cold) | 0.74 ms | 0.71–0.73 ms |
| `more` | 0.75 ms | 0.51 ms | 0.48 ms |

The size does not matter because both reads run on their index. A bare round trip is 0.1 to 0.2 ms; reading and the
link's encoding and decoding take about equal parts of the rest.

What Chord's reads cost (design §30, `plugin-authoring.md`):

- **A commit writing a table with live reads:** per read a set lookup, then at most one keyed probe (about 4 µs); one
  run for each read not skipped. A `tx.update` of columns a read does not use skips it for free; a `put` tells it
  nothing.
- **A read asks at most eight probes per commit;** past that it runs. Bulk writes cost one run per open read.
- **A live query of 100 rows:** about 60 µs per commit unwatched, 80 µs watched. A table written hundreds of times a
  second does not belong under live queries: use a document.
- **A count** reads every matching row on every run. Count only what a key or an index bounds, never behind a column
  every touch writes.
- **`exists`:** one index probe per row tested; never the selective part of a list.
- **SQLite is synchronous:** every query blocks its host's event loop. An `inArray` on one column ordered by another
  walks the order's whole index (all 10,000 rows in one case, `../chord-practices.md`): order by the `inArray`
  column first.
- **One index per list's order,** the key Chord appends included, or SQLite sorts every page (`testing.md`, plan
  tests).

### Bytes on the wire and the page

- **The page bundle:** `chord/web` minified is about 468 KB, 141 KB gzipped, when nothing is trimmed; a sync client is
  typically 20 to 40 KB (`../slices/README.md`, "Open"). Measure p2's real page bundle by module (esbuild's metafile)
  before the UI work. The terminal's base: Chord's board example is 489 KB (`../slices/27-terminal.md`).
- **Bytes per common action** (opening a session, switching conversations, a streamed answer): not measured in p3 yet.
  PROPOSED targets for the terminal list (`../slices/27-terminal.md`): ≤ 16 KiB to open a list of 50 rows, ≤ 1 KiB for
  one rename in an open list. A UI package sets a byte budget per common action and measures it
  (`chord.link.bytes`).
- **Rules from p2's efficiency work** (`../workflow.md`, "Numbers"): page-wide objects held once, outside keyed
  subtrees; lists per session or paged, never all children of all sessions; compression at the origin on every Node
  host; a byte budget per common action.

## How to measure

- **USS** is `Private_Clean + Private_Dirty` of `/proc/<pid>/smaps_rollup`: what one more process costs. **PSS** adds
  each shared page divided by the processes sharing it: use it for several workers at once. `RssAnon` is in
  `/proc/<pid>/status`. CPU time is fields 14 and 15 of `/proc/<pid>/stat` (100 ticks a second). Code:
  `bench/slice-1.ts` (`memory`), `test/release/memory.test.ts` (`uss`, `cpu`).
- **Settled readings.** V8's memory reducer runs some seconds after work; a reading taken before it is too high. The
  memory test waits at least 12 s and until the USS moved less than 0.25 MiB over 4 s (at most 40 s); the bench reads
  at 40 s. Report "after 1 s" and "settled" apart when both matter.
- **Medians of 20 or more runs,** with min and max. **The cold run apart:** the first run after a start compiles
  code (the list's open: 2.3 ms cold against 0.7 ms warm).
- **Compare alternately, serially, on an idle machine:** A and B built from the same commit, runs interleaved. slayer
  is shared (load averages of 10 were seen): note the load.
- **Both layouts and both machines:** source and release, slayer and the phone. Name the machine, the Node, the
  layout, the date and n in the brief.
- **A bench per package:** `bench/slice-<n>.ts` (`bench/slice-1.ts` is the model: launched processes, both layouts,
  `--release <install>`), at the sizes the brief states (1k, 10k, 100k rows).
- **Start timings:** `NODE_DEBUG=p3` prints what a start spends building plugins and the worker base
  (`src/kit/start-server.ts`), until startup spans replace it (slice 2, PROPOSED).
- **Counted work:** Chord's cost counters through the in-memory telemetry adapter (`testing.md`).

## Hot-path rules

- **No hot-path work a decision did not ask for:** no walks, copies, compilations or per-call allocations (Chord v2
  code style, root `AGENTS.md`). The function doing counted work counts it through its context.
- **Nothing measured or walked for telemetry:** only sizes the code already has (design §29).
- **Caches are `WeakMap`s keyed by their owner,** each with a GC test (`testing.md`). No module-level strong caches:
  a reload makes new objects, and a strong cache keeps the old ones alive.
- **Natives open on first use,** close with their owner (code mode's sandbox: 1.2 MiB less while unused).
- **Hot values stay out of listed tables:** a streaming token rewriting a session's row re-runs every list over it.
- **Lazy loading.** Base code: what an entry imports with a literal `import()` stays a chunk of its own, loaded on
  first use (design §23, "The worker base"; `splitting` in `scripts/build-release.ts`); the provider SDKs are such
  chunks. Plugins: the build refuses `import()`, and a facet's script, its npm dependencies inlined, is evaluated in
  every process of its kind at load. So keep worker facets small, and put rarely used heavy code where it runs least
  (the server, not every worker). **Open:** a way for a plugin to load a heavy dependency lazily; until decided,
  measure it and ask Mario before adding one to a worker facet.
- **Two plugins inlining the same library load it twice** in every process of their kind. Share through a contract or
  a registry entry instead (one live instance).
- **No new dependency without a measurement:** the worker's idle and settled USS, its start, the bundle's size, before
  and after. Base code's bundles must pass `checkExternals` and `checkLean` (`scripts/build-release.ts`). Dependencies
  follow the root `AGENTS.md` ("Dependency and Install Security": exact pins, the lockfile reviewed).
- **A process per thing is expensive:** a worker thread per code-mode script cost 10 to 28 MiB; an `ssh` client is
  1.6 MiB on the Pi's machine. Reuse one per worker.
- **No `--enable-source-maps` in workers:** Node parses the whole map at the first stack made text (about 50 MiB of a
  p2 session worker's heap, design §23). The release ships no source maps (`../decisions.md`, "Stack traces in the
  release").

## Traps seen in p2 and in p3's first slices

| Trap | What it cost | Fix |
| --- | --- | --- |
| recording every span (p2) | 1.8M spans, 1 GB, a third of a core in 15 h on the phone | keep only failed or slow trees, full tracing on demand (slice 28) |
| a worker thread per code-mode script (p2) | +10 MiB after the first script, +28 MiB with five at once, 30 ms a script | QuickJS inline, opened on first use (slice 10) |
| three SSH connections opened one after another (p2) | about 2 s on the phone before remote tools work | one connection per worker, reused (slice 8) |
| the worker's bundle sharing a chunk with the server | +5 MiB per worker, a slower start | a bundle per process, `checkLean` (slice 26) |
| provider SDKs loaded from `node_modules` | +4 to 5 MiB per worker | bundled, in lazy chunks (slice 26) |
| WebAssembly compiled twice, optimized | 8 to 10 MiB kept per worker | `--liftoff-only` (slice 26) |
| source maps enabled in workers (p2) | about 50 MiB of heap | no source maps in workers |
| the newest 200 as "the list"; a growing window | hidden caps; every loaded row sent again | `self.list` with `more` |
| `inArray(state)` ordered by `lastTouch` | walked all 10,000 rows | order by the `inArray` column first |
| one index for two lists | SQLite sorted every page | one index per list's order, a plan test |
| a count behind a hot column | a full count at every touch | count only what a key or index bounds |
| mirroring a value into another row to make an order cheap | two writes, two owners | a keyed probe skips reads a write cannot affect; no copy |
| a list cost measured once, after a start | 2.3 ms reported, 0.7 ms real | medians of 20 or more, the cold run apart |
| Node 26's V8 starting its memory reducer 30 s after work | a burst's garbage stayed past the readings: 42.8 instead of 37.2 MiB | `--gc-memory-reducer-start-delay-ms=8000` (slice 26) |
| a memory reading taken right after work | the reducer had not run yet: readings too high | settled readings (below, "How to measure") |
| SQLite's telemetry file growing without bound (p2) | 36 times write amplification, 64 GiB written a day on the phone | a size budget, fewer stored spans (slice 28) |

## Checklist

1. The brief's "Numbers to meet": targets with their precedents, for what the package touches.
2. Measured on slayer and the phone, source and release, medians of 20 or more, cold apart, settled memory.
3. Worker facets touched: the memory test passes, and the brief shows its readings before and after.
4. Starts touched: launch, plugin build and worker start numbers before and after.
5. Lists and queries: plan tests; counted runs and probes per action as cost guards.
6. UI: bytes per common action and the bundle's size.
7. Every cache a `WeakMap` with a GC test; no module-level strong cache.
8. No new dependency, flag or process without a measurement in the brief.
9. A number that got worse says why.
