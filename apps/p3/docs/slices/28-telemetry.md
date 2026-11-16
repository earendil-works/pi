# Slice 28: telemetry

**Goal.** The owner gets insights from telemetry without paying for a pile of data nobody looks at: metrics always on,
traces kept only where something went wrong, full tracing when he asks for it, and a disk budget by size. p2 turned
telemetry off on 2026-11-13: recording everything cost the phone 1.8M spans, 1 GB and about a third of a core in 15
hours (commit `2993f25d8`). This brief measures what p2 writes and why, and turns the owner's strategy into decisions.

State: brief with measurements (2026-11-16). Nothing is built in p3: the p3 kit has no telemetry (`src/kit/start-server.ts`,
`src/kit/worker.ts` take none). It comes after slice 25 in build order. It is base plumbing: every later slice's
"Numbers" can then read its own metrics, and the decision "Startup building is measured with telemetry"
(2026-11-06) needs it. Most of the work is in Chord and pi-telemetry, and each Chord change needs its own Chord
decision (below).

Everything marked **BUILT** exists, with its file. Everything marked **PROPOSED** is a design for this slice. No
proposed name is a real API yet.

## p2's features in this area, and what p3 does with each

From p2's code (`plugins/telemetry/`, `src/hosts/server.ts`, `src/hosts/worker.ts`, `src/hosts/web.ts`,
`src/runtime/principals.ts`, `src/runtime/settings.ts`, `scripts/traces.ts`) and `docs/p2-notes.md`, "Telemetry".

| p2 (BUILT) | p3 (PROPOSED) |
| --- | --- |
| `settings.json` `telemetry` (boolean, default off), read once at the server's start; a change needs a restart | no switch for the default: metrics and the traces worth keeping (decision 1) are always on. Full tracing is switched at run time, per session or for the Pi, for a limited time (decision 4) |
| The server records to `<data>/telemetry.sqlite` (Chord's SQLite store: 7 days, a queue of 10,000 spans, a flush every second), its only writer, a private file never in a backup | the same file and the same rule (one writer, not in backups); a size budget replaces the 7 days (decision 5) |
| Each worker records in memory (its host's spans, Durable's `pi.durable.*`, pi-ai's `pi.ai.*`) and sends everything to `WorkerTelemetry` every second and when it closes | each worker decides which of its spans to keep and sends only those, with its metrics (decisions 1 to 3) |
| Owners' pages record (`data-p2-telemetry`, `startPage({ telemetry: true })`), send every 3 s and when hidden; only owners are admitted; 1,200 spans per page and minute | owners' pages record by the same keep rule; owners only (decision 8) |
| `principalAttributes`: `p2.principal` (`owner:<access>`, `guest`, `worker`, `server`), a guest's id or a worker's session, never a name or email | `p3.principal` (`owner`, `person`, `worker`, `server`), a person's id, a worker's session; never a name or email |
| `Traces` (server): reads with bounds (50 traces, 2,000 spans a trace, 1,000 metric rows, 8 filters); variant `owner`, variant `agent` for a session's worker, refused while the session is shared or locked | the same object in p3's `telemetry` plugin, plus the mode and the budget (Files). The agent's access follows a lock of slice 6 (`telemetry.read`, PROPOSED), not a hand-written check |
| The Traces pane (search, a trace as a span tree on a timeline) and the command "Show traces" | carried to the views slice (14) and the web slice (16): this slice has no page UI |
| The agent's code-mode tools `telemetry_find_traces`, `telemetry_get_trace`, `telemetry_find_metrics` (namespace `telemetry`, deferred) | the same three, plus `telemetry_trace` (start or stop full tracing of its own session, decision 4); they need code mode, so they land with slice 10, or here if slice 10 is built first |
| `scripts/traces.ts` (read-only, from the checkout) | `p3 traces` (slice 26's command set): the same filters, read-only on the file |
| `telemetry-off.test.ts`: off, nothing is opened and every read says "telemetry is off" | dropped: there is no off. A Pi with `--telemetry none` (PROPOSED, for benchmarks) uses Chord's NOOP adapter |

## Measurements: what p2 writes

### How it was measured

On slayer (Linux x64, Node 24.4.1), 2026-11-16. Raw data and scripts: `/tmp/tele/` (`README.md` there). No real
provider, no keys.

- **The stack is p2's own:** `startServer` from `apps/p2/src/hosts/server.ts` (`fake: true`, `web: true`,
  `settings.json` `telemetry: true` or `false`), a forked session worker, and the real web UI in headless Chromium,
  signed in as the owner and sending through the composer (p2's `test/p2/browser.ts`). Model: p2's faux provider (200
  tokens a second, 4 characters a token).
- **One run of the script** (`/tmp/tele/run.ts`): the setup, the page load (the worker's start and the page's holds),
  8 prompts (`steps`, `codemode`, `slow`, `hello`, twice each), 60 s idle with the page open, 30 s with it closed.
  - `steps` is 3 turns: thinking and a `read`, text and a `read`, thinking and a 400-character answer.
  - `codemode` is 2 turns, with one `codemode` call making two nested calls.
  - `slow` is 1 turn streaming 3,000 characters.
  - `hello` is 1 turn with a short answer.
- **Five runs with telemetry on, five off, alternating.** The figures below are medians: 10 samples per prompt kind,
  5 per total.
- **What was counted:**
  - Store rows and bytes come from the store file. A span's bytes are its stored columns.
  - The worker's link bytes come from a preload in the worker that wraps `process.send`.
  - The worker's CPU and memory (USS: `Private_Clean` + `Private_Dirty`) come from the same preload.
  - The server's CPU is `process.cpuUsage` of its process.
  - The page's CPU is the Chromium processes' `/proc` ticks.
  - Batch JSON is the server's `TelemetryRecorder.ingest`, patched to measure it.

### Per run and per turn

| Prompt | Turns, tool calls | Spans stored | Span JSON | On disk (612 B a span) | Worker link bytes, on / off |
| --- | --- | --- | --- | --- | --- |
| `steps` | 3 turns, 2 calls | 211 | 83.6 KB | 129 KB | 90.0 / 25.2 KB |
| `codemode` | 2 turns, 1 call (2 nested) | 173 | 68.1 KB | 106 KB | 58.8 / 8.7 KB |
| `slow` | 1 turn, 3,000 characters | 104 | 41.4 KB | 64 KB | 49.1 / 12.7 KB |
| `hello` | 1 turn, short | 67 | 26.2 KB | 41 KB | 19.3 / 2.6 KB |
| page load (worker start, page holds) | none | 241 | 84.8 KB | 148 KB | the page sends 24.7 KB of spans |
| idle, page open or closed | none | **0** | none | none | 5.7 KB/min (metrics) / 4 B |

- **Per turn:** about 70 spans (28 KB of JSON, 43 KB on disk).
- **Streaming:** each 1,000 characters streamed adds about 12 spans (`slow` against `hello`).
- **Link traffic:** with telemetry on, the worker's link carries 3 to 7 times its own traffic. About 22 KB per turn
  is telemetry.
- **Page:** it sends spans at its load and almost nothing after.
- **Totals of one run of the script:** 1,496 spans (±3: the counts are deterministic), 570 KB of JSON, a 946 KB file;
  170 metric rows in 39 series.
- **Bytes per span on disk:** 612, of which 427 are the row and 170 the four indexes. Links are 18% of span bytes.
  The phone's figure, 1 GB for 1.8M spans, is 555 B a span: the same order.

### What dominates: granularity, not the work it describes

Share of spans over the five runs (7,471 spans):

| Spans | Share | What they are |
| --- | --- | --- |
| `chord.routine` | 39.3% | a span per call of a routine (`self.on`), each time its source changes: the worker's `p2.conversation` on every commit of the live state (12.0%), `p2.subagent-tools` (6.6%), `p2.status-report`, `p2.chat-mode-setting`; the server's `p2.rollup-store` (5.6%), `p2.env-restarts` (4.1%), `p2.discord-store`, `p2.shares`. Most run and change nothing |
| `chord.method` + `chord.call` | 32.2% | plugins telling the server things. One status report is three spans: the worker's call, the server's `p2.session-status.report` and the local forward to `p2.status-store.report` (12.6% together). The search feed's `cursor` and `index` are 11.7%; `p2.catalog.activity`, `markRead` |
| `chord.activate`, `chord.open`, `chord.close` | 19.7% | objects activating, once per object, mostly at the worker's start and the page's load |
| `chord.hold`, `chord.relay`, `chord.resolve` | 4.4% | the page's holds, relays |
| `pi.durable.submit`, `pi.durable.phase`, `pi.ai.request` | **4.3%** | the run itself: what a person would look at |

- **The volume is granularity.** Chord records a span for every reaction and every internal hop, so a turn costs
  about 70 spans. Of those, about 3 describe the turn itself (the phase and the model request).
- **Retention multiplied it:** 7 days at the phone's rate is about 7 GB.
- **Idle costs nothing.** An idle Pi records no spans, only metrics.

### Traces have no clean end

- **Most traces are one span.** 930 traces per run; 608 of 705 in a first sample hold a single span (a routine call or
  an activation).
- **Traces across processes:** 74 traces per run cross processes, but they hold 35% of the spans.
- **Traces that never end:** 3 traces per run (220 spans, 15%) never got their root. The search worker's
  `self.onLive` routine (`apps/p2/plugins/search/worker.ts:124`) runs for the worker's whole life, and every call it
  makes is a child of its open span. After 8 prompts, one such tree held 139 spans and kept growing.
- **Span lengths mix work and waiting.** Server routines that wait by design (`p2.rollup-store`,
  `p2.discord-store`, `p2.voice-service-store`, `chord.app.files`) last up to 81.5 s, the whole run. Holds last until
  they are bound.

### What a keep rule would keep (`/tmp/tele/sample.ts`)

A **local tree** is a span with no parent in its own process, with its descendants in that process. It is what one
process can decide about alone.

| Rule | Local trees kept | Spans kept |
| --- | --- | --- |
| everything (p2 on) | 5,652 | 100% |
| failed only | 0 | 0% |
| failed, or the top span ≥ 100 ms | 94 | 1.4% |
| failed, or ≥ 1 s | 25 | 0.3%: all of them routines that wait by design |
| failed, or ≥ 100 ms, waiting spans (routine, hold, relay) exempt | 7 | 0.3% |
| failed, or ≥ 1 s, waiting spans exempt | 0 | 0% |
| every span but routines | 2,717 | 57% |

- **A healthy turn keeps nothing.**
- **A single time threshold keeps the wrong things.** With real models, a `pi.ai.request` takes 2 to 30 s, so a 1 s
  rule would keep every turn, and the routines that wait by design are always "slow".
- **"Slow" must be a budget per span name.**

### Cost: CPU, memory and disk

- **CPU, on against off:** per prompt, the server, the worker and the page used the same CPU within run-to-run noise.

  | Prompt | Server, on / off | Worker, on / off |
  | --- | --- | --- |
  | `steps` | 180 / 214 ms | 223 / 231 ms |
  | `slow` | 187 / 216 ms | 155 / 194 ms |
  | `hello` | 36 / 37 ms | 29 / 26 ms |

  At these rates (up to about 70 spans a second during a prompt), the per-span cost does not show.
- **Per span** (`/tmp/tele/bench.ts`, 1,499 replayed spans, medians of 20 rounds):
  - recording: 3.0 µs;
  - the batch's JSON: 1.0 µs;
  - writing to a small store: 4.8 µs.
- **Memory:** no difference beyond noise.
  - Worker USS: 128 to 157 MiB on, 134 to 158 off.
  - Server USS: 206 to 208 MiB on, 208 to 210 off. Both run from source, with the web bundles built.
  - The worker's recorder holds at most one second of spans.
- **Disk writes grow with the file** (`/tmp/tele/bench-large.ts`). A flush of 35 spans, which is the phone's 33
  spans a second, writes:

  | Store file | CPU per flush | Written per flush |
  | --- | --- | --- |
  | 10k spans | 0.27 ms | 164 KiB |
  | 300k spans (171 MiB) | 0.63 ms | 684 KiB |
  | 1.8M spans (1,035 MiB) | 0.71 ms | 760 KiB |

  - **Write amplification:** that is about 22 KB written per 612-byte span (36 times).
  - **Why:** in WAL mode (the write-ahead log) a write goes to the log and again into the database at the checkpoint,
    and the inserts land on scattered pages of two of the four indexes: the text span id and the trace id.
  - **Batching does not help.** 350 spans a flush wrote 12.4 MiB.
  - **At the phone's rate on a 1 GB file:** about 2.7 GiB written an hour, 64 GiB a day.
- **Reads slow down too:** `findTraces` takes 3 ms on 10k spans and 265 ms on 1.8M. Its `GROUP BY trace_id` reads the
  whole table.

### Extrapolation: the owner's gigabyte a day

- **What a gigabyte is:** 1 GB at 612 B a span is 1.7M spans, about 25,000 turns a day at 70 spans a turn.
- **The phone's rate:** 1.8M spans in 15 h is 120,000 spans an hour, about 1,700 turns an hour. That is about seven
  agents each taking a turn every 15 s, or fewer agents with longer streams (12 spans per 1,000 characters), plus
  worker starts and page loads (241 spans each).
- **Fit:** with p2's agent-heavy use (subagents in parallel), the reproduction fits the gigabyte. The bytes per span
  match (612 against 555).
- **The third of a core** does not follow from recording. At 33 spans a second and the measured 9 to 20 µs a span,
  recording and writing is under 0.1% of a slayer core, so even a phone 20 times slower stays near 1%. The likely
  causes, not verified, are:
  - the 64 GiB a day of disk writes on the phone's flash (kernel and file system time, fsyncs at checkpoints, which a
    process's own CPU time does not show);
  - reads of a 1 GB file from the Traces pane.

  The slice measures this on the phone (Numbers).
- **One busy agent, for scale:** a turn every 15 s is 16,800 spans an hour: 10 MB of disk and 5 MB of link traffic,
  plus metrics of about 0.4 to 1.3 MB an hour (below).

### Metrics

- **Rows:** 1.3 a second while a session works (170 in 135 s), about 0.5 idle. That is 1,800 to 4,600 rows an hour
  at about 290 B a row with its index: 0.5 to 1.3 MB an hour, 12 to 32 MB a day if kept at 10 s.
- **The worker's metrics merge into the server's series.** `telemetryIngestFacet` stamps `chord.host` on spans only
  (`packages/chord/src/telemetry-ingest/facet.ts`, BUILT). So `chord.link.bytes { direction: "sent" }` adds the
  server's and every worker's bytes into one series, and the store cannot tell them apart.
- **Histograms keep count, sum, min and max per 10 s** (`StoredMetric`, `packages/telemetry/src/index.ts`, BUILT): no
  buckets, so no percentiles.
- **What the metrics answer today:**
  - tokens and cost per model (`pi.ai.tokens`, `pi.ai.cost`);
  - request and first-chunk durations (`pi.ai.request.duration`, `pi.ai.first_chunk.duration`);
  - phase durations (`pi.durable.phase.duration`);
  - reports (`pi.durable.reports`);
  - Chord's cost counters.
- **What they do not answer:**
  - failures by category: a failed span is only a span;
  - tool calls by tool name: `tool.name` is a span attribute only;
  - the processes' memory: pi-telemetry has no gauge;
  - a worker's start duration.

## The strategy, against the data

The owner's proposal (2026-11-16), point by point.

1. **Metrics always on. Supported, with three changes.**
   - **Cost:** about 1 KB per process per 10 s on the wire and under 1.3 MB an hour on disk. That is cheap.
   - **Keep the processes apart:** they must carry the process's kind (decision 7).
   - **Roll up:** to keep months, 10 s rows become 1 min and then 1 h rows (decision 5).
   - **Fill the gaps:** a few metrics are missing (failures by category, tools by name, worker starts, memory).
2. **Spans off by default, kept only for traces that failed or were slow. Supported, changed in two places.**
   - **Supported:** in healthy use the rule keeps 0 to 0.3% of the spans, and with that the 64 GiB a day of writes and
     the 22 KB per turn on the worker's link go away.
   - **First change, the unit is the local tree, not the trace.** A trace crossing processes (35% of the spans) cannot
     be judged by one process, and some traces never end (the `onLive` tree). A process decides a local tree when its
     top span settles. Failure and slowness travel up a call chain anyway: a callee's failure fails the caller's
     `chord.call` and a slow callee makes the call slow, so each side keeps its own part.
   - **Second change, "slow" is a budget per span name, declared in the schema.** Spans that wait by design are
     exempt (decision 3).
   - **The buffer needs a cap:** a tree still open past it is dropped, counted.
   - **Recording stays on:** spans are still built in memory (3 µs each), so that the decision can be made.
3. **Full tracing on demand, per session or for the Pi, for a limited time. Supported, and needed.** The keep rule
   loses the healthy path ("why was this turn slow?" when no span went over its budget). The cost of full mode is p2's
   measured one (70 spans, 43 KB a turn), bounded by its time and the size budget.
   - **New: the mode must change at run time.** p2 reads the switch once at the start and fixes each host's adapter at
     `createHost`.
   - **New: a fully traced session's calls must be traced fully in the server too**, through a flag in the carrier
     (decision 4).
4. **A disk budget by size instead of days. Supported.**
   - **With the keep rule:** a few hundred spans an hour plus metrics, so 256 MB lasts months.
   - **In full mode:** at 120,000 spans an hour, 256 MB fills in about 3.5 hours. The budget is what bounds it.
   - **A SQLite file does not shrink after a `DELETE`:** the store needs incremental vacuum (decision 5).

## Decisions

Each goes to the owner one at a time. His answers are recorded in `../decisions.md`. Those marked **Chord** also go
into `packages/chord/docs/decisions.md`, since they change Chord or pi-telemetry.

### 1. What is recorded by default (Chord)

**Problem.** p2 had two settings: everything (1 GB in 15 h) or nothing.

**Example.** A `steps` prompt stores 211 spans. Of those, the 3 `pi.ai.request` spans and the 10 `pi.durable.phase`
spans describe the turns.

**Options.**
- **(a) Nothing** (p2 today): no failure is ever traced.
- **(b) Everything** (p2 before).
- **(c) Head sampling:** 1 in N traces, chosen at their start. It keeps random healthy traces and misses most
  failures.
- **(d) Keep by outcome:** every process records, keeps a local tree that failed or went over a span's budget,
  and drops the rest, counted.

**Recommendation: (d).** It is what the owner proposed, and the data shows it keeps nearly nothing in healthy use.

### 2. The unit of the keep decision (Chord)

**Problem.** "Hold a trace's spans until the trace ends" does not work.

**Example.** The search worker's `onLive` span never ends, so its 139 child spans (and growing) would be held for the
worker's life. A page's call relayed by the server to a worker is one trace in three processes: the server would have
to receive and hold every span to judge it, which keeps the link traffic the strategy wants to remove.

**Options.**
- **(a) The whole trace, judged at the server:** every process sends everything; the server buffers and decides.
- **(b) The local tree, judged by its own process when its top span settles:** a buffer cap (PROPOSED 2,000 spans
  per process, about 1 MB), and a tree past the cap or open past 10 minutes is dropped, counted.

**Recommendation: (b).** A failure or a slow callee shows up in the caller's own tree. Carriers still join the kept
parts into one trace in the store.

### 3. What "slow" means (pi-telemetry, Chord, Durable, pi-ai)

**Problem.** One threshold for every span keeps the wrong things.

**Example.** With "≥ 1 s", the only trees kept are server routines that waited 81 s by design. With real models every
`pi.ai.request` (2 to 30 s) would be kept.

**Options.**
- **(a) One threshold.**
- **(b) A budget per span name in the schema:** PROPOSED `slowMs` on `TelemetrySpanDefinition`, and `waits: true` for
  spans whose length is waiting (`chord.routine`, `chord.hold`, `chord.relay`). Examples:
  `chord.method` 1,000, `chord.activate` 2,000, `pi.durable.phase` 60,000, `pi.ai.request` 120,000, and a first-chunk
  rule on the `pi.ai.first_chunk` event's time, 20,000.
- **(c) Relative to each name's own history** (its 99th percentile): needs histogram buckets, which the store does
  not have.

**Recommendation: (b).** A waiting span can still be kept when a descendant went over its own budget.

### 4. Full tracing on demand

**Problem.** How it is switched, for what, for how long, and by whom.

**Example.** The owner sees a session's turns take 40 s and wants every span of its next turns, including the
server's work for it.

**Options.**
- **Scope:** a session, the Pi, or both.
- **Length:** a default of 30 minutes or 1 hour; a maximum of 24 hours or none.
- **Who switches it:** the owner only, or also the agent of an owner's session for its own session (tool
  `telemetry_trace`, PROPOSED).
- **How the mode travels (Chord):**
  - the worker follows its session's mode from a server object (`TelemetryMode`, PROPOSED);
  - a carrier gains a flag (PROPOSED key `pi-trace-all`) so that every process records the rest of that trace fully;
  - the recorder's mode becomes switchable (`tail` or `all`, PROPOSED).

**Recommendation:** both scopes, 30 minutes by default, at most 24 hours, the owner and the owner's own agent, the
carrier flag. The mode survives a worker restart (stored on the server) but not its expiry.

### 5. The disk budget, and how long metrics last (Chord)

**Problem.** Days are the wrong limit, and metrics at 10 s cost 12 to 32 MB a day.

**Example.** 7 days of p2 on the phone would be 7 GB. A month of 10 s metrics would be up to 1 GB. A month of hourly
token counts would be about 9 MB.

**Options.**
- **Budget size:** 128 MB, 256 MB or 1 GB, one value for spans and metrics together.
- **When over budget:**
  - (a) drop the oldest rows;
  - (b) drop the oldest spans first, then the oldest metric rows.
- **Metrics:**
  - (c) 10 s rows only, within the budget;
  - (d) roll up: 10 s rows kept 2 days, 1 min rows 30 days, 1 h rows a year.
- **Reclaiming space:** incremental vacuum after deletes. `auto_vacuum` must be set when the file is made, so it is a
  store version 3.

**Recommendation:** 256 MB, (b), (d), and incremental vacuum. The store's `retentionMs` becomes `maxBytes`
(PROPOSED). On a desktop the owner may raise the budget.

### 6. Chord's span granularity (Chord)

**Problem.** In full mode a turn is still about 70 spans: 39% are routine runs and about 9% local forwards (two
`chord.method` spans for one call on one host).

**Options.**
- **(a) Keep Chord's span set:** full mode means everything.
- **(b) Routine runs become a metric** (PROPOSED `chord.routine.duration { type, routine }`) and a span only when kept
  or in full mode.
- **(c) The calls an `onLive` routine makes become roots linked to it**, as re-holds already are (design §29), so no
  tree stays open for a worker's life.

**Recommendation: (a) and (c) now.** (b) only if full mode proves too heavy in the slice's numbers. (c) also fixes the
unbounded tree of decision 2.

### 7. Metrics per process (Chord)

**Problem.** The worker's metrics merge with the server's.

**Example.** `chord.link.bytes` cannot say which side sent the bytes.

**Options.**
- **(a) As now.**
- **(b) The ingest facet stamps `chord.host.kind`** (`server`, `worker`, `page`) on metric rows: three times the series
  at most.
- **(c) A series per worker:** this breaks the rule "ids are attributes of spans, never of metrics" (§29), and the
  rows multiply with the workers.

**Recommendation: (b).**

### 8. Pages

**Problem.** p3 has persons, and a page is untrusted.

**Options.**
- **(a) Owners' pages only, as p2.**
- **(b) Also persons' pages,** under the per-page budget. A person can open many pages, and their spans would reach
  the owner's store.

**Recommendation: (a).** Persons' page failures reach the owner as notices (slice 20).

### 9. New metrics (Chord, Durable)

**Problem.** With spans dropped by default, trends must come from metrics.

**Proposed metrics:**
- `chord.failures { category }`: Chord's fixed error categories;
- `pi.durable.tool.duration { tool, outcome }`;
- `chord.worker.start.duration`;
- `chord.telemetry.dropped { reason: "healthy" | "cap" | "queue" }`;
- the process's memory, sampled every 10 s into a histogram (`process.memory { kind: "rss" | "heap" }`), since
  pi-telemetry has no gauge.

**Options:** (a) all of them, (b) failures and tools only.

**Recommendation: (a).** They are counted where the code already has the values (§29: nothing measured or walked for
telemetry).

### 10. Rare spans that are always kept (Chord)

**Problem.** The decision "Startup building is measured with telemetry" wants the server start, worker starts and
Apply traced. Under the keep rule they would be dropped when healthy.

**Options.**
- **(a) Durations as metrics only.**
- **(b) PROPOSED `keep: "always"` in the schema** for `chord.load`, `chord.reload`, `chord.resolve` (a worker start):
  a few trees a day.

**Recommendation: (b).**

## How it works (PROPOSED)

```
worker                                  server                                   page (owner)
TelemetryRecorder, mode tail|all        SqliteTelemetry (maxBytes, rollups)       TelemetryRecorder, mode tail|all
 local trees buffered (cap 2,000)        own local trees decided the same way       same rule, spans only
 kept tree -> queue; dropped -> count    ingest: kept trees and metric rows,        PageTelemetry (owners only)
 metrics per series per 10 s              chord.host.kind stamped on metrics
        |  WorkerTelemetry.ingest              ^ TelemetryMode: per session and Pi, with expiry
        +--------------------------------------+ (worker follows its session's mode)
```

1. **The recorder** (`packages/chord/src/telemetry-ingest/recorder.ts`, BUILT; changed):
   - It keeps settled spans of open local trees in a per-tree buffer.
   - When a tree's top span settles, the tree is kept if a span in it failed, a span went over its schema's `slowMs`
     (waiting spans exempt), the schema says `keep: "always"`, or the mode is `all`, or the carrier said "all".
   - A kept tree goes to the queue the sender already takes from; a dropped one is counted.
   - Metrics stay as they are: per series per 10 s.
2. **The sender** (`sender.ts`, BUILT) is unchanged: it sends every second. With the keep rule a batch is usually
   metrics only, about 1 KB per 10 s.
3. **The store** (`packages/chord/src/telemetry-sqlite/`, BUILT; changed):
   - `maxBytes` replaces `retentionMs`;
   - metric rollups;
   - version 3 with incremental vacuum;
   - the same `TelemetryStore` reads.
4. **The kit** (`apps/p3/src/kit/start-server.ts`, `worker.ts`, `session-workers.ts`, BUILT without telemetry; changed):
   - the server opens `<data>/telemetry.sqlite`, gives its host the store and serves Chord's ingest facet
     (`telemetryIngestFacet`, BUILT);
   - each worker makes a recorder and a sender, as Chord's kit worker does (`packages/chord/src/node/app/worker.ts`,
     BUILT).
5. **The plugin** `apps/p3/plugins/telemetry/` (PROPOSED):
   - the server object `Telemetry`: the owner's reads with p2's bounds, the mode per session and for the Pi with
     expiry, and the budget and the store's size;
   - `TelemetryMode`, which the worker reads with its admission;
   - the agent's tools come with code mode.

## Files (PROPOSED)

| File | What changes |
| --- | --- |
| `packages/telemetry/src/index.ts` | `TelemetrySpanDefinition` gains `slowMs`, `waits`, `keep` |
| `packages/chord/src/telemetry.ts` | Chord's spans get their budgets; new metrics (decision 9) |
| `packages/durable/src/harness/telemetry.ts`, `packages/ai/src/telemetry.ts` | budgets of `pi.durable.*` and `pi.ai.*`; `pi.durable.tool.duration` |
| `packages/chord/src/telemetry-ingest/recorder.ts` | local trees, keep rule, mode, cap, drop counts |
| `packages/chord/src/telemetry-ingest/facet.ts` | `chord.host.kind` on metric rows |
| `packages/chord/src/telemetry-sqlite/index.ts`, `schema.ts`, `store.ts` | `maxBytes`, rollups, version 3 (incremental vacuum) |
| `packages/chord/src/host/` (the `onLive` routine's calls as linked roots, decision 6c) | where routines start their spans |
| `apps/p3/src/kit/start-server.ts`, `worker.ts`, `session-workers.ts` | the store, the recorders, the ingest facet, the mode |
| `apps/p3/plugins/telemetry/contract.ts`, `contract.server.ts`, `server.ts`, `worker.ts` | `Telemetry`, `TelemetryMode` |
| `apps/p3/src/commands.ts` | `p3 traces` |
| `apps/p3/bench/slice-28.ts` | the numbers below |
| `apps/p3/test/telemetry*.test.ts`, Chord's and pi-telemetry's tests | below |

## Tests, case by case (PROPOSED)

Chord and pi-telemetry (each in the test file of its source):

1. A healthy local tree is dropped and counted (`chord.telemetry.dropped { reason: "healthy" }`); nothing reaches the
   queue.
2. A tree with a failed span is kept whole: its top span and every descendant in the process.
3. A span over its `slowMs` keeps its tree; a waiting span (`chord.routine`) over any length does not, unless a
   descendant went over its own budget.
4. `keep: "always"` keeps a healthy `chord.load` tree.
5. A cross-process call that fails: the callee's tree and the caller's are both kept and join into one trace in the
   store.
6. Mode `all`: every tree is kept. A carrier with the "all" flag makes the callee keep the trees under it, while the
   rest of the callee stays on the keep rule.
7. The cap: a tree still open past 2,000 buffered spans, or past 10 minutes, is dropped with `reason: "cap"`; the
   buffer's memory returns (a GC test with `WeakRef`).
8. An `onLive` routine's calls are roots linked to the routine: no tree stays open (decision 6c).
9. The store: over `maxBytes` it deletes the oldest spans, then the oldest metric rows, and the file shrinks after the
   vacuum; rollups sum 10 s rows into 1 min and 1 h rows exactly (count, sum, min, max).
10. Metric rows from a worker carry `chord.host.kind: "worker"` and never merge with the server's.
11. A version 2 file migrates to version 3 with its rows kept.

p3 (topology tier, then end to end):

12. A healthy `steps` prompt stores 0 spans; the worker's link carries no spans for it.
13. A tool that throws stores its phase's tree, and the server's tree for the same call when it failed there too.
14. The owner switches full tracing on for one session: its next turn stores its whole trace (Chord's, Durable's and
    pi-ai's spans, and the server's under it); another session stays on the keep rule; at the expiry the mode returns
    by itself.
15. Full tracing for the Pi, then a worker restart: the new worker reads the mode.
16. Reads: the owner's `Telemetry` finds traces and metrics with p2's bounds; a person is refused; a session's agent
    gets the variant its lock allows.
17. `p3 traces` reads the file while the server writes it.
18. Reload: the telemetry plugin edited and applied while the owner's object is held and a worker records; nothing is
    lost, and the restart mark stays off.

## Numbers to meet (PROPOSED, measured in `bench/slice-28.ts`, on slayer and the phone)

| What | Target | p2, measured |
| --- | --- | --- |
| spans stored for a healthy `steps` prompt | 0 (at most the rare always-kept ones) | 211 |
| a worker's telemetry bytes on its link per turn, keep rule | none beyond its metrics | about 22 KB |
| metrics on the wire per process | ≤ 1 KB per 10 s | 5.7 KB/min for the worker |
| metric rows on disk, one active session | ≤ 1.3 MB per hour of 10 s rows; rollups after 2 days | the same, kept 7 days |
| disk written per hour, a Pi with one busy agent | ≤ 10 MB | 2.7 GiB at the phone's rate on a 1 GB file |
| the store file | ≤ the budget (256 MB) plus one flush | grew without a size limit |
| worker and server CPU per prompt, keep rule against no telemetry | within noise (medians of 20) | within noise |
| recording a span (slayer) | ≤ 4 µs | 3.0 µs |
| the recorder's buffer per worker | ≤ 1 MiB (the cap) | one second of spans |
| a failed tree visible to the owner | within 2 s | 1 s (every span) |
| full mode, per turn | ≤ p2's 70 spans, 43 KB on disk | 70 spans |
| `findTraces` on a full 256 MB store | ≤ 50 ms on slayer | 265 ms at 1 GB |
| the phone: CPU and disk writes over a day of use with the keep rule | measured and reported; the brief's estimate is under 1% of a core | about a third of a core |

## Read first, in full

- `apps/p3/docs/chord-practices.md`, `names.md`, `decisions.md`, `workflow.md`, `slices/README.md`; this brief.
- `packages/chord/docs/design.md` in full, especially §29 (Telemetry) and §30 (Cost model);
  `packages/chord/docs/decisions.md` (the telemetry entries).
- Chord: `packages/chord/src/telemetry.ts`; `src/telemetry-ingest/` (`batch.ts`, `facet.ts`, `recorder.ts`,
  `sender.ts`); `src/telemetry-sqlite/` (`index.ts`, `schema.ts`, `store.ts`, `node.ts`); `src/sqlite/node.ts` (WAL,
  checkpoints); `src/node/app/app.ts` and `worker.ts` (the kit's telemetry path).
- pi-telemetry: `packages/telemetry/README.md`, `src/index.ts`, `src/memory.ts`, `src/metrics.ts`.
- Durable `packages/durable/src/harness/telemetry.ts`; pi-ai `packages/ai/src/telemetry.ts`.
- p2: `apps/p2/docs/p2-notes.md` "Telemetry"; `apps/p2/src/hosts/server.ts` (the telemetry parts), `worker.ts`,
  `web.ts`, `src/runtime/principals.ts`, `settings.ts`; `apps/p2/plugins/telemetry/` (all); `scripts/traces.ts`;
  `test/p2/telemetry.test.ts`, `telemetry-off.test.ts`, `telemetry-traces.test.ts`.
- p3's kit: `apps/p3/src/kit/start-server.ts`, `worker.ts`, `session-workers.ts`.
- The measurements: `/tmp/tele/README.md` and its scripts on slayer (raw; rerun with `batch.sh`).

## Carried (not in this slice)

- **The Traces pane:** to slices 14 and 16.
- **The agent's tools:** to slice 10, if code mode is not built first.
- **The agent's read access:** as a lock, in slice 6.
- **Export to an external backend** (an OpenTelemetry adapter): not planned.
- **Histogram buckets for percentiles:** a pi-telemetry change, only when a decision needs percentiles.
