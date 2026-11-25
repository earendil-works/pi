# Slice 9: telemetry (spec)

Status: **draft for the build** (owner, 2026-11-03: "build i18n, then slice 9 (we said we want cross host spans)";
2026-11-04: "go ahead"). Telemetry was decided on 2026-10-18 (decisions under "## Telemetry" in `decisions.md`, from
"Context" to "Telemetry store") and is stated in design.md §29 and §30 (cost guards). Chord v2 so far records only
metrics (cost counters such as `chord.data.validations`, `chord.link.encodes`) and stores a persisted job run's start
carrier (slice 6b). This slice adds the spans, events and metrics of §29, carriers across links, and Chord's telemetry
schema, so one trace follows a call from a page through the server's relay into a worker's method, Durable's phases
and pi-ai's model request.

Read in full before writing code: this spec; `decisions.md` (the telemetry decisions of 2026-10-18, R5 in "R4 and R5,
protocol header schema", and every later entry that touches telemetry, links, relays, workers or jobs); `design.md`
(all of it; §22 wire, §29 telemetry and §30 cost model in particular); `slices.md` (the feature map rows for §8
`ctx.trace`, §12 the container-width benchmark, §22 trace carriers, §29; the carry-over "Slice 9"); pi-telemetry
(`packages/telemetry/src`: `TelemetrySpan`, `TelemetryContext`, propagation, links, metrics, typed schemas, the in-memory
adapter, `render.ts`, the conformance tests); Chord's `src/telemetry-sqlite/`; Durable's `harness/telemetry.ts` and how
Durable starts its spans (the model for a typed schema); pi-ai's `pi.ai.request` wrapper; Chord's `src/context`,
`src/host` (ctx, object, attempt, root, host, routines, jobs), `src/link`, `src/remote`, `src/node/http`,
`src/node/workers`. Root `AGENTS.md` "Chord v2 Code Style" (binding).

## 1. Chord's telemetry schema

`CHORD_TELEMETRY_SCHEMA` (`src/telemetry.ts`, exported from the root), typed with pi-telemetry's
`defineTelemetrySchema` like `DURABLE_TELEMETRY_SCHEMA`: every span, event and metric name Chord emits with its
attributes. The existing cost counters (`chord.data.*`, `chord.link.*`, `chord.store.*`, `chord.query.runs`,
`chord.cycle.visits`) are declared in it and recorded through it. Ids (object identity, hold, call, address key) are
span attributes only, never metric attributes.

## 2. Spans

All spans are short and in one process (decision "Durable and AI spans"). Names and their parent:

| Span | Where | Parent | Attributes (besides ids) |
| --- | --- | --- | --- |
| `chord.call` | a consumer's call of a remote member (`ref.method(args, ctx)`) | the caller's `ctx.telemetry` | type, member, address kind |
| `chord.method` | a provider running a method | the call's carrier (remote) or the caller's span (local) | type, member, principal kind, outcome |
| `chord.relay` | a relay forwarding a hold or a call | the arriving carrier | type, member or `hold`, upstream address kind |
| `chord.hold` | a consumer's hold until bound (the first `bound` or failure) | the holder's span | type, outcome |
| `chord.activate` | one activation attempt of an object (factory, natives opened, live or failed) | root, linked to its first trigger | type, attempt, outcome (live, failed, parked) |
| `chord.open` / `chord.close` | one native's open / close | the attempt's span / root | type, native index |
| `chord.load`, `chord.reload` | a host's load / reload | the caller's span | plugins, fates counts |
| `chord.resolve` | a route resolving an address (a worker start included) | root, linked to its first trigger | kind, outcome |
| `chord.revoke` | a revocation | the caller's span | count |
| `chord.routine` | one routine run (`self.on`, `onLive` handler) | root, linked to the commit that triggered it when known | type, routine |
| `chord.job` | one job run phase (intent, run, finish) | the stored carrier (persisted) or the starter's span | job, phase, outcome |

- **Shared work** (one activation for several getters, a worker start for several holds) is its own root span linked
  to its first trigger; each waiting span links to it (decision "Across links" / "Shared work").
- **Failed spans** carry `status: "error"` with a fixed category (`activation_failed`, `call_failed`, ...) and the
  error message truncated to 500 characters; cancelling is not an error (decision "Errors in telemetry").
- **`ctx.trace(name, attributes, fn)`** (round-3 cut C11, decided here as kept: design §29 already states it): a child
  span of the handler's `ctx.telemetry`, `fn` gets a child `ctx` (principal and `get` kept), so calls inside are parented.

## 3. Across hosts

- **Carriers on the wire:** `call` and `hold` get an optional `trace` field (R5: a `TelemetryCarrier`, bounded: at most
  8 keys, keys and values at most 256 characters; over the bounds the message fails the `MESSAGE` schema as any malformed
  header). The consumer injects `ctx.telemetry`'s carrier when its adapter has propagation; the provider extracts it
  (malformed or absent: the adapter's root, never a throw) and starts `chord.method` under it. The binary codec gets a
  flag bit for the field; the text codec an optional element. `PROTOCOL_VERSION` stays 1 (nothing is deployed outside
  our own apps; the carry-over rule for bumps applies once p3 ships).
- **Relays** read the carrier from the envelope, start `chord.relay` under it, and forward the relay span's carrier
  upstream (the envelope rewrite already copies the header once).
- **Workers** (`chord/workers`): a worker start is a `chord.resolve` root span; a held worker's methods are
  `chord.method` under the forwarded carrier, so a trace reads tab → server relay → worker method.
- **HTTP** (`chord/http`): a request is a `chord.http` span (method, route pattern, status; the path never, it may
  carry ids or secrets), its handler's `ctx` under it; an incoming W3C `traceparent` header is extracted only from a
  contributed relay that `verify`s (never from browsers).
- **Durable and pi-ai** already accept a span (`HarnessOptions.telemetry`, pi-ai's `telemetry` option): a worker's
  Harness gets its host's adapter, and a method that submits input passes its `ctx.telemetry`, so `pi.durable.submit`
  is a child of `chord.method` (Durable starts its own trace per input submission and links to the trigger, as decided).

## 4. Events and metrics

- **Events** on the enclosing span: `chord.commit` (documents, ops, duration) for commits inside a method or routine,
  `chord.retry` (backoff), `chord.park` (cause), `chord.reload.fate` (one per object fate: swapped, restarted, parked).
- **Metrics** (low cardinality, never ids): `chord.link.state_messages`, `chord.link.bytes` (encoded WebSocket frames,
  sizes the code already has), `chord.commit.duration`, `chord.calls.in_flight` (up/down), `chord.holds.active`,
  `chord.links.open`, `chord.park.duration`, `chord.backpressure.wait`. Nothing is serialized or walked to measure.

## 5. Storage and reading

`chord/telemetry-sqlite` exists (decision "Telemetry store"); check it against §29 and fix gaps (links inline, metrics
per 10 s series, retention, bounded queue). The app kit: `startServer` and `startWorker` take an optional `telemetry`
adapter (default NOOP) and pass it to their hosts, HTTP and workers; a worker's adapter comes from its `startWorker`
options (the kit does not ship spans across processes itself: each process exports to the store it is given; a shared
SQLite file per data directory is the app's choice, documented with a short example).

## 6. Cost

With the NOOP adapter every span site costs one call and an empty object; no carrier is injected (no propagation),
no attribute objects are built when the adapter cannot record (check pi-telemetry's API for the cheapest form; no
`isRecording` exists: decided). Cost guards: the slice's tests assert through the in-memory adapter that a call over a
relay produces exactly the spans of §2 and no extra encodes; a benchmark (`test/bench/telemetry.ts`, by hand) measures
a call over a link with the NOOP adapter versus without the span code (target: within noise) and with the in-memory
adapter; results in `docs/benchmarks.md`. The §12 container-width benchmark (R24) is carried over into this slice's
benchmark file if not done yet (check `benchmarks.md`).

## 7. Tests and examples

- One test file per source file, one `describe` per mechanism; the in-memory adapter and `renderTrace` for assertions.
- A cross-host test: a client calls a method over a relay into a worker (memory links or the workers component), the
  method commits and calls a local object; the store-rendered trace shows client `chord.call` → server `chord.relay` →
  worker `chord.method` → `chord.commit` event, one trace id; a malformed carrier from a client gives a new root.
- Jobs: a persisted run resumed in a new attempt stays under its stored carrier (slice 6b's field, now used).
- Example `62-telemetry`: a kit app (server and a worker kind) with the SQLite telemetry store, a page or a client
  calling a worker method that submits to a fake Durable harness or does a model-free piece of work; it prints the
  rendered trace across the three hosts and a metric query.
- Docs: design.md §29 marked built with anything refined; the guide gets a short chapter "Seeing a request across
  hosts"; CHANGELOG under Unreleased; delete the carry-over section "Slice 9".
