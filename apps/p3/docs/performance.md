# Memory and performance

p3 runs dozens to hundreds of session workers on one machine, a phone among the targets. Every package measures what
it touches and reports the numbers in its Linear issue; a number that gets worse says why.

## The budget: 55 MiB per session worker

No session worker's USS (the memory only that process holds: what one more worker costs) may exceed 55 MiB, in any
phase. The memory test (the old base's `apps/p3/old/test/release/memory.test.ts`, in git at `753bc0bb2`; to be
ported to the skeleton with the harness core, ERNDL-855) checks it: four workers, each with Durable's harness, the coding tools, a subagent tool, real pi-ai providers against a local HTTPS
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
| server launch to ready (its owner link printed), warm | 117 ms (cold 139 ms; old base, to listening: 105 ms) | 1.6 to 1.9 s |
| an apply, nothing changed, right after a start, no worker (it builds the worker plugins) | 8.0 ms | |
| an apply, nothing changed, 21 workers running (builds nothing: the socket's round trip) | 0.3 ms | |
| worker start to its first object, the first after a start, before any apply (builds the worker plugins) | 95 ms | |
| worker start to its first object, warm | 70 ms (old base, earlier bench: 68 ms) | about 1 s |
| idle worker, settled (sessions and runner only, no harness) | 14.3 MiB (old base, earlier bench: 14.9) | 19.6 MiB |
| server, settled | 35.1 MiB (old base, earlier bench: 40.8) | 44 to 46 MiB |
| plain `p3` to its owner link | about 250 ms | 3.4 to 3.9 s |
| the owner's list, open / `more`, at 100,000 sessions | 0.6 / 0.45 ms | 3.4 to 5.3 / 2.6 to 4.5 ms |

The skeleton's numbers are `bench/skeleton.ts --release` (2026-11-21, review round 3 fixed, Node 26.11.1; medians of
20 warm runs, the cold first apart; slayer under load 3 falling to 2; a second run right after gave the same within
6 ms and 0.2 MiB). The old base's numbers ran the bench's earlier version against a release of `30a3e0b1f`; it timed
the launch to listening and fewer runs. The worker plugins are built by whichever comes first after a start, the first
worker or the first apply (Chord's rollout makes the whole set of every kind it rolls out): round 2's table timed the
apply first, so its "8 ms apply, nothing changed" was that build and its first worker built nothing. The bench now
times the first worker before any apply, the build's apply on fresh starts, and the no-change apply with the workers
running. The first worker's 25 ms over a warm one is mostly not the build (about 7 ms for two small facets, the
apply's number): round 2's first worker, which built nothing, cost as much more. The idle worker's USS counts session workers only (esbuild's service, also the server's
child, no longer). The memory test's idle worker (17.9 MiB above) carries the harness, the coding tools and a subagent
tool: never compare the two.

- **Every start builds every plugin again** (no build cache): about 30 ms for one plugin today, one esbuild call per
  facet. The server facets are built before the server listens; the worker facets when they are first needed (the
  first worker's start or the first apply, whichever comes first; a later apply builds only the plugins that
  changed), so the first of them after a start pays their build: the bench's first worker start and its apply right
  after a start include it, the warm starts and the apply with workers running do not. A package with large facets says
  what it adds to the start, on the phone too. The old base's `NODE_DEBUG=p3` (what a start spends building) does
  not exist in the skeleton: the new base never had it.
- **The server holds every pi-ai provider** (the providers plugin's `builtinProviders`, to offer every sign-in).
  - **Measured at the push of the login kind** (`c417ecec7` against `17580b384`, releases, `bench/skeleton.ts
    --release`, slayer, Node 26.11.1, 2026-11-26, alternating runs, a busy machine): the settled server went from 72.5
    to 78.1 MiB USS (medians of 3 and 4 runs), and an idle worker from 18.4 to 18.8 MiB (nothing of a provider loads
    before a login's first request). The launch showed no change beyond the noise.
  - **Round 1's figures** (66 MiB without the plugin, 84 and 86 MiB in two runs with it) were measured on an older base.
  - **Where the cost sits:** `/v1/server` itself imports pi-ai's `providers/all` (`export { builtinProviders }`). So the
    base server bundle holds every provider whether the providers plugin is installed or not: removing
    `plugins/providers` from a release install left the server at 80.8 and 87.3 MiB.
  - **A later improvement, which also has to take that import out of `/v1/server`:** offer the choices from a list of
    names, and load a provider only when a person signs in to it or a login of it authorizes.
- **Many workers at once:** the waker starts the worker of every `working` session together after a restart, and
  nothing caps live workers. On Android that meets the 32-child-process limit unless it is lifted (`testing.md`,
  Android).
- **Telemetry:** a healthy turn should store no spans; at most 1 KB of metrics per process per 10 s; the store
  bounded by size (slice 28's targets, `slices/28-telemetry.md`).
- **The access index (things plugin):** its first question about a workspace reads it and every ancestor not loaded
  (five reads each) and a person (two); after a commit only the touched workspaces and persons are read again. A
  kinds change (a plugin with a kind loaded, reloaded or removed) reads every loaded workspace again, up to the
  forgetting budget (1,000 unwatched) plus the watched ones and their ancestors, in the index's queue: the writes and
  questions behind it wait for it. `bench/things.ts` times the root and leaf changes, one worker's start and the cold
  first question; a kind's plugin reload under load is not timed yet.
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
- **A bench per package:** `apps/p3/bench/<name>.ts`, modelled on `bench/skeleton.ts` (launched processes, both
  layouts, `--release <dir>`).

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
| a build credited to the wrong phase (the worker plugins' build is in whichever of the first worker and the first apply comes first) | an 8 ms "no-change apply" that was the build; a first worker that built nothing | time the phases in the order a Pi meets them, the first of each apart, and count the builds when unsure |
| an ordered `inArray`, a count behind a hot column, one index for two lists | every row read, every page sorted | see `chord-practices.md`, Rules |
| every pi-ai provider loaded in a worker (`builtinProviders`, its generated catalog 7.4 MiB of it) | 12 to 14 MiB per worker, against 1.6 to 2 MiB for one provider (slayer, Node 26, pi-ai's dist, settled USS, 2026-11-26) | a worker loads only the providers of its logins, on the first request (`loadProvider` of `/v1/worker`); their models come from the login's `catalog` |
