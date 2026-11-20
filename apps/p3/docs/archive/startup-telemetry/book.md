---
title: Chord: measuring startup and apply
cover: Measuring / Startup
kicker: A spec · Chord (for p3) · 2026-11-06
subtitle: Spans for every step of a server start, a worker start, a page load and an Apply, so we know where the time goes, on slayer and on the phone
stats:
  - 0 | spans today for building or starting anything
  - 4 | new root spans (server start, worker start, page start, apply)
  - 1 | summary line a start script can print
  - 0 | cost without a telemetry store
note: |
  The owner asked for every build at startup to be measured, through telemetry (2026-11-06). Chord's telemetry (design
  §29) records calls, methods, holds, activations, loads, reloads and worker resolves, but nothing of the builds and
  steps around them. This spec adds those spans to `CHORD_TELEMETRY_SCHEMA` and records them in the kit, the plugins
  component, the surfaces and the workers. A Chord change; p3 uses it from step 0b on.
colophon: Chord startup telemetry · spec, first edition · 2026-11-06 · sources: src/telemetry.ts, src/node/app/, src/node/plugins/, src/node/surfaces/, src/node/workers/, src/web/page.ts, design §29
---

# Before we begin {.preface}

p3 starts on the phone in some number of seconds; a session's worker in some other number; an Apply takes a while.
Nobody knows how those split: the worker base build, the page's base bundle, twenty plugin builds, discovery, the
load, the fork, evaluating scripts. Design §29 has spans for the work objects do, recorded into the kit's telemetry
store, and a renderer that draws a trace as a tree. Starting and building happen outside objects and record nothing.

This spec gives each such step a span, under one root per start, so a trace of a server start reads like this:

```text
chord.app.start  p3                                                  1,840 ms
├─ chord.app.layout                                                     12 ms
├─ chord.store.open  server                                             38 ms
├─ chord.base.build  worker:session   files=301  bytes=4.2 MB          240 ms
├─ chord.base.build  web              files=412  bytes=1.9 MB          610 ms
├─ chord.base.build  server           files=265                         64 ms
├─ chord.plugins.discover             plugins=7  problems=0              4 ms
├─ chord.plugins.build  @p3/hello server                                31 ms
├─ chord.plugins.build  @p3/hello web                                   48 ms
├─ …
├─ chord.load  server                 plugins=7                        180 ms
└─ chord.app.listen   127.0.0.1:8789                                     2 ms
```

(The numbers are made up; finding the real ones is the point.)

## Five things to know

:::findings
1. **Four roots.** `chord.app.start` (a server start), `chord.worker.start` (a worker process, from fork to loaded),
   `chord.page.start` (a page, from its first script to its plugins loaded), `chord.app.apply` (an Apply: build and
   rollout). Each is a trace of its own; a worker start links to the server's resolve that forked it.
2. **One span per step, with sizes.** Base bundles carry their artifact, file count and bytes; plugin builds their
   plugin, kind and outcome; discovery the plugins found; loads the plugins loaded and failed.
3. **Recorded where the work happens.** The kit, the plugins component, the surfaces and the workers component record
   their own steps under the context they are given; nothing measures from outside.
4. **A summary for the start script.** `app.startup` gives the start's steps and their durations, recorded even without
   a telemetry store, so p3's `server.ts` prints one line.
5. **Free without a store.** Without an adapter the spans are the NOOP span (design §30): no allocation beyond
   today's, no clock reads in hot paths (these are not hot paths: each runs once per start or per Apply).
:::

# The Spans {#spans lede="Names, parents and attributes, as the telemetry schema declares them."}

| Span | Parent | Start attributes | End attributes |
| --- | --- | --- | --- |
| `chord.app.start` | root | `app` (name) | `outcome` (`started`, `failed`) |
| `chord.app.layout` | `chord.app.start` | | |
| `chord.store.open` | the step that opens a store (`chord.app.start`, `chord.worker.start`) | `store` (`server`, `worker`) | `tables`, `bytes` (file size) |
| `chord.base.build` | `chord.app.start` | `artifact` (`web`, `tui`, `worker:<kind>`, `server`) | `files`, `bytes` (output), `outcome` |
| `chord.plugins.discover` | `chord.app.start`, `chord.app.apply` | | `plugins`, `problems` |
| `chord.plugins.build` | `chord.app.start`, `chord.app.apply` | `plugin`, `kind` | `outcome` (`built`, `failed`), `inputs` |
| `chord.load` (exists) | `chord.app.start`, `chord.worker.start`, `chord.page.start` | as today | as today |
| `chord.app.listen` | `chord.app.start` | `address` | |
| `chord.worker.start` | root, linked to the server's `chord.resolve` | `kind`, `address` | `outcome` |
| `chord.worker.fork` | `chord.worker.start` | | `ms_to_main` (process start to the entry's first line) |
| `chord.worker.lock`, `chord.worker.connect` | `chord.worker.start` | | |
| `chord.plugins.evaluate` | `chord.worker.start`, `chord.page.start`, `chord.app.start` | `plugin`, `kind` | `outcome` |
| `chord.page.start` | root (the page's own recorder) | | `outcome` |
| `chord.page.connect` | `chord.page.start` | | |
| `chord.app.apply` | root | | `built`, `failed`, `stopped` |
| `chord.rollout.step` | `chord.app.apply` | `step` (`server`, a worker kind, `web`, `tui`) | `hosts`, `failed` |
| `chord.reload` (exists) | `chord.rollout.step` (server), the worker's own (workers) | as today | as today |

Where each is recorded:

- **Server start** (`src/node/app/app.ts`): `startServer` opens `chord.app.start` with the app's telemetry context
  (the `telemetry` option) and passes the span's context to each step: the layout, the store, the workers components
  (each builds its worker base: `chord.base.build worker:<kind>`), the surfaces (`web`, `tui`), the server scan
  (`server`), the plugins component (discovery, builds, evaluation), `host.load` (its existing `chord.load` gets this
  parent), the listener.
- **Worker start** (`src/node/workers/`, `src/node/app/worker.ts`): the server's `chord.resolve` puts its carrier into
  the start message; the worker's recorder opens `chord.worker.start` linked to it and records the fork (the time from
  the process's own start, `performance.timeOrigin`, to the entry's first line), the lock, its store, the connect, each
  script's evaluation and the load; the worker sends them to the server as it sends all its spans.
- **Page start** (`src/web/page.ts`): a page that records (`startPage({ telemetry: true })`) opens `chord.page.start`
  when its base bundle runs, with the time from navigation start (`performance.timeOrigin`) as an attribute, then the
  connect, each plugin script's evaluation and the load.
- **Apply** (`app.applyChanges`): `chord.app.apply` with discovery (when the set changed), each build, and each rollout
  step; each host's `chord.reload` as today under its step (workers' under their own trace, linked).

# The Summary {#summary lede="One line a start script can print, with or without a telemetry store."}

```ts
const app = await startServer(options, context);
console.log(app.startup.line);   // "started in 1,840 ms: bases 914 (web 610, worker:session 240, server 64), plugins 410, load 180"
app.startup.steps;               // [{ name: "chord.base.build", attributes: { artifact: "web" }, ms: 610 }, …]
```

`app.startup` is recorded by the same code that opens the spans, from one clock read at each step's start and end;
without a telemetry store the steps are still timed (a start is one call; the cost is a few `performance.now()`
reads). The worker and the page have no summary: their spans are in the store, read with the kit's trace tools
(`trace.ts` as in the tutorial; later a viewer plugin).

# Tests and Done {#done lede="What the build delivers."}

- The schema entries in `CHORD_TELEMETRY_SCHEMA` (version bumped), each span recorded where listed, its parent and
  attributes checked with the in-memory telemetry adapter: a server start with workers and both surfaces; a worker
  start linked to its resolve; a page start in the browser; an Apply with a failed plugin and a stopped rollout.
- `app.startup` with and without a telemetry store; its `line`.
- Without an adapter: no new spans, the existing cost guards unchanged.
- Design §29 (the tiers and the new roots), the kit README (`startup`), the plugins, surfaces and workers READMEs; the
  tutorial's trace chapter shows a start's trace.
- `npm run check`, the touched suites.
