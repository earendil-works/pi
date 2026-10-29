# Redesign decisions (input for target design v2)

Decisions made with the owner after the plugin review round on `target-design.md` (6559589bd), in the order they were
made. Later entries supersede earlier ones; superseded entries are marked inline and point to their replacement. The target design v2 is `packages/chord/docs/next/design.md`, written from this log; new decisions land here
first and win until the design is updated.

## Plan

- **p3 next to p2, fully isolated.** The new design is built as a new app (`apps/p3`) with its own data directory. p2
  keeps running unchanged with its data. Plugins are ported to p3 one at a time.
- **No legacy data migration.** p3 starts empty: no import of p2's `catalog.sqlite`, `shares.sqlite` or subagents table.
- **Chord v2 lives in `packages/chord/src/next`** (export `@earendil-works/chord/next`), developed on `private` only
  (owner override of the "pi first" rule for this directory) and upstreamed to pi once stable; then `next/` replaces
  today's Chord and p2 is deleted. `next/` imports `../context`, `../delta`, `../json`, `../output` directly, so
  Durable's `Context`, `Draft` and `JsonValue` are the same modules and types in v2 (no copies, no type conflicts).
  (Replaces "Chord v2 lives inside p3".)
- **Build a playground before p3:** a small system with p3's shape (server, worker processes over IPC, clients over
  WebSockets) and toy plugins, one per concept; it proves the concepts and reload and is the e2e test ground.
  Location `apps/chord-playground` (private). Client: a web page first (a CLI client possibly later). Order: kernel
  (hosts, links, objects, references, principals), then plugin loading and reload with the dev loop, then the web shell
  with a private preview, then each feature built live as a plugin. Plugin changes reload; Chord changes restart the
  hosts (fine for the owner).
- **Chord v2 is written fresh** in `packages/chord/src/next`, copying what fits from today's Chord (link, wire, cell,
  delta and the like). It needs the same test coverage as today's Chord (tests under `packages/chord/test/next`).
- **Playground web stack:** React, built with esbuild (loader D) instead of Vite, if feasible.
- **Reload control in the playground's web shell:** when sources changed, a control pops up listing the changed
  plugins (reload them) or base code (restart all hosts); the owner triggers it manually. The agent can trigger the
  same actions (command or tool). Never automatic on save.
- **Preview:** `https://p3.mariozechner.at` on slayer (wildcard DNS already resolves), set up like
  `~/p2.mariozechner.at` (Caddy container on `caddy-network`, unix-socket bridge, `run.sh` in tmux) with `basic_auth`;
  the password is chosen by the owner and never stored in the repo. `p2.mariozechner.at` stays the live p2.

## Natives

- **Natives only in objects.** An object opens a native in its synchronous factory with
  `self.open(async ({ signal }) => value, close)`; Chord opens it during activation (the object goes live after all
  opens) and closes it when the object ends, in reverse order. The value never changes during the object's life: no
  `self.resource`, `version`, `replace`, `deps`, reopen, stale handles or "read `.value` at use".
- **The factory principle:** synchronous, declares only (references, documents, natives, derives, routines, jobs,
  contributions); Chord performs activation; the factory receives handles usable in everything it registers; handles
  are valid for the object's whole life.
- **No natives across plugins:** other plugins reach a native only through the owning object's methods and state, or
  through the owner's registry entries ("Registries and HTTP"). No callbacks as method arguments, also not on
  `local` types ("Object kinds").
- **The facet is a pure object.** (**superseded in part** by "Facet documents are removed" and "Facets only declare" (2026-10-26): no documents, no routines) It may hold documents, references, routines and contributions, and may not open
  natives (`self.open` does not exist on the facet). Served objects of a facet may read and write the facet's documents;
  a served object's transaction may span its own documents and its facet's documents (lock order: own line, then the
  facet's). The facet may not reach into its served objects' documents.

## API style

- **Tagged unions, always,** instead of a status string plus fields that only mean something in some states ("field
  soup"). Each state carries exactly its own fields, and consumers narrow on `kind`. Example: `ref.state` is
  `{ kind: "failed"; cause; retryAt } | { kind: "live" } | ...`, not `status` plus `error` plus `retryAt`.

- **Context last (owner, 2026-10-21):** parameters are the required arguments, then the context (`ctx` or a Durable
  `Context`), then optional arguments, as Durable already does (`Storage.scanEntries(query, limit, cursor, context)`,
  `transaction(change, context)`). Examples: `self.tx(fn, ctx)`, `handle.change(fn, ctx)` and keyed
  `handle.change(key, fn, ctx)`, `handle.retire(ctx)` and keyed `handle.retire(key, ctx)`, `chord(fn, context)`,
  `job.start(args, ctx, { key })`. Applied to design.md, the guide and the walkthrough; the frozen `step-*.md` and
  `kernel.md` document the frozen code and keep its signatures. pi's `traceIn(context, options, fn)` (implemented in
  `chord/context`) becomes `traceIn(options, fn, context)` in the same pi change as S1 (owner, 2026-10-21).

## Hosts and placement

- **Placement is a function** of the object's typed input, not data naming an input field (`hostFamily(prefix,
  key)` looked a key up in the input untyped). A function is type-checked and composable. The caller runs it and
  sends the result; the provider runs it too and refuses an object that is not its own. Placement is then no longer
  part of the contract fingerprint; a changed rule surfaces as that refusal.
- **Incarnations are minted by Chord** (uuidv7, the code copied from pi-ai into Chord: no dependency), never passed
  in; the link handshake carries it, so the other side sees a restart as a new incarnation of the same identity.

- **The low-level host API** (no topology layer; Radius and DO show entry points vary, so the kernel has no
  "listen"):
  - host kinds are typed: `hostKind("server")`, `hostKind("session", Type.Object({ id: Type.String() }))`; an address
    is `Session({ id: "S1" })`; placement functions return addresses; no host-name strings in app code;
  - `createHost<P>({ address?, principal? })`: a host with an address is addressable and acts as `principal` on its
    own host; no options is a client (not addressable, no own principal); the incarnation is minted inside;
  - (**superseded in part** by "Host values are removed" (Review round 1): start data is a core object) `host.provide(Key, value)` before `load`; factories read host values with `self.value(Key)`;
  - `host.load(facets)` takes imported facets (loaders are adapters);
  - `host.connect(link, { principal })`: the link to the parent (at most one), `principal` = who the parent is;
    today's duplicate `upstream` option is gone;
  - `host.accept(link, { principal })`: a link from a client; every entry point (loopback/tunnel WebSocket server,
    Radius channels, a DO edge, memory) is app or adapter code that authenticates and calls `accept`;
  - `host.route(Kind, { authorize(principal, address), resolve(address, { signal }) => { link, principal } })`:
    how to reach hosts of a kind; `authorize` runs before anything starts; Chord calls `resolve` once per address
    while its link lives and again after a drop; the returned principal is stamped on that link (defined once, in
    the parent; the app sends it to the child in its own start message, with any init data);
  - starting processes, init data and keep-alive are app code (helpers later if apps repeat them).
  Close to today's shape (`createHost`, `connect`, `accept`, `route`, `load`); gone: string host names and prefix
  parsing, app-managed generations, `upstream`, `opaque` runtime objects, the loader inside the kernel.

## Quick decisions on the design's open points (design.md section 26)

- **Call-scoped natives (#4):** no `ctx.open`; a native that lives for one call is opened and closed in the method with
  `try/finally` (documented pattern). Revisit only if it shows up often.
- **Documents across plugins (#6):** no plugin reads or writes another plugin's documents (Chord or Durable). Data
  crosses plugins only through state and methods. ~~Within a plugin, the facet's documents are readable and writable
  by the objects that facet serves (decided earlier).~~ (**superseded** by "Facet documents are removed") Data core enforces lives in a format core owns and is handed to
  core through its API when the data is created (e.g. `createConversation` with `init`), never written into core's
  documents directly.
- **`overlap` for routines (#8):** no `overlap: "latest"` option; a handler compares with the current value itself.
- **Async activation guard (#3):** none; authority checks live in the per-principal view's methods (and in
  `route.authorize` before a host starts).
- **`close` with a reason (#7):** `self.open(open, (value, reason) => …)` with `reason: { kind: "reload" } | { kind:
  "stop" } | { kind: "end" }`, decided by Chord (its plugin is in the reload set and the object is native / the host is
  shutting down / the last reference ended or its type was removed). Owners decide what to do with it. Chord aborts
  only the object's own calls and jobs; work elsewhere that uses the native (e.g. Durable tool executions using a code
  mode sandbox) is the owner's to drain or end in `close` ("old code keeps running" applies to natives too).
- **Code mode in p3 drains its sandbox in `close`** (**superseded in part** by R16 (`close` detaches the sandbox and disposes of it in the background)) (not moved into Durable): the plugin keeps owning the
  `pi-codemode` sandbox; on `reload` (and `stop`) `close` seals it (no new scripts), running scripts finish or hit
  their deadline, then its VMs and worker threads end (`closeWhenIdle` in `pi-codemode`, or a counter in the plugin).
  New scripts start on the new sandbox through the registry entry. `RunningCalls`, the removal message and
  `abortTask` on reload go away; after a worker stop Durable replays as today.
- **Invariants across owners (#5):** the owner of the dependent data enforces the rule by reconciling from the other
  owner's state with an idempotent routine; no cross-owner transactions, no "notify the other owner" calls that can
  be lost. Example: ports' forward store watches the catalog and closes forwards of archived sessions (also after a
  crash, from the current value); sessions does not know ports exists.

## Wire (#15)

- ~~**Compression:** large JSON envelopes are deflated on WebSocket links (relayed and mobile links benefit); byte
  segments stay raw and uncompressed; IPC never compresses.~~ **Superseded** by R1 and "Compression at the origin".
- **Frame size limit per link adapter** (**superseded in part** by Q2 (limits per part from the header; `maxPayload` only as the hard cap)) (e.g. 16 MiB on client WebSockets, none on IPC): a frame over the limit fails
  that call or member with `too_large`, the link stays up. Large uploads go through owner chunking anyway.
- **One batch per commit per link:** a commit that touches several holds on one link travels as one `state` frame;
  the consumer applies every member update of it before listeners run. Remote consumers never see a torn commit,
  matching local subscribers, who are notified once after every document of a commit is adopted.
- **Adapted bindings get diffs:** a consumer bound through `accepts` (an older contract version) is served like a
  derive of the provider's state through the adapter: Chord keeps the last adapted value per binding, applies the
  adapter to the new value and sends the diff (`diffRevisions`), never the whole adapted value per commit.

## Gaps closed after the walkthrough rework

- **Clients** serve only `local` types (not addressable); local calls have no principal; what a client calls on the
  server is stamped with the client's authenticated principal.
- **Placement refusal** is `invalid/placement`; during a rollout it is handled like a mismatch (provider on another
  revision: park; same revision: fail).
- **HTTP route signature:** `(req, ctx) => Promise<HttpResponse>`; `ctx.principal` is the request's principal (from
  the request resolvers), so `ctx.get(Notes, …)` gives that principal's view.
- **Start barrier** (**superseded in part** by R17 (the harness starts after the barrier, which waits until every plugin loaded or failed)) counts facets and `lifetime: "host"` objects; an object that must contribute at start (the model
  runtime) is `lifetime: "host"`.
- **`persist` only in `local` objects and `lifetime: "host"` objects** (**superseded** by P3: only in input-less `local`
  objects) (identities without a principal); `storeKey`
  is dropped (two principals' objects writing one document would be two lines on one document). Enforced at the type
  level (`self.state` in a remote factory takes only non-persisted definitions) and as a declaration error at runtime
  ("persist needs a stable identity: put the documents into a local core").
- **Call deadlines:** a call ends through the caller's signal; there is no per-call deadline of its own. Parked calls
  (link drop, loading, rollout) share one default deadline (60 s, like `readyTimeout`), then fail `unavailable`.
- ~~Lingering through `ref.release({ linger: true })`~~ **superseded** by D8 (no consumer-side linger). Was: a closing view releases with `ref.release({ linger: true })`; the hold stays, marked lingering, until
  its timeout. A link drop is still a departure (presence details stay open).
- **Contributor order** (**superseded in part** by "Contributor order is sorted by plugin name (never load order)" in the design, section 17) is load order (alphabetical by plugin name), deterministic on every host and across reloads,
  and carries no meaning: wraps in one phase must not depend on each other; meaningful order comes only from phases.
- **Revocation without field patterns:** the app defines a typed revocation type and a function
  `createHost<P, R>({ …, revokedBy: (p: P) => R[] })` (the same app code on every host); `host.revoke(r)` ends every
  object and closes every link whose principal `p` has `r` in `revokedBy(p)`, and propagates `r` (a small JSON value)
  to the children, which apply their own `revokedBy`. No `PrincipalPattern`, no local-only predicates, no re-stamping:
  a changed grant (mode `write` → `read`) is a revocation of the old one; the client reconnects and authenticates
  anew, and its references re-hold.
- **Per-session native owners:** (**superseded in part** by "Host values are removed": the session is read from the core object `SessionInfo`) the facet cannot `self.get` a type it serves, so a worker-wide native owner is a
  `lifetime: "host"` object without input that reads its session from a host value (`self.value(SessionInit)`).

## Documents step

- **Plugin identity:** every plugin has a `package.json` whose `name` is its globally unique, stable plugin name (like
  an npm package name); that name identifies its facets (~~persisted facet documents,~~ reload, diagnostics; **superseded in part** by "Facet documents are removed"). Loader D
  reads it; static composition passes the same name. Never a directory name, never load order.
- **Document roots are `JsonObject`,** as in Durable (`defineDoc<T extends JsonObject>`); lists live in a field. Documents
  hold JSON only.
- **In-memory documents end with their object** (last reference released, linger expired); they survive reloads and
  native restarts of a live object. What must outlive the object is persisted or lives in a `lifetime: "host"` object.
- **Chord ships its own document storages, no adapter over Durable's storage:** (**superseded** by "The store"
  (2026-10-21): Chord's persisted documents live in the per-session store, next to Durable's adapter and plugin tables) in-memory and SQLite (JSONL was cut later)
  implementations of `DocumentStorage`, inspired by Durable's storage implementations (atomic commits, base plus
  deltas, incarnations) but with Chord's own schema: ordered keys per owner and definition, a tag index. Durable's
  storage is shaped for Durable (scans by id, no tags); Chord documents and Durable transcripts never commit together,
  so they need not share a storage. Node-specific storages live outside the portable core; a Durable Object SQLite
  storage can follow. (Replaces the earlier "adapter over Durable's node SQLite storage" for the playground.)
- **Durable's SQLite driver layer moves into Chord** (`@earendil-works/chord/sqlite`, `/sqlite/node`,
  `/sqlite/cloudflare`): the `SqliteDatabase`/`SqliteExecutor` interfaces, the `node:sqlite` and Durable Object
  drivers, the migration runner and schema-prefix helpers. Durable imports them from Chord (it already depends on
  Chord, so no cycle) and re-exports them under its old paths so no Durable user breaks. Chord's SQLite document
  storage uses the same drivers (`next/` imports `../sqlite` like `../output`). Done in pi first, then merged.

## Derives and natives step

- **`self.open` returns a handle** whose `.value` is the native (throws before activation); no forwarding proxy
  (private fields and identity break through proxies). The value never changes during the object's life.
- **A partly failed activation** closes the natives already open (reason `end`) and opens all of them again on the
  next attempt.
- **A broken part fails the whole object** (owner): a derive that throws, or a document whose hydration or `migrate`
  fails, makes the object `failed`; an incomplete object could break invariants that rely on atomic commits across its
  documents. (Replaces "member-local" errors for documents.)
- **`previous` of derives** is tested through failed/retry until the reload step exists.
- **`self.retryOn` may appear anywhere in the factory:** the factory specifies, the host orders and executes (watches
  are installed before natives open).
- **Failure causes are tagged:** `{ kind: "transient" }` (an `open` throws, a reference is unreachable) gets the
  automatic backoff; `{ kind: "broken" }` (factory, derive, document hydration or `migrate` throws; or an `open` that
  throws `broken(…)` because retrying is pointless, e.g. invalid config) gets no automatic retries, only reload,
  `ref.retry()` or `retryOn`. Chord decides by where it failed; only an `open` can choose `broken` itself.
- **Activation waits for its dependencies:** an object whose references are not live yet stays `loading` and goes live
  as soon as they are (bounded by `readyTimeout`, then it fails `transient` with the dependency as cause); ~~a `broken`
  dependency fails it at once. No retained references while failed.~~ **Superseded** by R18 (dependency failures are
  `transient`, references are kept as an automatic retry trigger).
- **Timeouts** are host defaults with per-thing overrides: `closeTimeout` 30 s (per native), call drain on teardown
  = `closeTimeout` (per type), `readyTimeout` 60 s (per `get`), park deadline 60 s (per type), routine handover 10 s
  (per routine), job `finish` retry backoff 1 s to 60 s (per job), rollout install 60 s, linger per type; route
  `resolve` is bounded by the app's signal.
- **Inbox path:** the notes plugin computes its own inbox path from generic start data (the data directory; host
  values were removed later, start data is the core object `SessionInfo`).
  Natives open sequentially in declaration order and close in reverse; a throwing `close` does not stop the others
  (`host.close` rejects with all errors, background cleanup reports to `onError`). Type names `Native<T>`,
  `NativeCloseReason`.
- **`retryOn` sources** must live independently of the attempt (facet documents, registry values; host values were
  removed later;
  readables the host provides); a reference's member is not allowed (type error). Dependency waiting covers references.
- ~~**A facet that fails transiently in activation** retries automatically~~ (**superseded** by "Facets only declare": a facet cannot fail after `load`) with backoff, like an object; it does not wait
  for a reload.
- **Park deadline per consumer:** `get(..., { parkTimeout })` overrides the host default for that reference; the
  provider's per-type override applies to its own local bindings.
- **Playground:** the inbox watcher only opens and closes for now (the import comes with routines); a note-count derive
  and the reader's redaction as a derive are visible to clients.

## Telemetry

- **Context:** (**superseded in part** by "Telemetry types and review cleanup": `Context.telemetry` is always a
  `TelemetrySpan` and `withTelemetry` takes spans) Chord's `Context` gets `telemetry: TelemetryContext` as a fixed member, like `abortSignal` (never
  undefined; `NOOP_TELEMETRY_CONTEXT` by default), with `withTelemetry(telemetry, context)` and
  `traceIn(context, options, fn)` (child span, `fn` gets the derived context). `value()` and keys stay, forever, without
  deprecation. Durable gets telemetry everywhere through the `Context` it already passes; principal and other app
  values stay out of Durable's context (Durable work runs in the scheduler's contexts and resumes without a caller;
  origin travels as data). In Chord v2, `Ctx` extends `Context`: `ctx.telemetry` is the current span, `ctx.trace(name,
  attributes, fn)` gives `fn` a child `ctx` (principal and `get` kept), so calls inside are parented correctly.
- **One adapter per host:** (**superseded in part** by the adapter is a `TelemetryContext` with readonly `metrics`/`propagation` members, held only by hosts ("Telemetry types and review cleanup")) `createHost({ telemetry })`, the adapter implements `TelemetryContext` and optionally
  `TelemetryPropagation` and `TelemetryMetrics` (no split). Default NOOP.
- **pi-telemetry additions** (pi first): `TelemetryCarrier = Record<string, string>` (opaque, W3C-compatible);
  `TelemetryPropagation { inject(context) → carrier | undefined; extract(carrier) → TelemetryContext }` (absent,
  invalid or unknown carriers give the adapter's root, never throw; carriers are best effort: after an adapter change
  only links are lost); span links (`SpanOptions.links`, required `TelemetrySpan.addLink(link)`, a link targets a
  context); `NOOP_TELEMETRY_PROPAGATION`; the in-memory adapter implements propagation, links and metrics (carrier
  snapshots, no forced W3C fields); conformance fixture with optional `propagation`. No `isRecording` for now (it would
  break adapters, as would closure attributes).
- **Metrics** (in the same pi change): `TelemetryMetrics { counter, upDownCounter, histogram }` with `add`/`record`
  (synchronous, cheap, never throw; histogram `record` takes an optional context for exemplars), `InstrumentOptions`
  (description, unit), histogram boundaries, `NOOP_TELEMETRY_METRICS`, typed through `metrics` in telemetry schemas,
  low-cardinality attributes only.
- **Across links:** (**superseded in part** by R5 (the carrier is a bounded field of the header schema)) `call` and `hold` frames carry the caller's carrier; the provider extracts it and runs the method
  under it; the server adds a `chord.relay` span. Cancellation already travels as `cancel` frames.
- **Shared work** (an activation awaited by several getters, a worker start, the per-object line) is its own root span
  with a link to its first trigger; every waiting span links to it. Work without a running trigger (routine runs, job
  runs, eviction, backoff retries, background closes) is a root span, linked to its trigger where one exists. Chord
  sets all of these; authors may add links through `ctx.telemetry.addLink`.
- **Tiers:** spans for calls, methods, relays, holds, activations, opens, closes, loads, revocations, resolves, routine
  runs, job runs and finishes; events on the enclosing span for commits inside a method (`chord.commit` with docs, ops,
  duration), retries and parking; metrics for background high-frequency work (state frames, bytes on WebSocket links,
  commit durations, in-flight calls, active holds, open links, park durations, backpressure waits). Verbose per-commit
  or per-frame spans are an adapter decision (filter by name); Chord, Durable and pi-ai only report. Sampling,
  buffering and limits belong to the adapter.
- **No measuring for telemetry:** only sizes the code already has are reported (encoded WebSocket frames, `byteLength`
  of bytes, lengths a storage computed while writing); nothing is serialized just to count it.
- **A Chord telemetry schema now** (typed span, event and metric names; used by tests and debugging).
- **Debugging:** (**superseded in part** by the SQLite telemetry store and `TelemetryStore` ("Telemetry store")) a JSONL trace adapter (bounded rotating file, batched asynchronous writes, drops when full, never
  blocks) and a text renderer of one trace now; a web trace viewer in the playground (span tree, durations, hosts,
  links, attributes, events; also usable standalone on a JSONL file) with the web shell.
- **Durable** (pi): (**superseded in part** by "Durable and AI spans" and "Telemetry implementation decisions" (phase spans under the stored carrier; every input submission starts its own trace)) `HarnessOptions.telemetry`; an optional `trace` carrier field on submission and task records (the
  submitting call's or the parent task's carrier, rewritten with the record as other immutable fields are; JSON records,
  no migration, no format bump, old records simply have no link); task runs are child spans while their trigger runs in
  the same process, otherwise root spans linked to the stored carrier; Durable spans get their own schema. Persisted
  Chord jobs store their start carrier the same way.
- **Own schema, no OTel GenAI (owner, 2026-10-18):** pi's AI and Durable telemetry uses its own typed schema
  (`pi.ai.*`, `pi.durable.*`); the OTel GenAI conventions (development status, renames, streaming still `TODO`) are not
  followed. An OTel adapter may translate pi's names to `gen_ai.*` at export. Model stream details are span events, never
  per delta. The pi part of telemetry (propagation, links, metrics, typed metric schemas, `chord/context` telemetry
  member, `HarnessOptions.telemetry` type) is approved as diffed in `/home/badlogic/pi-telemetry`.
- **Durable and AI spans (owner, 2026-10-18), partly open:** (**superseded in part** by pi-ai's option is `telemetry` (a span), not `telemetryContext` ("Telemetry types and review cleanup")) every span is short and in one process. Spans:
  `pi.durable.submit` (admission), `pi.durable.phase` (one invocation of any task's phase; fixed name, `task.name`,
  `phase`, `kind`, `attempt`, `resumed`, outcome as attributes), `pi.ai.request` (one model request). Events:
  `pi.ai.first_chunk`, `pi.ai.block` (per `*_end`: type, index, chars, tool; never per delta), `pi.durable.entry`,
  `pi.durable.submission`, `pi.durable.replay` (a codemode call answered from its journal). No content ever; entry ids
  point to the transcript. Submissions and tasks store their creator's carrier; phase spans are children of it. Every
  input submission starts its own trace, linked to its trigger (bounded traces; subagent report chains do not nest).
  No hook spans for now. Metrics: `pi.ai.request.duration`, `pi.ai.first_chunk.duration`, `pi.ai.tokens`, `pi.ai.cost`,
  `pi.durable.phase.duration`, `pi.durable.tasks.active` (ids never on metrics). `pi.ai.request` is emitted by pi-ai
  in one wrapper around `lazyStream` in `models.ts` (both `stream` and `streamSimple`; reads the event stream, changes
  nothing; deferred results get `pi.ai.poll` the same way); Durable passes `telemetryContext`. Background tasks
  (e.g. compaction) are children of the creating phase like every task. A task picked up by a new process sets
  `resumed=true` and stays under its stored carrier (same trace).
- **Telemetry implementation decisions (owner, 2026-10-18):** `TelemetryContext` carries optional `metrics` and
  `propagation` members (every span from an adapter carries its capabilities), so one type is used everywhere
  (`HarnessOptions.telemetry`, `createHost({ telemetry })`, `Context.telemetry`, pi-ai's option, renamed `telemetry`).
  Entry and submission events only after a successful commit. Several queued inputs started as one run: the run takes
  the first input's carrier and stores the others' as immutable creation-time links on its first phase span; a steer's
  submit span links to the running run's carrier. A phase closed or cancelled without a committed state ends
  `aborted`. Submit spans only on the public submit path; internal admissions inside another commit show as events.
  ToolTask sets `tool.name`/`tool.call_id` on its own span. Write submissions are children of the caller; only input
  submissions start traces. Polls count tokens and cost only for final results. Import budgets raised (pi-ai models
  18, Durable root 71).
- **Errors in telemetry (owner, 2026-10-18):** a failed span carries `status: "error"` with a fixed category name and the
  error message truncated to 500 characters (`provider_error` for a model request, `task_faulted` for a faulted phase).
  Cancelling is not an error (`stop=aborted`/`outcome=aborted` keep status ok). Durable's `onReport` stays unchanged;
  every report is additionally a `pi.durable.report` event on the current span (its own short root span outside any
  span) plus a `pi.durable.reports { type }` counter. (Superseded in part below: no root span for reports.)
- **Telemetry types and review cleanup (owner, 2026-10-18):** `Context.telemetry` is always a `TelemetrySpan` (default:
  the NOOP span); the adapter (`TelemetryContext` with readonly `metrics`/`propagation`) is held only by hosts
  (`createHost`, `HarnessOptions`) to start roots, never put into a Context; pi-ai's option is `telemetry?:
  TelemetrySpan`. Code that only has a Context calls the generic `addEvent` (no typed-events helper, no casts, no
  duck typing). A report is an event on the current span plus the counter and `onReport`; outside any span only the
  latter two. `TaskOptions.trace?: TelemetryCarrier | "root"` (absent: inherit). No protection against broken adapters.
  Telemetry never walks or reads data just to measure (checkpoint event compares the phase only). Instrument caches are
  `WeakMap`s keyed by the adapter's metrics object.
- **Telemetry store (owner, 2026-10-18):** a SQLite adapter in Chord (`@earendil-works/chord/telemetry-sqlite`, reusing
  `chord/sqlite`, Node and Cloudflare): settled spans one row each (events and links inline), metrics aggregated per
  series per 10 s, a 1 s batched flush that also deletes rows older than the retention (7 days), a bounded queue of
  settled spans (dropped and counted), no retries. A shared read interface `TelemetryStore` in pi-telemetry, modeled on
  Jaeger's span reader: `findTraces({ name, attributes, errors, start window, limit, cursor })` returns complete traces
  (newest trace start first, paged by an opaque cursor), `getTrace(id)`, `findMetrics({ name, window, attributes })`.
  Spans carry global ids and a trace id (a root's own id), links carry trace and span id. Both the SQLite and the
  in-memory adapter implement it; one renderer `renderTrace(spans)` (subpath `pi-telemetry/render`) prints links and
  never follows them. Live spans, incoming-link search and duration search are left out. The store's metric read method is
  `findMetrics` (`metrics` is the recording capability). Adapters trust typed inputs (no validation of malformed
  caller values, no try/catch around recording); only carriers from another process are checked (keys present,
  strings), else the root.

## Review round 1 (Astra, Fable): kernel fixes and decisions

Source: `p3-reviews/v2-review-summary.md` (K = kernel fixes, D = decisions).

- **Variants (D11):** a member name has the same kind (state or method) in every variant that has it, and a method has
  the same signature (arguments and result) in every variant; state schemas may differ per variant (redaction).
  Enforced at the type level in `remote(...)` and at runtime for contracts arriving as data. K7 becomes that check.
- **Registry composition is a runtime state, not a staging check (D1; reverses "compose runs in staging").**
  Contributions can be dynamic (only known once a native is open, or changing at runtime), so no conflict check can be
  complete in staging. `compose(table)` is pure and runs whenever the table changes (after a commit, when a contributor
  goes live or ends, when a dynamic contribution changes; contributions may be readables). The composed value is a
  plain value for readers: `compose(table, { report })` always delivers a value, builds the fallback in (e.g. the
  first by plugin name wins) and reports conflicts through `report` (they become owner notices and telemetry events);
  readers never handle conflicts. Only if `compose` throws is the registry in an error state, and readers get an error
  when they use it (like a failed reference). Staging rollback stays for code errors only (load errors, throwing factories). A contribution
  is in the table exactly while its contributor is live (a facet while its plugin is loaded; an object from `live`
  until it ends, fails or restarts). The HTTP router follows the same rule: a duplicate route is a conflict state, not
  a rollback.
- **Code mode reload vs. a pinned Durable phase (D2):** (**superseded in part** by R16 (the old sandbox is detached and disposed of in the background, not drained in `close`)) the code mode tool entry looks up the current sandbox when
  `execute()` starts (not the one it was created with), so a call pinned by a phase before a reload (e.g. waiting in
  an approval hook) starts on the new sandbox; the old sandbox is still sealed and drained in `close` (running scripts
  finish or hit their deadline, then it ends).
- **Natives that follow a relocation (D3):** documented pattern, no new mechanism: the native is a stable manager
  (`self.open` once); a routine on the session location switches its internal resource (e.g. the watched directory)
  and bumps a generation, so late events from the old location are dropped. Used for watchers, prompt resources and
  OS probes in p3.
- **Jobs keep their owner alive (D4):** (**superseded in part** by R11 (revocation ends the objects whatever their jobs)) a job that is running, finishing or blocked in `finish` counts as a reference
  to its object; the object ends only once all its jobs are settled. Starting a job and releasing the reference (an
  HTTP route returning the job id, a tab closing) no longer aborts it. Keep-alive already counts running jobs.
- **Reloading native objects (D5):** stays as decided: native objects of a reloaded plugin restart. In practice this
  costs little: the Durable harness is core (base code, restarts only with the host), terminal PTYs live in the
  separate terminal host process (the server's native is only the connection), model runtimes, sandboxes and the
  search index rebuild in milliseconds; only working on envs (running remote commands are killed) or radius (relayed
  connections drop) hurts, and only on reloads of exactly that plugin. Keeping natives by name was rejected: natives
  have no line, no transactions and no schema, so old and new code would interleave unchecked.
- **Old handles stay valid until their calls settle:** when a pure object is swapped in place, a call that started on
  the old code (and its transaction) keeps working with the old handles until it finishes; only new calls get the new
  handles. Matches "running calls finish on old code".
- **Core vs. plugin is decided by where the code lives:** `src/` (base code, imported statically by the start code
  under a fixed name such as `@p3/core`, not switchable, a change restarts the host) or a plugin directory (found by
  listing, loaded through loader D, named by its `package.json`, switchable, a change reloads it). Core is what the app
  always needs and everything builds on (harness, catalog, access, session location); optional features are plugins
  (code mode stays a plugin).
- **Host values are removed** (no `hostValue`, `provide`, `self.value`, no host-value versions). Start data (session
  id, init, data directory) is a `local` core object with `lifetime: "host"` and constant state, served by the core
  facet from the start message; platform bindings the host owns (a Durable Object's `state`/`env`) are core objects
  whose `self.open` returns the binding and whose `close` does nothing. Plugins read start data through a reference,
  in openers, derives, routines and methods (after activation); nothing reads it synchronously in a factory. A
  long-lived native from the host is a `lifetime: "host"` object in a core facet.
- **`accepts` adapters map values (D6):** (**superseded in part** by R6 (provider-owned old schemas plus mappings)) per member, `state: { member: (newValue) => oldValue }` (pure; Chord wraps it
  as a derive and diffs per binding) and `methods: { name: (oldArgs) => newArgs }` (plus an optional result mapping
  back); members an old consumer does not know do not appear. Authors never build readables for adapters.
- **Revocation and work in cores (D7):** no revocation hook. A core that runs work on behalf of a principal stores the
  grant (or device) as data with the work and reconciles from the grant owner's state (the sharing core's live grants):
  a routine aborts jobs, withdraws questions and drops queued input whose grant no longer exists. The same pattern as
  invariants across owners; it also holds after a crash.
- **Lingering and keep-alive (D8, decides open #1):** (**superseded in part** by R26 (the counts are one readable, `host.activity`)) the consumer-side linger is removed (`release({ linger })`, the
  lingering mark on holds, the consumer linger cache): a closed tab closes its link, so it could never survive the
  case it was made for. What remains is provider-side `serve(…, { linger })` (an object stays alive for a while after
  its last reference, whoever held it; this is what keeps a just-closed conversation warm). Presence is the live
  references (`host.references`). Worker keep-alive works as in p2 (the worker counts, the app's supervisor decides):
  core code on the worker reports viewers (from `host.references`), active calls and running jobs (Chord's counters)
  and Durable tasks (the core `Harness`), plus provider-side lingering objects; the server's supervisor stops the
  worker when all are zero for the idle time (p2: 5 minutes, checked every second). Chord provides the counts, no idle
  logic.
- **Validation cost (D9):** (**superseded in part** by R9 (no dev walks: one behavior everywhere) and R7 (arguments validated for every caller, inputs normalized)) document values are not walked against their schema in production. Instead each
  document record stores the fingerprint of the schema it was written with (computed once per definition from the
  structural schema, ignoring descriptions and titles; written at creation and with the new base after a `migrate`).
  On access Chord compares the token's fingerprint with the record's: same version but a different fingerprint fails
  the object `broken` ("schema changed without a version bump"). Always on, O(1). Every structural schema change needs
  a version bump (an additive change gets a trivial `migrate`). Derives and readables are not validated in
  production; in dev, values may be walked as a bug finder (documents at commit, state at publication). Inputs from
  peers (method arguments, hold inputs, with the provider's schemas) are always validated.
- **Storage failure (D10):** Chord never ends the process. A storage error ends the store and closes the host, and
  `onError` receives a tagged error (`{ kind: "storage_failed", … }`); the app's start code must handle it (log and
  exit with its own code for a supervisor, or reopen). The design states that every app has to; the playground shows
  how (`process.exit` with a distinct code). Fixes the server zombie (a closed host with a live listener).
- **Reading without starting a worker (D14):** (**superseded in part** by R20 (Chord stamps the caller's incarnation as `ctx.incarnation`)) plain pub/sub in an ordinary plugin, no Chord mechanism: the plugin's
  worker facet records the summary locally and publishes it to the plugin's server object (a method call, from a
  routine on the source); clients read the server object, which never starts a worker. The server object keeps the
  latest value per session (a document if it must survive a server restart) and ignores reports from an older
  worker incarnation. Session list, status, children, unread, artifact lists follow this.
- **The K list is confirmed** with these changes:
  - K9: (**superseded in part** by R14 (`checkpointWhen` is required on every definition)) like Durable: storages do not validate deltas against content (the store already holds and validated the
    authoritative value); a commit writes the delta; replay only when loading; checkpoints stay optional per
    document, no default.
  - K16: (**superseded in part** by "Flow control: an ack-clocked window" (call window N, not credits; no byte window)) no count limits that refuse; call credits as backpressure (throttle only, never an error); the byte window
    applies to every frame including first snapshots; holds unlimited (protected by authorization and input
    validation).
  - K17: dropped (an IPC peer producing deep JSON shows up at once in development).
  - K21: (**superseded in part** by "Only `tx.draft`" (`tx.get` is gone) and R12 (drafts are revoked; reads after the commit)) values are immutable by convention (Chord Delta's rule, as in Durable), documented for `tx.get`,
    `handle.value`, `handle.initial()`; no copy, no freeze; the `keys()` index is fixed; the write on a read-only
    transaction after a version bump is documented.

## The state path: minimal compute and memory (after the cost review)

Source: `p3-reviews/v2-cost-model.md` (before/after per hop, measured by Fable and Astra). Replaces the per-change
validation and copies the v2 kernel added around Delta.

- **The model, end to end, as Delta and `replicatedState` (which Durable already uses):** (**superseded in part** by R1 and Q4 (parts encoded once at the origin per hold; relays rewrite headers; one binary format)) values are immutable
  revisions with structural sharing; commits produce exact ops; subscribers on the same host get the same value and
  ops by reference; derives publish through `diffRevisions` (identity short-circuit; bytes are atomic leaves;
  equality never by `canonicalJson`); each frame is encoded once per link and sized from its encoded bytes; relays
  read only the frame header and forward the body opaquely; receivers check a frame once by its header (`JSON.parse`
  already yields strict JSON; bytes recognized in O(1)); consumers apply with `applyImmutable`. No validation of
  state, no clone of snapshots or ops, no repeated walks.
- **A v2 readable is `replicatedState`:** today's `chord/src/state.ts` semantics (immutable value, ordered ops,
  gapless attach with snapshot and cursor) is the one readable implementation, imported by `next/` like `../delta`,
  so Durable's views and document watches are state members without conversion.
- **The store is a port of Durable's store design** (`durable/src/session/transaction.ts`, `session.ts`): one Delta
  tracker per document, prepare and adopt by pointer swap, observers get the commit's ops, storages write the delta
  (or a base when `checkpointWhen` says so) and check only metadata; replay only on load.
- **Only `tx.draft`:** it returns a draft of the current document, or a draft over `initial()` if the document is
  absent; an unchanged draft (empty ops) commits nothing, so an absent document is never stored by being read.
  `tx.get` is removed.
- **`derive` stays as it is,** documented with its footgun (a derive that builds new objects for unchanged data costs
  O(value) per commit and per view) and a cookbook of efficient derives for p2's categories: select a field, look up
  by key, small aggregates (just compute); filter/map a list (an identity cache per source element); redaction
  (preferably separate documents per visibility, otherwise the identity cache); joins (identity cache plus the
  looked-up source's revision); a window over a large list (reuse unchanged parts, as p2's chat window). No `project`,
  no view algebra, no `memo` API.
- **Diffing and derived values come from Delta and today's Chord, not new code:** Delta's `diffRevisions` (tested,
  identity short-circuit) gets bytes as atomic leaves (compared by identity, replaced when different), and v2 calls
  it directly; `next/diff.ts` is removed. Derives reuse today's derived cells (`chord/src/cell.ts`) on top of the
  readable. Delta gets a small, pure, tested helper `mapShared(f)` (an identity cache per source element: a new object
  per changed element, the previous result for unchanged ones), used by derives that build a new object per source
  element; the cookbook documents it alongside the patterns.
- **Same-host calls on `remote` types pass values by reference** (**superseded in part** by R9 (no freezing anywhere, no development mode)) (immutable by convention, as `local`); the dev freeze
  catches mutation. (Replaces "validate and copy arguments and results also on the same host".)
- **Arguments and hold inputs are validated at the provider by the caller's trust:** (**superseded in part** by R7 (arguments validated for every caller; inputs always normalized)) whenever the originating
  principal is not a host principal (guests, owners, any client, also when relayed over trusted IPC), once, with the
  provider's schema; calls from server and worker code are not validated in production. Results are not validated in
  production. Provider schemas are compiled lazily at their first use and cached in a `WeakMap` keyed by the schema
  object; old tokens and their compiled schemas are collected by the GC after a reload.
- **Contract descriptions travel once per (link, fingerprint):** (**superseded in part** by R6 (no descriptions on the wire; strict fingerprints)) a hold sends the fingerprint; the provider asks for
  the description once and caches the parsed token per link; the cache dies with the link.
- **Cost guards:** (**superseded in part** by R9 (the counters are ordinary telemetry metrics, always on; no test mode) and T7 (one encode per hold part at its origin, none at relays)) counting tests in the normal test run (in test mode Chord counts full-value walks, deep copies,
  encodes, schema validations and materializations; per hop a test asserts the counts, e.g. one appended note to a
  500 KB document with 10 viewers: no walks, no copies, one encode per link, no validations) and a `vitest bench`
  suite outside CI (500 KB and 1 MB values, 0/1/10 viewers, memory/SQLite, 1 MiB bytes) with results recorded
  in `packages/chord/docs/next/benchmarks.md`.
- **Naming:** the pattern of a `local` object holding shared data behind per-principal views is the **shared store**
  (not "core"); base code and plugins use exactly the same primitives.

## Cuts and closed deferred points (review round 1)

- **Cut:** the cross-relay reset coordination (`#collectReset`, `#resyncs`, `#resetRequests`): on an overflow a relay
  releases the hold and re-holds, and the provider sends a fresh snapshot. The JSONL document storage (Chord ships
  memory and SQLite). `MemoryDocumentStorage.prepareCommit`/`snapshot` (unused after K9).
- **Kept:** (**superseded in part** by R9 (no dev freeze)) the dev freeze (the safety net for passing values by reference). The Questions service stays a documented
  pattern, not built. **Deferred:** the HTTP and channel components, middleware phases and the Durable Object profile,
  until the kernel fixes and a first real proof (harness, one tool with an approval pause, a code mode reload) are
  done; the playground's web shell serves its pages with plain app code until then.
- **Presence (#10):** a link drop is a departure (accurate and simple); smoothing (a phone switching networks) is the
  UI's job, e.g. a debounced viewer count. Counts per person or origin are derived by the app from
  `host.references` (principal, origin). Workers do not stop on a flicker because of provider-side linger (D8).
- **Optional dependencies (#2):** a rule, no mechanism: an optional dependency is a registry owned by the dependent
  (ports contributes its forwards to `radius.forwards`; without ports the table is empty). No `optional` on `get`.
- **Rollout fixes (#12), built with the rollout step:** (a) a host checks its own install status before waiting on a
  provider (a rejected own install fails at once with the reason); (b) installs are serialized per host; (c) a
  revision also carries the code-set digest (the hash over the facet bundles' content hashes that loader D computes
  anyway; no module analysis), and hosts compare the digest on reconnect, so a server restart with unchanged code
  triggers no reinstall.
- **UI reload vs. leaving (#13):** "leaving" is never derived from an unmount, only from explicit navigation or
  presence (a dropped reference); a component unmounted by a reload has not left.

## Process (after review round 2)

- **Layer by layer, as pi-durable was built:** the existing `next/` code (about 10k lines, kernel steps 1–6) is frozen as
  a reference and not built on; Chord v2 is rebuilt bottom-up in small layers (data and contracts; readable and derive;
  documents and store; objects; references and `ctx`; protocol and links; relay, routes, revocation; routines and
  jobs; registries; reload and rollout; telemetry). Per layer: a one-page spec with data flow, cost per hop, a line
  budget, footguns and what is reused, approved by the owner; a minimal build with counting and GC tests; a cleanup
  loop with fresh reviewers and the owner until he is happy; only then the next layer. Target: 6–7k lines without
  tests. The handoff for continuing after a compaction is `apps/p2/docs/p3-handoff.md`.

## Review round 2: decided items

- **R1, the message protocol and relays:** (**superseded in part** by Q4 (one binary message format on every link), R6 (no `describe` kind) and compression at the origin) a message is a header plus opaque parts, one part per hold. A part's payload
  is encoded once by its origin with that hold's own Delta encoder (path interning per hold, end to end between
  provider and consumer), packed with its byte segments, compressed at the origin above a threshold (`codec`). WebSocket:
  `u32 header length | header JSON | part bytes`; IPC: structured clone of `{ header, parts: Uint8Array[] }`; memory:
  the object. Kinds: `hold`, `release`, `call` (1 part: arguments), `cancel` (consumer to provider); `bound` (1 part:
  snapshot), `state` (n parts: one per hold the commit touched on this link), `result` (1 part), `gone`, `describe`
  (provider to consumer). Relays parse and rewrite only headers: map hold and call ids per link, stamp the principal on
  `hold` and `call` (a principal field from a client link is always overwritten; only a trusted parent link may carry
  one), group parts per destination link (each link gets only its own holds' parts); payloads are never parsed. One
  `state` message per commit per link. Encoding happens when sending: while a link has credits a commit is encoded and
  sent at once; under backpressure its ops are collected per hold and encoded into one part when credits return (still
  atomic for the consumer). Flow control counts the parts' sizes from the header. A re-hold sends a fresh snapshot and
  restarts that hold's encoder and decoder. Two holds of the same principal (two tabs) encode the same ops separately
  (O(change) each). Replaces "relays forward bodies opaquely" from "The state path".

- **R2, frame size limits (owner, 2026-10-19):** (**superseded in part** by Q2 (limits per part; `maxPayload` only as the hard cap)) configurable per link kind: the compressed (wire) size through the
  WebSocket server's `maxPayload`, the decoded size through zlib's `maxOutputLength` in the one decode function,
  wherever decoding happens (relays do not decode). Defaults for client WebSockets 16 MiB compressed, 64 MiB decoded;
  none on IPC. An oversized message fails only its own call (`too_large`); the link stays up.
- **R4 and R5, protocol header schema (owner, 2026-10-19):** (**superseded in part** by Q1 (unknown ids are ignored; only a header failing the schema closes the link)) the message header is a TypeBox schema, a tagged union
  over `kind` (`hold`, `release`, `call`, `cancel`, `bound`, `state`, `result`, `gone`); protocol types derive from
  it, and headers from untrusted links are checked with the schema compiled once (trusted links such as IPC are not
  checked, as for arguments). No kind allow-list: every message resolves against the receiving link's own tables; a
  header that fails the schema, or an unknown kind, hold or call id, is a protocol error that closes that link. The
  trace carrier is an optional bounded field (key count, string lengths) of `call` and `hold` in that schema; relays
  read it from the header. Payloads stay opaque.
- **R7, inputs and arguments (owner, 2026-10-19):** (**superseded in part** by "Params instead of inputs": flat required
  params, no normalization) object inputs are always normalized (defaults, unknown fields
  removed, a canonical identity key), whoever the caller is, so equal inputs give one identity; inputs stay arbitrary
  (nested objects, arrays, records allowed). (**Superseded in part** by Q12: closed schemas, unknown fields rejected.)
  Method arguments are always stripped to the provider's schema and
  validated with it (compiled once), whoever the caller is: trusted principals are not type-checked code (plugins are
  bundled by esbuild without type checks, agents write JavaScript plugins). Bytes are leaves: `instanceof Uint8Array`
  plus an optional length bound, never walked. Results and state are not validated (they come from the provider).
  Replaces "arguments validated only for callers that are not host principals".
- **R8, migration output (owner, 2026-10-19; `initial()` part **refined** by "Simplification pass after 4a" D3: once per definition):** the result of `migrate` and of `initial()` is validated against the new
  schema once, when produced (per document per version change, on load, off the commit path); a failure refuses the
  access, keeps the old data and fails the object. Commits are still never validated.
- **R9, no development mode (owner, 2026-10-19):** one behavior everywhere; the host's `dev` option is removed. Values
  are immutable by convention and never frozen (deep freezing was too costly in Delta), and state is never validated
  (schema changes are caught by fingerprints, migration results by R8). The cost-guard counters (walks, copies,
  encodes, validations, materializations) are ordinary telemetry metrics, always on; tests assert them through the
  in-memory adapter. Replaces "values immutable by convention, with a dev freeze".
- **R10, revocation window (owner, 2026-10-19):** accepted. Work started on behalf of a revoked principal stops when
  the reconciling routine runs; a step started in between still runs. No extra checks before tool calls or approvals;
  there is always some window.
- **R11, jobs and revocation (owner, 2026-10-19):** "jobs keep their owner alive" stays for the normal end (the last
  reference released: a closed tab does not abort a running job). Revocation takes precedence: revoking a principal ends
  its objects at once, whatever references or jobs remain; their jobs get the abort signal and the normal
  `closeTimeout`. A job runs as its object's principal.
- **R12, returning data from transactions (owner, 2026-10-19):** option B, as in Durable: drafts are revoked when the
  transaction settles; transactions write and return at most plain values; data is read after the commit from the
  document (`handle.value`, `handle.get`). No `tx.read`.
- **R13, existence inside transactions (owner, 2026-10-19):** as in Durable, no existence check: `tx.retire` of an
  absent document is a no-op, `tx.draft(…, { tags })` creates a missing document with its tags, existence is read
  outside the transaction. The R12 and R13 patterns are documented in `design.md` (section 9).
- **R14, checkpoints (owner, 2026-10-19; **refined** by "Slice plan and slice-1 review decisions": required only for persisted documents):** no default, but `checkpointWhen` is required on every document
  definition, in Chord and in Durable (a pi breaking change), so forgetting it is a type error. Durable's task-scoped
  documents (nested call, codemode run and journal) return false (they retire with their task); the codemode store
  checkpoints after 64 deltas; p2's small settings documents checkpoint on every write, its growing ones after 64.
- **R15, old calls and migration (owner, 2026-10-19):** as in Durable: running calls keep their old handles until they
  settle, except for documents whose version rose; old code touching a document migrated past its version throws, the
  document stays intact, the call fails once.
- **R16, native restarts (owner, 2026-10-19):** no Chord change: a restart closes the old native, then opens the new.
  Code mode's `close` detaches the old sandbox, returns at once and disposes of it when its scripts finish or after
  the default `closeTimeout` (30 s, no override); its tool entry finds the current sandbox at `execute()`. Documented
  as two patterns for natives: drain in the background, and swap through a registry contribution.
- **R17, harness start (owner, 2026-10-19):** (**superseded in part** by "The harness is an ordinary object") the harness is not part of the start barrier; it starts after it (the
  barrier waits until every plugin loaded or failed, so the registries hold everything that will be there). No list of
  required contributions and no paused state: a missing tool gives its call an error result; a missing model makes the
  generation report "model unavailable" and wait until a model appears; failed plugins are reported with their error.
- **Note for p3, moving a session between instances (owner, 2026-10-19):** copying a session's database to an instance
  with other plugins already works as Durable does: missing tools, sections and hooks are skipped; tasks without their
  definition stay blocked (`missing_task`) until installed or aborted; documents of missing plugins stay untouched;
  stored selections are never rewritten. The UI must show blocked tasks with their reason and offer to abort them (a
  turn waiting on such a task hangs until aborted).
- **R18, dependency recovery (owner, 2026-10-19):** a dependency that fails (or does not become live in time) fails
  the dependent `transient` with the dependency's cause inside, never `broken`. The dependent keeps its references
  while failed; their state is an automatic retry trigger, so the dependent is retried the moment the dependency goes
  live (backoff cancelled; it stays as a safety net). Invisible to factory authors. After `live`, a dependency leaving
  `live` leaves the dependent live; its calls using the dependency get its error or park while it loads.
- **R19, flow control and large snapshots (owner, 2026-10-19):** (**superseded** by "Flow control: an ack-clocked window") snapshots are always admitted, even when larger
  than the window (they consume it); overflow is decided on changes queued after them; after an overflow a re-hold
  waits until the credits cover the last snapshot's size, with a minimum interval.
- **R20, incarnation fence (owner, 2026-10-19):** Chord stamps the calling host's incarnation (from the link handshake)
  on calls arriving over a link: `ctx.incarnation` next to `ctx.principal`, not part of the principal or its key; a
  server object ignores reports from an older worker incarnation by comparing it. Nothing is sent as data.
- **Testing the core (owner, 2026-10-19):** every mechanism decided in review round 2 gets exhaustive, individual tests
  with its edge cases; every layer spec lists them (design section 28).
- **R21, who contributes to registries (owner, 2026-10-19):** only facets and `lifetime: "host"` objects, enforced by
  the type of the factory's `self` (only theirs has `contribute`). Reading registries stays open to every object.
- **R23 (owner, 2026-10-19):** `constant(value)`, a readable that never changes, used for start data.
- **R22 (owner, 2026-10-19):** a host-lifetime object without input gets session-scoped objects with `ctx.get` in a
  routine or method (documented pattern); a `get` with an input computed after activation only if needed.
- **R24 (owner, 2026-10-19):** the container-width cost of structural sharing is documented (one array slot copy and
  one element visit per element per change); a benchmark of long arrays sets the limit; large collections are keyed
  documents or bounded windows. No new mechanism.
- **R25 (owner, 2026-10-19):** rejected are registries created at runtime and entries resolved through mutable
  indirection; a contributor may change its contribution at any time (a readable contribution recomposes on change),
  and readers may look up the current value at use.
- **Changing contributions, `self.writable` (owner, 2026-10-19):** a contribution is fixed for its contributor's life
  or a readable; Chord subscribes to readable contributions and reruns `compose` on every change; use sites follow the
  composed readable or read its current value. `self.writable(initial)` is a host-local readable of any in-process
  value (identity-compared, no JSON, no wire) with `set`, for contributions such as MCP tool lists. Tools, sections,
  hooks, wraps and tasks reach the harness as one Durable `Extension` per plugin; skills and other lists likewise.
- **Removing a contribution (owner, 2026-10-19):** no remove call; an entry leaves when its contributor ends or a reload
  stops contributing; a live contributor with nothing to offer sets its readable to the registry's empty value (no
  `undefined` entries).
- **R26, drift (2026-10-19):** fixed in the text (the description frame is gone with R6; §9 no longer says values read
  in a transaction are shared). Keep-alive counters: one readable `host.activity` (`{ references, calls, jobs, lingering }`; owner).
- **Q1, unknown ids (owner, 2026-10-19; review round 3):** unknown hold and call ids are ignored on both sides (races
  such as `result` crossing `cancel` or `call` crossing `gone`); a consumer receiving `gone(h)` rejects its own pending
  calls on `h`. Only a header that fails the schema closes the link. Replaces "an unknown hold or call id closes the
  link" (R4).
- **Q2, size limits per part (owner, 2026-10-19):** limits per part from the header sizes, before decoding; an oversized
  part fails only its hold or call, other parts apply; an oversized snapshot fails its hold without automatic re-hold;
  the admitting link's decoded limit is stamped on relayed work and enforced where it is decoded; `maxPayload` is only
  the transport's hard cap (closes the connection). Replaces R2's per-message wording.
- **Q3, re-hold after overflow (owner, 2026-10-19):** (**superseded** by "Flow control: an ack-clocked window") re-hold once the previous snapshot's debt has drained (credits at
  the full window), with the minimum interval; replaces "once the credits cover the last snapshot's size" (R19),
  which stalls for snapshots larger than the window.
- **Q4, one message format and window (owner, 2026-10-19):** (**superseded in part** by "Wire protocol" (codecs, not the JSON header framing) and "Flow control: an ack-clocked window" (no byte window)) every link carries the same binary message
  (`u32 header length | header JSON | part bytes`, one `Uint8Array`): WebSocket as a binary frame, IPC through
  `serialization: "advanced"`, memory delivered asynchronously. Encoding, framing, checks, ids, flow control and limits
  are one shared protocol layer; adapters only move bytes; one byte window everywhere from `byteLength`. Replaces the
  IPC frame-count window and R1's per-adapter formats ("IPC: structured clone of { header, parts }; memory: the
  object"). Tests on memory links run the production path.
- **Q5, dependency cycles (owner, 2026-10-19):** rejected before activation waits: on one host by following the
  waiting edges of activating objects; across hosts through the activation chain of uuidv7 instance ids carried in the
  header of holds made during an activation (bounded; ignored from untrusted links). A cycle fails the activation
  `broken` naming it; no references are kept; checked again after reloads.
- **Q6, Chord from Durable tools (owner, 2026-10-19):** (**superseded in part** by "Context last": `chord(fn, context)`) p3's core puts the host into the harness's base context under
  a typed key; `chord(context, fn)` opens a call scope (host principal, the call's abort and span, references released
  when `fn` settles) in tools, hooks and sections; no wrapping, no p3 `defineTool`. Needs good docs: the pattern,
  lifetime and principal, and the Questions service as the example (tools reach users only through owner state;
  clients are not addressable). Replaces "hooks open a call scope with `host.root`" (plugins never hold the host).
- **Q7, code mode on reload (owner, 2026-10-19):** R16 stands: the detached old sandbox is disposed when its scripts
  finish or after 30 s at most; a reload during a longer script aborts it and that turn fails. After a reload at most
  30 s of old code keeps running.
- **Q8, registry ownership and versions (owner, 2026-10-19):** one authoritative declaration per registry, from the
  defining facet (`compose`, version, `accepts`); other tokens only identify it; a reload replaces it atomically.
  `accepts` stays (third-party plugins are an explicit goal of p3), owned by the defining facet, pure, following the
  owner-adapter pattern of documents, object types and jobs; a contribution without a matching version or adapter is
  left out and reported, not a load error; contributions are not schema-checked. Every use site of a contribution
  catches throws and rejections, reports naming the contributor, and continues. Replaces "newer ones are refused at
  load".
- **Q9, job dedupe and retention (owner, 2026-10-19):** dedupe covers unsettled runs only; after `finish` commits,
  Chord drops the run's record and key (a persisted record in the same commit) and releases waiters; dedupe after
  completion is the owner's, through the result in its own document. Chord keeps nothing beyond a run's lifetime.
- **Q10, contract evolution (owner, 2026-10-19/20):** forward evolution in code, no build step: a base written in
  full with an explicit version (`remote()`/`local()`; `local` keeps its own kind with flat `members`, C1 rejected),
  `evolve(prev, e => …)` always continues the history with structured edits (`state`, `addState`, `removeState`,
  `args`, `result`, `method(name, args, result)`, `addMethod`, `removeMethod`); every version is materialized and
  fingerprinted at declaration. Input or variant-set changes start a new history (a new declaration with an explicit
  version; no older accepts). Mappings only with the provider, in the pure `checkAccepts(contract, accepts)` (no
  `serve` in this layer): required at type level and at runtime for every member of the old version that changed or
  was removed; removed state from the whole current variant state or `"refuse"`. Fingerprint: `hash64` over a
  schema-aware data-only normal form (`NORMAL_FORM_VERSION`; union and intersection order kept; `required`/`enum`
  sorted; TypeBox keyword whitelist; bytes as a `{ type: "bytes" }` data marker); history private, deep-copied and
  frozen (**superseded in part** by "L1 rewrite review": nothing is frozen). Schema helpers `str num int bool nul lit oneOf union obj arr map opt bytes unknown` + `type Static`.
  Implemented and reviewed (Fable, Astra: thumbs up) in `packages/chord/src/next/contracts/` (`7d2bb8ea8`).
- **Q11, absent singletons (owner, 2026-10-21):** a singleton always has a value: `handle.value` is the written value
  or `initial()`, never `undefined` (an exposed singleton is typed `T`); `undefined` only for absent keyed documents
  (`handle.get(key)`); singleton existence has no API. A deliberate difference from Durable's `snapshot()`.
- **Facets typed by the app's principal (owner, 2026-10-21):** base code exports `defineFacet` bound to its `P`
  (`bindFacet<P>()`, working name) next to the principal union; every facet imports it from there; `host.load`
  accepts only facets typed for the host's `P`. No runtime check.
- **`placement`, not `host` (owner, 2026-10-21):** (**superseded in part** by "Params instead of inputs") the contract field naming where an object lives is `placement`
  (a typed function of the input); `input` stays (the object's key among objects of its type, part of its identity).
- **Q-B2, in-memory documents across input changes (owner, 2026-10-21):** not carried over. An input change of a
  type ends its live objects on reload; their in-memory documents, flows and jobs are lost; documented ("in-memory
  documents survive a reload only while the object identity is unchanged; persist what must survive").
- **The store (owner, 2026-10-21; backends **superseded in part** by W14: no IndexedDB; direction accepted, details under review in `p3-reviews/store-proposal.md`):**
  P1 recorded: a session is self-contained (its store plus its directory); export from the session alone, import
  into another instance, sync to Radius and continue elsewhere; the server only mirrors (catalog) and keeps instance
  data. One transactional table store per session, layered backend (SQLite, memory, IndexedDB) / store (tables, a
  small query DSL, controlled writes, commit queue, seq, outbox, export/replay) / adapters: Durable's `Storage` as a
  new `StoreStorage` adapter (Durable's existing storages stay unchanged), Chord's persisted documents, and plugin
  tables (`self.table`), each table owned by one object like a document. Writes are only `put`/`delete`
  (`deleteWhere` resolved to keys), recorded as row operations `{ table, key, v, row }` in the same backend
  transaction as the rows, so a replica or an import needs no plugin code; indexes are local (**superseded** by "Index
  definitions are recorded"); migrations run only
  where the owning code runs and ship as ordinary puts. Lines stay per Chord object and per Durable Session; the
  store has one short commit queue per store that assigns the seq; Durable's seq is the store's seq (Durable sees
  gaps; it only compares seqs). Rejected on the way: derived-only plugin data, opaque plugin directories, export
  hooks, plugin record logs, per-store outboxes with a global position counter, a SQLite-changeset or SQL-statement
  store, raw SQL reads, an IndexedDB-only API, Chord documents inside Durable's `Storage`. Open: physical layout
  (generic rows or real tables), DSL scope, migration timing, `next_id`, backend details, the ordering review
  ("seq 40 after seq 50").
- **S1, adoption inside the commit step (owner, 2026-10-21; store review):** every owner's in-memory adoption runs
  synchronously inside the store's commit step, after the backend commit and before the next commit starts, so memory
  always shows a complete prefix of the log. Durable's `Storage.commit(writes, adopt, context)` gains a required `adopt`
  callback (pi breaking change): every storage calls it synchronously once the commit is durable and before its next
  commit; the Session catches its own adoption error and fails; a rejection after adoption fails the Session without
  `tx.discard()`; `writeAtClose` passes a no-op; `StoreStorage` forwards `adopt` into the store's step; Chord objects
  adopt (pointer swap) the same way. Listeners stay where they are: after adoption, in each owner's continuation
  (unchanged), so their order across owners may differ from the seq order while every listener reads a complete
  prefix. Checked against Durable's code (memory, JSONL, SQLite, GuardedStorage, writeAtClose); the pi change and its
  test run come with the store work.
- **S2, references to later commits (owner, 2026-10-21; store review):** no mechanism and no new rule. Ids are minted
  inside the transaction that creates them (Durable `tx.appendEntry` → `mintId`) and reach other code only after that
  commit, so a reference to a later commit only arises when code leaks data out of an uncommitted transaction, which
  is already wrong today (the transaction may still fail). The guide states it once: ids and data leave a transaction
  only after it commits; reference what is committed.
- **S3, commit completion (owner, 2026-10-21; store review; IndexedDB parts **superseded** by W14):** the commit step finishes only on the backend's terminal
  success (SQLite: `COMMIT` returned; IndexedDB: the transaction's `complete` event); only then adoption (S1) and the
  next commit run. The memory backend stages a commit and swaps it in at the end. An ambiguous outcome (an error during
  `COMMIT`) stops the store (`storage_failed`, D10), as Durable's `GuardedStorage` does. After a restart a local head
  below the uploaded head is normal: the driver pulls its own uploaded batches back before writing. SQLite keeps
  `synchronous=NORMAL` (no extra cost: a crash loses nothing, a power loss the last commits, recovered from Radius);
  IndexedDB uses `durability: "strict"` where supported. Condition (owner): SQLite must not get slower.
- **S4, consistent reads (owner, 2026-10-21; store review):** an export pauses commits (holds the commit queue) while
  it reads, so the archive is the state at one head; streaming from a snapshot comes only if exports get large. Reads
  that need several queries (a document from its base and revisions) run in one backend read transaction, as
  Durable's SQLite storage does. Ordinary reads in object code (separate awaits) are not snapshot reads; the guide
  says so; no global snapshot guarantee.
- **S5, replica apply (owner, 2026-10-21; store review; a sync-layer rule):** a replica applies a whole batch in one
  backend transaction together with its applied head. Uploads may run in parallel (owner); the driver resubmits a
  batch until Radius acknowledges it and trims a batch from its outbox only after its acknowledgement. Every batch
  carries `from` and `to`; a replica applies a batch only when its `from` equals the replica's applied head, so it
  never applies past a gap: a later batch waits until the missing one has arrived.
- **S6, compaction (owner, 2026-10-21; store review):** (**superseded** by W9: no compaction at first) covered by S5: a compacted batch is applied as a whole, so
  its intermediate states are never visible; takeover happens at batch boundaries. Nothing to add.
- **S7, losing the driver role (owner, 2026-10-21; store review):** no rollback (tools ran, files changed, natives and
  derived data followed the tail). When an upload is refused for an old epoch, the local copy becomes a separate
  session with a new id and keeps running; commits in flight land in it; the old id's sync stops there; the new session
  may sync on its own from a full snapshot; the two never sync again. The catalog shows both (the split-off copy marked
  with its origin and seq). No `not_driver` error. To work out with sync: changing the id (store metadata, session
  directory, catalog), links from other sessions keep the original id.
- **S9, S12, S14, S17 (owner, 2026-10-21; store review):** S9: the store persists its head with every commit; the
  prototype's `Sequencer` and safe cut go away (prototype bug, nothing to decide). S12: the query DSL starts without
  `join`, `groupBy` and `select`; plugins aggregate in JS over indexed scans; added when a real case needs them. S14:
  tables and documents of an object are written in one transaction API, `self.tx(fn, ctx)` (no separate
  `table.transaction`). S17: bulk operations are designed now, together with migrations, after the remaining S items
  (full-row puts make a 10k-row rewrite about 40 MB in the outbox; revision pruning is one record per row).
- **S8, work that finishes out of order (owner, 2026-10-21; store review):** an app concern, no store or job mechanism.
  §14 states that the handler calls of one routine never overlap; the guide shows two patterns: chain through the
  routine (await the run's outcome, skip values that are no longer current) or drop stale results in `finish` by
  comparing the source position inside the destination's transaction.
- **S10, ids (owner, 2026-10-21; store review):** no persisted reservations. Durable's `mintId` contract is narrowed to
  "greater than every id minted since this storage was opened, and every id stored, also across reopen" (an id from a
  transaction that never committed was never seen outside it, S2; Durable's transactions are serialized on the
  Session line). In the store each owner's id counter starts at open above that owner's highest stored id (one index
  lookup per table; a replica taking over gets it the same way). Durable's existing storages already behave so; the
  comment changes in the same pi change as S1.
- **S11, copying documents into a fork (owner, 2026-10-21; store review):** `StoreStorage` reconstructs the source
  documents of a `document.copy` before entering the commit step (reads of committed history outside the step) and
  enters it with plain creates carrying the base; Durable is unchanged. Safe because the source is a past state and
  only Durable's Session line writes Durable's tables. The outbox only ever carries the resulting rows. Forks of forks
  and selecting an entry in the parent work as today (rewindable documents keep their history).
- **S13, one documents engine (owner, 2026-10-21; store review):** the store contains one documents engine used by
  Durable's `StoreStorage` and directly by Chord (Chord keeps no Durable dependency). Address `(namespace, owner, kind,
  key?)` with an opaque `owner` string chosen by the adapter (Durable: `session`, `conversation:7`, `task:31`; Chord:
  host/object type); records per incarnation with `history: "latest" | "full"`, `createdAt`, `retiredAt`, opaque
  `meta`; revisions (base with version and optional fingerprint, deltas). Reads outside the step: `find(address, at,
  context)`, `load(id, at, context)` (reconstructs base plus deltas once; no cache), `list(query, limit, cursor,
  context)` ordered by id or key. Writes inside the step: `create(record, base)`, `change(id, content)`, `retire(id)`,
  with the engine's checks (one live per address, create before change, delta on a base of the same version, nothing
  after retire); `latest` prunes revisions on a new base and on retire. Callers decide base or delta
  (`checkpointWhen`) and keep their in-memory trackers as today (Durable's Session caches, pins and evicts unchanged).
  Fork copies stay in `StoreStorage` (S11). Chord's frozen storage layer and its conformance suite are not ported.
- **S15, Durable's existing storages (owner, 2026-10-21; store review):** kept, as decided; no plan to remove them.
  Revisit whenever it becomes worth it.
- **S16, layout and text order (owner, 2026-10-21; store review, Astra's design; **superseded in part** by W8 (every text
  column), W14 (no IndexedDB) and "Text is plain UTF-8, in code point order" (the whole text order and encoding)):** real tables per logical table
  (definitions and changes recorded in the outbox, the store renders DDL); keys and indexed columns of type text or
  integer, the rest of a row in a JSON column (**superseded in part** by "Flat columns"). Text order is JavaScript's (UTF-16 code units) on every backend: memory
  and IndexedDB use plain strings natively; SQLite stores key and indexed text columns as `BLOB`s of UTF-16 code
  units, high byte first (`Buffer.from(s, "utf16le").swap16()`), so its bytewise comparison equals JS order; text that
  is not indexed stays `TEXT`. Lossless (lone surrogates, NUL round-trip), no comparator, no normalization ("é" and
  "e\u0301" are two keys). The SQLite backend encodes writes and query bounds and decodes results; outbox records,
  exports and cursors keep logical strings. Prefix ranges come from one store helper (increment the last code unit
  below `FFFF`). Every index ends with the primary key; cursors are opaque `{ dir, last }` with logical values and are
  refused by a scan in the other direction; a row whose indexed field is missing or null is not in that index. Plugin
  rule: text compares exactly like JavaScript strings; page with the store's cursors. Verified on Node 24.4: lossless
  round trip, SQLite BLOB order equals JS sort, ~0.4 µs per encode plus decode. Cost: indexed text shows as hex in
  `sqlite3` and takes two bytes per code unit. Rejected: generic JSON rows, store-maintained index entries, code point
  order with `toWellFormed()` (Fable), WTF-8, text equality-only.
- **S17, bulk operations and migrations (owner, 2026-10-21; `p3-reviews/store-bulk-migrations.md`; JSON-part wording
  **superseded in part** by "Flat columns"):** writes are `put`
  (a whole row), `update(table, key, set)` (some columns of one row), `delete`, `updateWhere` and `deleteWhere` (many
  rows, one record). Bulk operations are recorded as operations with the driver's affected-row `count`; every replica
  runs the same operation (one SQL statement, or a loop in the memory backend) without plugin code; a different count
  stops applying that store and restores it from a snapshot. `set` expressions touch real columns only: `value`,
  `col`, `add`, `sub`, `max`, `min`, `concat`, `replacePrefix`, `coalesce`, `when`; no JSON-field operands (added
  when a real case needs them); no subqueries, joins, aggregates or insert-from-query (read first, then `inArray` or
  puts); no case folding, `substr` on unindexed text or floats; one conformance suite for both backends. Migrations:
  shape changes of the JSON part migrate on access (each row stores its version `v`; `migrate(row, from)` on read; the
  next write stores the new shape; old code refuses newer rows); changes to key or indexed columns run eagerly when
  the owning object starts on the driver, before it goes live: recorded table changes (`alter` add/rename/drop, a
  rebuild for key or type changes), then either an `update` step (one `updateWhere`) or a `rows` step (scan in key
  order, `tx.update` per row, chunks of N rows per commit; table version `migrating` → `ready`; a crash resumes the
  scan). Indexes are local and created after `ready` (**superseded in part** by "Index definitions are recorded": the
  index changes after `ready` are recorded).
- **Blobs and derived data (owner, 2026-10-21):** blobs (artifact versions, uploads, sent files) are app layer: files in
  the session directory named by the hash of their content, never changed, written (tmp, fsync, rename) before the row
  or document that names them; any process may write one. Export copies `blobs/` with the store snapshot; import
  copies them back and checks each hash. Sync: before uploading a batch, the sync layer uploads every blob file present
  at that moment that has not been uploaded yet (no reference tracking; a replica never sees a hash without its file).
  No blob is deleted before its session is deleted (an unreferenced blob only costs disk). Derived data (full-text
  indexes, caches, a plugin's search database) is never exported or synced and is rebuilt where needed, typically by a
  catch-up routine comparing it with the store.
- **Index definitions are recorded (owner, 2026-10-21):** index contents are never recorded (every backend maintains
  them from the rows), but their definitions are: when the owning object starts on the driver, the store compares the
  declared indexes with the existing ones and creates or drops the difference, recorded as `{ op: "index", table, name,
  columns }` and `{ op: "dropIndex", table, name }` (after a migration's `ready`); every replica applies them. Every
  copy of a store, an export and the file seen by outside tools is then identical and self-describing. Indexes never
  affect results (queries order by index columns plus the primary key; rows without the field are excluded by rule).
  Cost: replicas without the plugin maintain indexes they never use; adding an index builds it during apply.
- **P3, where persisted data lives (owner, 2026-10-21):** persisted documents and tables only in input-less `local`
  objects (one per host and type); their address is (host, object type, name, key), with no input, so an input change
  can never orphan persisted data. Per-entity data (per conversation, per session) is keyed documents or table rows in
  such a store with an app-chosen key (data, not identity); objects with an input keep only in-memory state and read
  persisted data from the input-less store by key. Not adopted (proposals of 2026-10-21): `previous`/`rehome`, the
  split question, identity hashes as storage addresses. A persisted store's type and definition names stay stable;
  renaming one, or changing how keys are formed, is an explicit one-off migration in the store. p2 fits: its four
  stores with an input persist no Chord state. Enforced at the type level (`self.state(…, persist)` and `self.table`
  only in input-less local factories) and as a declaration error at runtime.
- **Flat columns (owner, 2026-10-21):** `defineTable` takes `columns`, a flat record: each column is a scalar (`str`,
  `int`, `bool`, `num`) or `json(...)`; no nested `obj`/`arr` outside `json(...)` (refused by the types and at
  declaration). Every column is a real SQLite column; scalars can be filtered and ordered; keys and indexed columns are
  `str` or `int` (S16); a `json(...)` column is one JSON `TEXT` column, opaque to queries, typed when read. Supersedes in
  part S16 ("the rest of a row in a JSON column") and S17 ("shape changes of the JSON part"): adding, renaming or
  dropping a column is a recorded `alter`; shape changes inside `json(...)` columns migrate on access.
- **P2, in-memory documents are instance state (owner, 2026-10-21):** an in-memory document is attached to the live
  object: no storage, no address, no seq, never in the outbox. Same machinery as persisted documents (drafts, `self.tx`,
  atomic commits, ops for subscribers and the wire); its commit is prepare and adopt. A transaction mixing both kinds
  adopts the in-memory part inside the store's commit step (S1). It lives from activation to the end of the object:
  survives plugin reloads (pure objects swapped in place) and native restarts of the live object, ends with the object
  (last reference, linger, an input change on reload, Q-B2). Deletes the memory `DocumentStorage` for in-memory
  documents and identity hashes as their keys.
- **Query runner (owner, 2026-10-21):** a query is immutable data built with `query(Table).where(…).orderBy(…)`;
  `limit` is an argument, not part of the query; the same `where` serves `updateWhere`/`deleteWhere`. The table handle
  from `self.table(Def)` runs it: `page(q, limit, ctx, { after })` returns `{ rows, next? }` (an opaque cursor with
  direction and last key as logical values, bound to the query's order, refused with another query), `rows(q, ctx)`
  iterates all pages, `get(key, ctx)`, `count(q, ctx)`. Outside a transaction it reads committed state, one query at a
  time (S4). Reads inside `self.tx` (owner, 2026-10-21): `tx.page(table, q, limit, { after })` and `tx.rows(table, q)`
  return committed rows, stable for the whole transaction (only the owning object writes its tables, P3, and its
  transactions run one at a time on its line), without the transaction's own writes; `tx.get(table, key)` overlays
  the transaction's own pending writes (put, update, delete) on the committed row (**superseded in part** by W10: after
  a bulk operation on the table, `tx.get` throws `read_after_bulk`).
  Documented rule: queries inside a transaction see the state before it; own writes become visible after the commit.
- **P4, plugins' own databases and files (owner, 2026-10-21):** state written by code lives in a store: the session's
  store for session data, the server's store for instance data (p2's `catalog.sqlite` becomes a rebuildable mirror table,
  `shares.sqlite` server tables, `subagents.sqlite` part of the session's metadata, the code-written JSON files such as
  `models-store.json`, `forwards.json`, `owner-revoked.json`, `radius.json`, `device.json`, `prefs.json`, `envs.json`,
  `voice.json` server documents or tables); a plugin's own SQLite file holds only derived data (`search.sqlite`); blobs
  are files named by hash; files a person edits by hand (`settings.json`, `models.json`, `auth.json`) stay files
  (open point #21). Logs are not data.
- **Params instead of inputs (owner, 2026-10-21):** an object type's `input` is renamed `params`: the fields that select
  an instance among objects of its type (like route params), part of its identity. Params are a flat record of
  required fields, each `str()`, `int()`, `bool()` or a union of string literals (`oneOf("chat", "agent")`); no
  defaults, no optional, nested or unknown fields (a `get` with a missing or extra field fails `invalid/params`); the
  identity key is the field values in declared order (no canonical JSON walk, no normalization). p2's 78 object types
  fit (52 empty, the rest one or two required scalars). Supersedes in part R7 ("inputs stay arbitrary", "inputs are
  always normalized") and the placement entry ("`input` stays"); Q12 (stripping) now concerns method arguments only.
  "Input-less" in P3 and Q-A reads "with empty params".
- **Q-A, lifetime from kind and params (owner, 2026-10-21; both reviewers up):** no `lifetime` option and no lazy flag.
  A `local` type with empty params lives as long as the host (started eagerly at host start, never ended by reference
  count; it may hold persisted data, P3, and contribute, R21); every other `local` type and every `remote` type lives
  while referenced (`linger` only for those). No remote object has host lifetime (its identity includes the
  principal; long-lived parts go into a local shared store). A lazy flag was rejected for now: a lazy store would
  contribute and run routines only after first access and escape the start barrier; p2's 11 such stores open only
  cheap natives. Every "`lifetime: \"host\"` object" in earlier entries reads "`local` object with empty params".
- **The harness is an ordinary object (owner, 2026-10-21; Astra's C17):** no harness exception in the start barrier.
  The harness is a host-lifetime object (`local`, empty params) that opens Durable during the barrier with scheduling
  paused (Durable opens paused until `resume()`); base code calls `harness.resume()` after `await host.load(...)` and
  before the worker connects to its parent (**superseded in part** by W6: connect first), so no request arrives earlier and every registry is filled. Chord knows
  nothing about Durable's start.
- **Q12, closed argument schemas (owner, 2026-10-21; review round 3):** every object schema in a contract is closed
  (`obj()` sets `additionalProperties: false`); an unknown argument field fails the call with `invalid/args` instead of
  being stripped; the provider validates the caller's object in place, never copies or mutates it; arguments have no
  defaults (optional fields are `opt()`, handlers write `args.limit ?? 50`). Supersedes in part R7 ("arguments are
  always stripped") and the earlier "undeclared argument fields are stripped" (step 2); `checkArgs` is one compiled
  validation.
- **Q15, `local` arguments are validated (owner, 2026-10-21; review round 3):** one rule for every method call: the
  provider validates arguments against its closed schema (Q12) for `local` types too (callers are often other plugins,
  bundled without type checks; `local` stores hold persisted data, P3). Never copied. Supersedes the `local` column
  "neither validated nor copied" (design §5) and the `local` part of "Object kinds".
- **Q13, origin incarnation on relayed calls (owner, 2026-10-21; review round 3):** relays stamp the origin host's
  incarnation into the `call`/`hold` header, taken from the link the call came in on and overwriting any value a client
  sent (like the principal), so `ctx.incarnation` always names the host where the call started. One header field.
  Refines R20.
- **Q14, exposable state (owner, 2026-10-21; review round 3):** a state member of a contract may be backed only by a
  JSON readable: a document handle (persisted or in memory), a derive, `constant(...)` or a state readable
  (`replicatedState`, e.g. Durable's views). `self.writable` (host-local, any in-process value, for registry
  contributions) is refused as a state member: by type, and when the object is served (a kind tag check, no value
  walk; the object fails `broken` naming the member). Values are still not validated (R9).
- **`reset` instead of release and re-hold (owner, 2026-10-21):** (**superseded in part** by "Flow control: an ack-clocked window": consumers never fall behind a window; only a relay sends `reset { hold }` upstream, for a downstream that fell behind; no debt or minimum interval) when a hold falls behind (the link's window
  overflows), the consumer or relay sends `reset(hold)` on the existing hold, never a release: the reference count is
  unchanged, so a slow connection can never end an object. The provider answers with `bound` (a fresh snapshot) and
  restarts that hold's encoder; the consumer drops everything for the hold that arrived before the new `bound`
  (per-direction order). Q3's rules stay (one snapshot in flight per hold, after the previous debt drained, minimum
  interval). A link drop remains a departure. Supersedes "releases the hold and re-holds" (R19, design §3).
- **Routines get the changes since their last run (owner, 2026-10-21):** (**superseded** by "Watchable and one watch API": per-commit frames) `self.routines.on(readable, (value, changes,
  ctx) => …)` runs one call at a time with the latest value; `changes` is `{ kind: "ops", ops }` (every op since the
  previous run, in order, the commits' op arrays kept by reference, never re-diffed) or `{ kind: "reset" }` (the first
  run, or more than N ops piled up). Same rule as Durable's watch overflow and the link's `reset`, applied per run;
  routines that only want the value ignore `changes`.
- **Watchable and one watch API (owner, 2026-10-21; **superseded in part** by W1 (flush after the step), W2b (routines
  start with the current value), W4 (two kinds) and "One pending queue for slow consumers of state" (the 100-frame
  overflow)):** v2 has no `replicatedState`. Everything observable is a
  `Watchable<T>` = `{ value; watch(ctx): Promise<WatchHandle<T>> }` with `T` limited to JSON plus bytes at the type
  level: document handles (singletons; keyed per key), derives, reference members, `constant(v)`, and Durable's
  conversation view, task graph and documents. Durable's `WatchHandle` and `WatchEnd` move into Chord as the one
  observation API and Durable imports them: `watch()` atomically takes the current value and buffers later commits;
  `start(listener)` installs the one listener; each commit is delivered as `(value, ops, ctx)`, in order, async
  listeners awaited; after 100 pending frames the backlog becomes one root replacement `[["r", newest]]`; a retired
  document ends with `[["r", null]]`; `stop()` is idempotent, drops pending frames, never aborts or awaits a running
  call, and returns the end; `closed` resolves to the same. `WatchEnd` reasons are generic: `stopped`, `cancelled`,
  `retired`, `ended` (source closed: object ended, reference released, Session closed), `listener_error { error }`,
  `failed { error }` (source failed); Durable adopts them (was `session_closed`, `session_failed`). `routines.on` is a
  watch owned by the object (per-commit frames; Chord awaits a running call on reload), replacing "Routines get the
  changes since their last run". Durable's state getters (`documentState`, `viewState`, `taskGraph()`) are removed
  (unused by p2). Derives and the wire encoder use an internal synchronous hook inside the commit step so a derive's
  change travels in the same wire batch as its source (no torn state); this needs exhaustive tests. Memory: each watch
  holds at most 100 frames by reference; every watch ends (object end, reload, ctx, source end); GC tests count
  retained revisions.
- **W4, two watchable kinds (owner, 2026-10-21; both reviewers agree; review round 4; JSON-plus-bytes **superseded in part** by "L2 spec decisions": watchables are JSON only):** Delta's `Op` is typed over
  JSON, so natives never ride in ops. `Watchable<T extends Json>` (JSON plus bytes): `value` + `watch(ctx)` →
  `WatchHandle<T>`, listener `(value, ops, ctx)`, overflow → one `[["r", newest]]` frame; documents, derives, reference
  members, `constant`, Durable's views; the only kind that can be a contract state member or go on the wire.
  `NativeWatchable<T>` (any in-process value): `value` + `watch(ctx)` → `NativeWatchHandle<T>`, listener `(value,
  ctx)`, a change is a new value by identity (`!==`; mutating an existing native value notifies nobody), overflow
  collapses to the newest value, never ops; `self.writable(initial)` (with `set`) and composed registry values. Both
  share one lifecycle implementation (`watch`, `start`, `stop`, `closed`, `WatchEnd`) and carry explicit runtime kind
  tags; a `NativeWatchable` is rejected as contract state even when its current value happens to be JSON. Derives may
  read either kind (mixed sources) and always return JSON plus bytes: a native change marks the derive dirty without
  ops; the derive recomputes and its result is diffed as usual. Native changes use the same synchronous dirty-marking
  hook (W1) with the same reentrancy flag; `writable.set` never goes through the commit queue and has no seq;
  registries recompose in the owner's flush, never inside another owner's commit step. Supersedes the JSON limit in
  "Watchable and one watch API" and the earlier `Writable` interface.
- **W1, adopt and mark in the step, one synchronous flush after it (owner, 2026-10-21; review round 4):** the commit
  step writes, adopts (pointer swap of every changed value: the owner's documents; Durable's views and documents
  touched by the commit, dispatched by conversation/document id) and marks (dependent derives dirty; ops appended by
  reference to each touched hold's batch and each watch's queue), O(1) per dependent. Right after the step, before any
  other code runs and without any await, the owner's flush recomputes the dirty derives that someone holds or watches,
  in dependency order (derives are synchronous pure functions), encodes one part per touched hold (a hold covers all
  members of the held object's variant) into one state message per link, and queues watch callbacks. A derive that
  throws fails only its member (`broken`); the commit and its sources' parts still go out. A dirty derive nobody
  flushes recomputes lazily on its next read. During adopt and flush, `self.tx`, `watch` and `release` throw
  `reentrant`; a derive cycle throws once. The same adopt/mark/flush boundary runs without a store seq for in-memory
  commits (P2), `writable.set`, registry changes and inbound wire batches. Durable calls the adopt synchronously
  inside its commit step (no microtask). Async work belongs in routines writing in-memory documents. Supersedes
  "derives and the wire encoder run inside the commit step" ("Watchable and one watch API"). Exhaustive tests: a
  throwing derive, a chain A→B→C where B throws, two owners alternating with a derive over both, reentrancy, a watch
  started after 150 frames, stop during a running call, a retire with a derive over it, a reload during a routine call,
  GC counts of retained revisions.
- **W2, W3, watch fixes (owner, 2026-10-21; review round 4):** W2a: retirement is an explicit source event (last frame
  `[["r", null]]`, then the end `retired`), never inferred from `value === null`; in Chord and in Durable alike (a pi
  change; Durable's `CommittedWatch` stops treating `null` as retirement). W2b: only `routines.on` delivers the
  acquisition value: it calls its handler once with `watch.value` (ops `[["r", value]]`), then starts the watch and
  drains the buffered commits; a direct `watch()`/`start()` user keeps Durable's pattern (use `watch.value` first, then
  `start`), unchanged. W3: termination clears every reference a watch holds (listener, detach/report/replace closures,
  cancellation hooks); a running call keeps only what it needs; GC tests cover stopped but still referenced handles.
- **W6, worker start order (owner, 2026-10-21; review round 4):** connect to the parent first, then `load`, then
  `harness.resume()`. A link carries nothing until a hold or call; a host-lifetime store that references a server type
  in its factory no longer waits 60 s for a missing link; requests arriving during `load` park like any call to a
  loading object; no turn starts before every plugin loaded.
- **W7, store addresses carry no host instance (owner, 2026-10-21; review round 4):** automatic: Chord builds the owner
  string of persisted documents and tables from the host kind and object type (`session/notes.store`), never from a host
  address (no session id), so a split (S7) or an import under a new id keeps every document reachable; each session has
  its own store, so the session is the store, not part of each address. Durable's owner strings (`session`,
  `conversation:7`, `task:31`) already qualify. Plugin code never writes addresses; the guide says keys need no session
  id.
- ~~**W8, every text column as UTF-16 BLOB (owner, 2026-10-21; review round 4):**~~ (**superseded** by "Text is plain
  UTF-8, in code point order") every `str()` column, indexed or not,
  is stored as a UTF-16 `BLOB` (high byte first), so text has one order everywhere (JavaScript's), adding an index never
  changes results, and lone surrogates and NUL survive; `json(...)` columns stay JSON `TEXT`. The SQL generator casts
  `concat`/`replacePrefix` results back to `BLOB` and uses only even byte offsets (whole code units); conformance tests
  cover emoji prefixes, NUL and lone surrogates. Cost: twice the bytes for ASCII text, hex in `sqlite3`, ~0.4 µs per
  encode. Supersedes S16's "only key and indexed text". Revisit note (owner): Armin is not happy with the UTF-16
  encoding; no better option is known yet.
- **W9, no compaction at first (owner, 2026-10-21; review round 4):** batches carry the ordered operations exactly as
  committed; a replica applies them in order, as a whole, in one transaction (S5). "Keep the last write per row" is
  dropped (it loses rows with `update` and bulk operations). A later compaction must merge `update`s into the preceding
  `put` and treat bulk operations as barriers. Supersedes S6's compaction note and the book's compaction text.
- **W10, no reads after a bulk operation (owner, 2026-10-21; review round 4):** once a transaction has an
  `updateWhere` or `deleteWhere` on a table, `tx.get` on that table throws `read_after_bulk` (no JS evaluator of `where`
  and `set` on any backend); other tables and reads before the bulk operation are unaffected. Like Durable's
  `ReadAfterWrite` (spec §4: no table read after the first table write), but narrower. The overlay for `put`,
  `update` and `delete` stays (owner): helpers doing read-modify-write compose within one transaction. Durable keeps its
  stricter rule (point reads could get the same overlay, scans could not; not needed today).
- **W11, two version levels for migrations (owner, 2026-10-21; review round 4):** each `json(...)` column has its own
  version and a value-only migration (`json(Schema, { version, migrate: (old, from) => new })`), stored with its value;
  it migrates on access, and a write of that column stores the new shape and its version (writes of other columns never
  touch it). The row's `v` means only "eager steps applied up to v": only an eager step and a full-row `put` set it;
  `update`, `updateWhere` and `deleteWhere` never do. An eager `rows` step applies its row function to rows with
  `v < target` in key order with a cursor, writes the changed columns plus `v`, one commit per chunk; after a crash it
  scans from the first key again, skipping rows with `v >= target` (one pass, no temporary index, no progress record).
  No ordinary writes happen between chunks (the owner is not live until `ready`); old code refuses a newer row `v` or a
  newer JSON column version independently; replicas apply the shipped writes and alters without code; a new index is
  created after `ready`. Key changes are a recorded `rebuild`. Supersedes in part S17 ("each row stores its version `v`;
  `migrate(row, from)` on read") and "Flat columns" (shape changes inside `json(...)`).
- **W12, W13 (owner, 2026-10-21; review round 4):** an in-memory commit (P2) takes the owner's next publication
  number, never a store seq, never enters the commit queue, and runs adopt/mark/flush (W1) when it happens. Durable's id
  counter at open is the maximum over all five of its tables (S10). One message per link per commit comes from the W1
  flush, also when one Durable commit touches several holds on a link. `count(q)` stays in the query runner although
  S12 starts without aggregates.
- **W14, cuts (owner, 2026-10-21; review round 4):** (a) no IndexedDB backend: the browser runs SQLite in WebAssembly
  (official build 3.54.1: `sqlite3.wasm` 879 KB, ~406 KB gzipped), persisting into IndexedDB (a storage adapter such as
  wa-sqlite's) or the browser's private file system; serverless targets use SQLite where it exists (Durable Objects,
  Turso, D1) and a Postgres backend (a second SQL generator for the query language) when a real target needs it; a
  backend needs atomic transactions, ordered indexes, bytewise binary keys and one writer per session. FoundationDB was
  considered (Armin): the right model (ordered key-value with transactions) but the wrong shape (an operated cluster,
  no embedding, 5 s / 10 MB transaction limits, no self-contained session files); at most a later backend for a hosted
  multi-tenant service. (b) The `replicatedState` family (`replicatedState()`, `ReplicatedStateSource`,
  `AttachedReplicatedState`, the microtask scheduling in Durable's source attachment) is removed as public API in Chord
  and Durable. (c) `stopped` and `cancelled` stay two end reasons. (d) Derive `previous` is removed (`mapShared` and
  lazy recompute cover it). (e) The per-row `rows` migration step is the explicit exception (done by W11).
- **No document tags (owner, 2026-10-21; Fable's consistency check, Astra earlier):** `defineTag`, the `tags` option of
  `tx.draft` and `retireByTag` are removed. They existed only to delete a session's data; with one store per session,
  deleting the session deletes its store and directory, and the documents engine (S13) has no tag index. Instance data
  on the server that refers to a session is a table with a `session` column, cleaned up by its owner (`deleteWhere`,
  reconciling from the catalog, "invariants across owners").
- **Principals stay unversioned (owner, 2026-10-22; L1 part 4):** the app's `P` is a plain base-code type with no
  schema or version: Chord never persists principals, base code changes every host at once, links stamp principals.
  Objects persist a projection with its own schema, never the principal itself (p2: chat's `Author { kind, id, name }`
  from `authorOf(principal, ownerName)`, stored in every input entry); the guide states the rule.
- **Direct mappings stay; params checked by TypeBox (owner, 2026-10-22; L1 build):** `accepts` maps each accepted old
  version directly to the current one (no chains in Chord; one argument mapping per call and one state projection per
  commit per old version); when a new version arrives, the author updates every still-accepted version's mappings, and
  the guide shows composing step functions (`(old) => v2to3(v1to2(old))`). Params are checked with a compiled TypeBox
  schema (a closed object), so constraints such as `str({ pattern })` or `int({ minimum: 0 })` are allowed and
  enforced; the type level and the declaration check allow only scalar helpers (`str`, `int`, `bool`, `oneOf`) without
  nesting. Refines L1 part 2 ("field by field, no TypeBox").
- **`bindProvider` (owner, 2026-10-22; L1 build):** `serve` (L4) calls `bindProvider(Type, accepts)` once per load and
  reload: it runs `checkAccepts` once and keeps the validated mappings (frozen); per call `checkArgs(provider, method,
  raw, boundVersion)` checks with the bound version's schema and maps directly to the current version. Condition
  (owner): no leak. The binding is held only by the served type's registration and by calls in flight; no global
  strong cache keyed by contracts or bindings (compiled schemas only in `WeakMap`s keyed by schema objects); a GC test
  shows a binding, its mappings and compiled schemas are collected once dropped (reload) and the last call settled.
- **L1 review round 1 decisions (owner, 2026-10-22):** same-host arguments are not checked for plain data (no
  prototype, getter or `unknown()`-subtree checks): the documented convention is that callers pass plain data (JSON
  plus bytes), immutable by convention. Params are never copied or frozen: the object keeps the caller's params
  object, immutable by convention (no freezing anywhere). A method without arguments takes `null`: dispatch passes
  `null`, the README says so. Cuts (owner): the error reason type is a closed union of the decided reasons (later layers
  add theirs; plugin errors never use Chord reasons, shape decided in L4); `failure.ts` and its activation helpers stay;
  the `copyJson` wrapper goes; `Provider` keeps only its runtime brand; `revocationKeys` stays (**superseded** by "Simplification pass after 4a": cut until 4b).
- **L1 review round 2 decisions (owner, 2026-10-22):** error reasons are part of the link protocol: adding a reason
  bumps Chord's protocol version (hosts with different versions refuse each other, an old tab reloads), so a receiver
  keeps rejecting unknown reasons; a test pins the reason list with the protocol version. Failed checks take TypeBox's
  public error list (the internal first-error wrapper is removed). The provider's dispatch table is private (a
  provider-keyed `WeakMap`). Accepted versions' argument validators compile on first use. The closed-object argument
  check runs once per declared or edited method. Owner rule: no runtime checks of values TypeScript already guarantees
  (AGENTS.md); declaration checks of decided rules the types cannot express stay.
- **Cost counters (owner, 2026-10-22):** the function that does the work counts it through its context (validation,
  compilation, canonical JSON, a future counted `copyJson` with an optional context added in pi); call sites never
  count work done elsewhere. Counters stay plain totals without site labels: mainly a test guard (a test isolates one
  operation), plus a rough production number; attribution, if ever needed, comes from an event on the context's span.
  The error rebuild from the wire does not copy (fresh decoder output) and checks only the envelope.
- **Code style and L1 cuts (owner, 2026-10-22):** all Chord v2 code follows the section "Chord v2 Code Style" of the
  root AGENTS.md (one concept per file, top-down order, doc comments, no flag parameters, no typed-value checks, weak
  caches with GC tests), so every agent has it in context. Cuts: the params descriptor pre-check is removed (params and
  arguments follow one rule: the compiled closed schema; wire params are parsed JSON, same-host callers pass plain data
  by convention); `bindProvider` keeps the app's accepts table as is (immutable by convention), no copy or freeze.
- **L1 rewrite questions (owner, 2026-10-22):** `checkArgs` returns a tagged value, `{ kind: "method"; args; result? }`
  (args in the current shape, `result` maps back for an old-version caller) or `{ kind: "call"; args; call }` (the
  checked old args and the provider's replacement, invoked by L4); no second lookup function. Failed-check paths are
  TypeBox's instance path unchanged; keys containing `/` or `~` make it ambiguous (a diagnostic; not worth recovering).
  The JSON Schema `oneOf` keyword is rejected (the `oneOf()` helper emits `anyOf`); local accepts tables and
  `Implementation` are flat.
- **L1 rewrite review (owner, 2026-10-22):** nothing in L1 is frozen: contract handles, schema snapshots, params
  schemas and providers are Chord-owned data, immutable by convention like everything else; the snapshot copy stays
  (it keeps validation in sync with the fingerprint when an app changes its schema objects). Supersedes "frozen" in Q10
  ("history private, deep-copied and frozen") and the frozen metadata in the round-1 and round-2 entries. Size accepted
  (about 1,900 lines, 1,450 without blanks and comments; about 420 type-only). Failed checks say "unknown field" and
  "missing" for those two cases, TypeBox's message otherwise. A malformed error envelope from a peer throws a plain
  `Error`. `Principal` is a type alias (apps declare principals as type aliases, not interfaces).
- **One watch-handle implementation, upstream first (owner, 2026-10-22; L2 spec):** Durable's `CommittedWatch` moves
  into Chord's shared `src/watch.ts` (pi change, upstream first), generalized to serve native watchables too
  (`NativeWatchHandle`, listener `(value, context)`, overflow to the newest value); Durable uses it and its
  `observation.ts` goes away; Chord v2's L2 builds on it. Publications, derives, sinks, `constant` and `writable` stay in
  `next/` (v2 only). Durable's synchronous view-change hook (so a derive over a Durable view is marked in the commit
  step) is a later pi change, with L3d.
- **L2 spec decisions (owner, 2026-10-22):** watchable state is JSON only (no bytes in documents, derives, reference
  members or any watchable; bytes only in method arguments and results and chunked transfers; Delta stays JSON-only;
  supersedes W4's "JSON plus bytes" for watchables). `mapShared` lives in `next/watch/` until v2 goes upstream. C10 is
  rejected (`constant` and `writable` stay two kinds, Q14). One publication object per host, passed to its sources;
  no module-level singleton. No CBOR: the wire stays JSON plus raw byte segments (R1, Q4), revisited only if L6
  benchmarks show encoding as a bottleneck.
- **Contexts are required (owner, 2026-10-22):** as in Durable (356 required context parameters, none defaulted;
  optional only on error-reporting paths), every Chord v2 function that takes a context requires it: no
  `= BACKGROUND_CONTEXT` defaults, no `context?`. A getter that cannot take one (a lazy derive read) uses its owner's
  context (the publication's). Applied to L1 and L2; written into the AGENTS.md style section. L2 review: the
  publication resets its phase and queues in a `finally`, so a throwing sink cannot leave it stuck; L2's size (about
  680 lines) is accepted.
- **Carry-over ledger (owner, 2026-10-22):** obligations deferred to later layers are recorded in
  `packages/chord/docs/next/carry-over.md`, under the layer that must do them, by whoever defers them, in the same
  change; a layer's spec includes its section; done entries are deleted. The AGENTS.md style section states the rule.
- **Vertical slices instead of layers (owner, 2026-10-22):** building strictly bottom-up made L2 grow generic machinery
  for callers that did not exist yet (nodes, sinks, deliveries, "publications"), hard to follow; its code was deleted,
  not kept. From now on Chord v2 is built in vertical slices: each slice is the thinnest end-to-end path through
  every layer it needs (slice 1: one host, one local object with `self.state`, `self.tx`, `self.derive`, a checked
  method call and a watch), so every API has a real caller. Same process per slice: spec by this session, owner
  approval, an Opus 5.5 build, review, owner review, commit. L1 stays (stateless checks, committed with required
  contexts and an `index.ts`/`internal.ts` split, `ff4f4456d`). Kept from L2: Chord's shared watch handle
  (`src/watch.ts`) and the decisions (JSON-only state, one batch per host, no CBOR, C10 rejected). Plain names from
  the design's vocabulary or common usage (a signals library's `batch`), never invented internal jargon in APIs.
  Plan: `packages/chord/docs/next/slices.md`.
- **`Implementation` maps state members to watchables (owner, 2026-10-22; slice 1):** L1's `Implementation<C>` types a
  state member as `Watchable<Static<schema>>` (the document handle, derive or reference member the factory returns),
  not a getter `() => value`: a getter cannot tell Chord when a value changed (design §11).
- **Slice plan and slice-1 review decisions (owner, 2026-10-22):** slice order 1 local objects, 2 failures and
  natives, 3 two hosts, 4 topology, 5 routines and jobs, 6 persistence, 7 reload and rollout, 8 registries and the
  harness, 9 telemetry (routines and jobs before the store and reload). A feature map in `slices.md` assigns every
  design feature to a slice; implementers and reviewers check the slice spec, the map and the design (AGENTS.md).
  Slice process includes reviews by Astra and Fable. An object that ends rejects new calls, aborts its running calls'
  contexts and makes its `self.tx` throw `released` (a running method can change nothing after the end); no drain
  without natives (the drain, design §3, is decided with natives and C13 in slice 2). Keyed in-memory documents,
  `mapShared` and `defineFacet<P>` stay in slice 1 (base infrastructure), each with a real use in its example.
  `checkpointWhen` is required only for persisted documents (refines R14: in-memory documents are never written, so
  checkpointing cannot apply). `retryOn` waits for the first independently living source (registries, slice 8);
  slice 2 has `ref.retry()` and dependency recovery.
- **Slice 1 approved (owner, 2026-10-22):** cycle rejection on one host (Q5) is in slice 1; watches belong to the
  reference they came through and end when it is released; at `get` the consumer's contract version and fingerprint
  must equal the provider's (`contract_mismatch` otherwise); `then`, `release`, `state` and `retry` are reserved member
  names, refused at declaration; cut C14 rejected (the `handle.change`/`handle.retire` shorthands are built); cut C16 (**superseded**: accepted on 2026-10-26, "Facet documents are removed")
  rejected (facet documents are built: served objects may draft them in their own transaction).
- **Callers when an object ends (owner, 2026-10-22; slice-1 review):** as design §3 says, callers are rejected at
  once: when an object ends, every caller of a running call gets `released` immediately; the handler keeps running in
  the background under an aborted context and cannot commit (`self.tx` throws `released`). A call whose caller context
  is already aborted is rejected before its handler runs. Each call runs under `withAbortSignal(objectEndingSignal,
  callerContext)` (one controller per object; a caller's cancellation aborts only its own call). The frozen v2 kernel,
  its tests, the playground built on it and the kernel step docs were removed (`4a54fc38b`); `Watchable` went upstream
  into `src/watch.ts` (`a2fd25f56`). Facets are typed by exactly the host's principal type (invariant).
- **No derive names, no `null` for no-argument methods (owner, 2026-10-22; slice-1 review):** `self.derive(sources,
  compute)` takes no name: the name existed for `previous` (removed, W14); on reload exposed derives are matched by their
  member name, internal ones are rebuilt (slice 7 adds matching only if a real need appears). A method without
  arguments omits them in the API: references call `ref.bump(ctx)` and implementations are `bump: async (ctx) => …`;
  the shape is fixed per method by the contract; `null` remains the internal and wire form. Refines the L1 round-1
  decision "no-argument methods take `null`".
- **Slice 2 approved (owner, 2026-10-22):** natives with per-native readiness, ordered opens and reverse closes, close
  reasons and a close context aborting at `closeTimeout`; failure causes by where they failed; every attempt bounded
  by `readyTimeout`; backoff per identity (a map holding no object); only R18 failures keep references; gap-free
  dependency handover on retries; the start barrier waits for each host-lifetime object's first outcome; `host.get`:
  broken rejects at once, transient waits up to the getter's own deadline; the drain waits for handlers' own promises
  before natives close. Cuts: C5 rejected (no natives in facets); C6: `broken()` kept, `retryOn` in slice 8; C7:
  `linger` kept, built in slice 3; C13: two host timeouts (`closeTimeout`, `readyTimeout`), the drain uses
  `closeTimeout`. `ref.state`, `ref.retry()` and `host.hold` move to slice 3; the plugin error shape is decided in
  slice 3. Openers take a `Context` (not `({ signal })`).
- **Slice 3a approved (owner, 2026-10-22):** slice 3 is split into 3a (remote objects over one link) and 3b (surviving
  drops: re-holds, parking, `ref.state`, `host.hold`, `ref.retry()`, `linger`, `host.root`, `state: false`). Guiding
  rule for every choice: simple, fast, correct. A remote factory returns `{ variant, members }`; `ref.variant` is the
  discriminant (C15 accepted: no `inVariant`/`expectVariant`; `variant` reserved). Calls are checked against the
  binding's variant. A hold's state is one object with one Delta encoder; failed members travel in the header. A
  release rejects the calls made through that reference, locally and over links (refines slices 1-2). `$bytes` is the
  one reserved key in values crossing a link (byte leaves travel as raw segments referenced by `{"$bytes": i}`).
  Plugin errors: `PluginError(code, message, details?)`, `internal` for anything else, never a stack. Headers are
  checked on every link until IPC (slice 4). Hot-path slices add light benchmarks (timing, memory, wire size) recorded
  in `benchmarks.md`.
- **Wire protocol (owner, 2026-10-22; slice 3a review):** the protocol works on a typed `Message` (one TypeBox
  schema, `MESSAGE`, also checked after every decode); codecs are pluggable per link: `binaryCodec` (kind byte, varints,
  raw ids, JSON values; about 23 B for a streamed token instead of 98) and `textCodec` (Delta-style JSON tuples, no field
  names), compared by benchmarks for wire size, compute and memory. Member, method and variant names travel as indexes
  into the hold's bound version; a reload that drops that version ends its holds first (slice 7). Checks by layer: the
  codec's structural decode, the `MESSAGE` envelope, the bound version (ids, indexes, order), then the owners
  (`checkParams`, `checkArgs`, Delta's decoder). The memory link delivers with `queueMicrotask` (no Node APIs). A
  2,000-token reply drops from about 196 KiB to about 46 KiB. Supersedes R1/Q4's JSON header framing.
- **Slice 3b approved (owner, 2026-10-22):** references survive link drops (`loading`, values readable, calls queued
  with their own deadline and sent in order, sent calls fail), one owner of remote references across links re-holding
  on every `connect`, a re-hold may bind another variant; `ref.state` (`loading`/`live`/`failed`/`released`) is a
  `NativeWatchable` (interface added to `src/watch.ts` upstream first); `host.hold`; remote retries through two new
  messages `retry { hold }` and `loading { hold }`; parked calls wait at most `readyTimeout` (C13 keeps two host
  timeouts); `linger` for live objects; C8 (`state: false`) cut; `host.root` moves to slice 8.
- **Flow control: an ack-clocked window (owner, 2026-10-23):** supersedes Q4's byte window, R19/Q3 (snapshot admission
  and debt), C12's credit accounting and K16's call credits. Measured by Astra and Fable (Node 24, `ws` 8.22, separate
  processes, proxy at 64 KiB/s): a `bufferedAmount` cap plus latest-state coalescing still delivered state 9.4 s old
  (kernel and proxy buffers hide megabytes); application acks with 1-4 messages in flight plus coalescing delivered
  0.0 s old state, heap +0.4 MB, 98% fewer messages; no control buffered 7 MB (+18.5 MB heap; a client that stops
  reading: 23.4 MiB, RSS +121 MB in 15 s). IPC `send()` returns false from about 64 KB yet 623k sends cost +1,035 MB;
  its callback acknowledges the write, not the handler. Rules:
  - At most K=2 unacked `bound`/`state` messages per link; the consumer sends a small `ack` after applying each one.
  - Ops queued meanwhile are merged per hold; a snapshot replaces them only when the merged ops exceed the member's
    value size (2,000 appends: 46,024 B one by one, 26,021 B merged, 8,035 B as a snapshot; but a member with 500 KB
    of history would cost 508,035 B as a snapshot).
  - Calls: a call window N (default 256) announced in `hello`; the caller parks extra calls in 3b's parked-call queue,
    FIFO, refusing nothing (K16 kept). Exceeding N is a protocol error, enforced by the provider. 100k calls of 10 ms:
    a caller-side cap of 64 took 17.1 s, +4 MB, another client's p95 0.66 ms; unlimited ran 43,824 at once (+56.5 MB,
    p95 129 ms); a provider semaphore queued 96,736 on the provider.
  - Holds are unlimited by count; size limits stay a separate check. Dropped: the byte window and credit messages,
    snapshot admission and debt, C12's credit accounting, an adapter `backlog()` API, `reset` from the consumer.
  - **Relays ack per hop (option b):** the server acks upstream on receipt. When a downstream tab falls behind, the
    server drops that tab's queued parts and sends `reset { hold }` upstream; the provider answers with a fresh
    snapshot of that hold (a second `bound`). One slow tab never coarsens the other tabs of the same worker link
    (option a, end-to-end acks, rejected for that). About 40 more lines than (a).
  - Open for the slice-4 spec: Astra's circuit breaker (a hard transport-buffer cap plus a stall or heartbeat
    deadline that closes the link).
  Explainer: `packages/chord/docs/next/flow-control/` (Radius artifact 01m5n82vsbe5rtn4nm6wzaq0mp).
- **One pending queue for slow consumers of state (owner, 2026-10-23):** refines the snapshot fallback of "Flow control:
  an ack-clocked window" and supersedes "Watchable and one watch API"'s "after 100 pending frames the backlog becomes
  one root replacement" for state watches. Measured by Astra and Fable (`/tmp/fc2-*.md`, `/tmp/fc3-*.md`; real p2 entries plus synthetic stress
  cases): size-based rules fail ("snapshot bytes + sent op bytes" is no bound: an interned path lets a value grow
  faster than its ops; it drifts 1,254x under churn; exact size needs per-node bookkeeping), a time trigger punishes a
  stalled stream into a large value, and a count of unfolded commits resends whole histories. Folding alone came
  within about 10% of an exact oracle. Rules:
  - Pending ops stay raw (never encoded per commit while waiting); `r` drops everything before it.
  - **Leaf index:** a map from path key to the last pending leaf op (`a`, `s` of a primitive); a new leaf op on a
    path in the map merges into that op in place (`a`+`a` joined, `s` replaces `s` or `a`, `a` after a string `s`
    appends into it). Any other op (`p`, `m`, `d`, `t`, `s` of an object or array) clears the map. Correct because
    leaf ops on different paths commute, except an ancestor primitive `s`, after which the descendant cannot be
    written until a structural write clears the map (fuzzed: about 1.8M tracker and `diffRevisions` ops, arrays with
    splices and reorders, adversarial cases; a broken index without the clear on `p` fails). Cost about 0.2-0.4 us and
    60-80 B per pending leaf path. Ops come only from Chord's tracker and `diffRevisions`: no defences against
    hand-written ops (no path-key normalization). No folding of list appends (1% gain, quadratic copies) or trims.
  - **Cap: 10,000 pending ops after folding;** past it only "replace with the current value" stays pending (nothing
    more accumulates). Worst case about 2.2-2.7 MB per member per slow consumer. No size or text caps, no time trigger.
  - Used by link hold members while the K=2 window is full (encoded once when an ack frees a slot) and by state
    watches (`Watch` over `(value, ops)`): a slow listener gets one call per batch with the folded ops and the newest
    value. Measured, listener taking 1 s: 438 calls and 3.39 MB of ops become 171 and 371 KB. The watch change is in
    Chord's shared `src/watch.ts` (pi first); tests and `examples/04-watches` change with the contract.
  - Unchanged: Durable's event stream (`watchEvents` batches are events: they keep their own queue until removed),
    `NativeWatch` (newest value), relays (drop + `reset { hold }`: parts are opaque).
  Animation: `packages/chord/docs/next/flow-control/fold/` (Radius 01m5nc9s24e9kscppen2fxgwye).
- **Slice 4 split and first decisions (owner, 2026-10-23):** slice 4 is split into 4a (links and relays: IPC and
  WebSocket links, trusted links, parts as opaque bytes, flow control, host kinds and placement, routes, relayed holds
  and calls) and 4b (revocation, cycles across hosts, `host.references`, `host.activity`, size limits, compression);
  draft with structural changes and races: `packages/chord/docs/next/slice-4.md`. Decided: trusted links are an
  explicit option (`trusted: true` on `accept` and in `resolve`'s result; default untrusted; stamping only from the
  parent link). ~~Resets and queue overflow travel as `[["r", value]]` ops in an ordinary `state` message~~ (**superseded** by
  "Slice 4a review decisions": resets are a list-`bound`; overflow stays an `r` op): a relay's
  `reset { holds }` (a list) is answered with one message carrying every reset hold's members as `r` ops (snapshots
  taken in one step, applied in one batch), entries flagged `reset: true` in the header for relays; a second `bound`
  only for slice 7's restarted objects. ~~Relayed calls are sent round-robin per origin while the worker's call window
  is full (each origin keeps its order).~~ (**superseded** by "Relay flow control per origin": a relay forwards calls at
  once; each origin has its own N at the provider). The Durable conversation view's size on re-hold is a known cost until pi
  #11327 lands.
- **Relay flow control per origin (owner, 2026-10-24):** supersedes per-hop acks, `reset { holds }`, relay recovery
  and id renumbering ("Flow control: an ack-clocked window" relay part, "Slice 4a review decisions" reset part). The
  provider keeps the window (K=2), its pending queues and its call queue per **origin**; the relay never drops, folds or
  resets. The relay assigns each downstream link an origin number (never reused on an upstream link; 0 = its own
  work); upstream messages keep their ids and carry `origin` (read only on the parent link); the provider keys holds,
  calls, windows and acks by (origin, id); replies carry the origin. The relay keeps per downstream hold its upstream
  link and its original `hold` message (routing calls and releases; re-holds after a worker restart), and per downstream
  link a FIFO of the upstream link of each message in flight (each in-order `ack` goes to the right worker). A new
  message "origin closed" releases an origin's holds and calls when its link closes. A tab served by W workers may have
  2W messages in flight. Measured motivation: a slow tab through the relay needed ~24 s and 3 resets to catch up after a
  1 s stall (provider folding: 0.02-0.38 s). After the rework and the review fixes: a simplification pass with a budget
  of 1,200 lines of net growth for 4a (owner).
- **Docs (owner, 2026-10-24):** `design.md` becomes the one current statement of all rules, updated in the same commit
  as each decision; `mechanisms.md` folds into it, `carry-over.md` into `slices.md`; the decision log stays complete as
  the history and the reasons; slice specs stay as history after their slice. Nothing is dropped in the move.
- **Slice 4b: `host.activity` is a watchable (owner, 2026-10-24):** a JSON `Watchable` of `{ references, calls, jobs,
  lingering }`, published at most once per microtask turn with changes (design §3's "one readable").
- **Docs consolidation (owner, 2026-10-24):** applied as decided in "Docs": `design.md` now states every current rule
  (`mechanisms.md` folded in section by section, its 17 stale points fixed, then deleted); `carry-over.md` is the
  section "Carry-over" of `slices.md` (AGENTS.md updated). Settled by what slices 1-4a built, as approved: resets do
  not exist (per-origin flow control); trusted links skip only the `MESSAGE` check; a parked call waits its
  reference's `readyTimeout` (no per-`get` `parkTimeout`); the object backoff is per identity; `host.get(Type, params,
  context, options)` takes a context and `host.hold` returns at once and never rejects; a native's `close` gets
  `(value, reason, context)`; a local object's handlers act as the host's principal. Still open, listed in design
  §26 (#24-#29): the timeouts of later mechanisms, `host.root`'s signature, how a migration commit reaches consumers,
  compression on browser links, the circuit breaker, cuts C3/C4/C11.
- **Simplification pass after 4a (owner, 2026-10-24):** two cutters (Opus 5.5, GPT-6.1 Sol) read all of `src/next`
  without a line target (a target is not meaningful); the merged small cuts, two bug fixes (relays strip a client's
  principal fields on every path; a closed link delivers no queued message) and D1-D4 are applied by a fresh builder.
  D1: the unreachable "binding back to pending" branch of a served hold is cut from 4a; slice 7 builds it with reload
  (carry-over). D2: L1's unused `revocationKeys` is cut; slice 4b writes revocation keys with their first user. D3:
  `initial()` is checked once per definition at its first value (refines R8's "per document": `initial()` takes no
  input, so a wrong shape shows at the first call); a failing keyed `initial()` fails only its transaction, a
  singleton's fails the activation. D4: object instance ids (Q5) come with slice 4b, their first user; one-host cycles
  follow the waiting objects without ids.
- **Slice 5 spec drafted (owner, 2026-10-24):** straight from the discussion to `slice-5.md` (the walkthrough
  `routines-and-jobs.md` deleted, owner); design §14 and §15 state routines and jobs as decided; jobs in memory in
  slice 5, persistence in 6, reload rules in 7 (carry-over); jobs as objects (#9) rejected. `tx.start` returns the
  run's id (R12), `job.outcome(id, ctx)` waits by id; `unavailable/busy` is a new error reason.
  On the draft: routines start right after the object went live (same turn); `abort(id)` drops a blocked run (no
  `finish`, reported); `running` carries every run's args (views filter). Process: spec reviews, then the build.
  After the spec reviews (Astra, Fable, Opus, Sol): `tx.start` returns a `Run` handle (its outcome rejects if the
  transaction is discarded) instead of an id; `ctx.state.change(fn)` takes no context (changes while stopping after an
  abort still commit); running and finishing runs are a count, not references, and an object without holders ends
  (after `linger`) when its last run settles, dropping blocked runs; `finish` may chain the same job (its own run is
  excluded from the concurrency check); a `run` throwing after an abort ends `aborted`; `job_failed` reported;
  ~~routines also in facets~~ (**superseded** by "Facets only declare"); `persist: { resume: "rerun" | "abandon" }` is the final shape.
  After the build reviews: the builder's ten points accepted (every object end reports dropped blocked runs; their
  waiters get the end's error; `accepts` needs both mappings per older version; job args without bytes; routine labels
  per kind; `start` before live is `not_ready`; a run cancels a linger; design fixes; rejected handles keep their stack
  until read, documented); native `on` sources also get only the newest value after a busy call; the finishing run is
  excluded from dedupe too (`finish` may start the same job with the same key); the retirement frame in `on` is a
  slice-6 carry-over.
- **Routines and jobs open points (owner, 2026-10-24; walkthrough `routines-and-jobs.md` and its reviews):** at the
  `concurrency` limit `start` rejects; the routine handover is bounded by `closeTimeout`; a persisted job's state
  document gets the deferred persistence option (as in Durable), and authors throttle frequent state changes themselves
  (Chord does not coalesce them: every change is a commit and a message). Jobs keep `accepts` (owner: everything
  versioned has adapters; the walkthrough's "no job adapters" was never decided): a run started on an older version
  finishes on its old code, its args and result are mapped to the current version for `finish` and for `running`, its
  state document migrates through its own `migrate`; without an adapter the run is `blocked` and reported until a
  reload brings one. So a version change aborts nothing and discards nothing.
  Crash handling for persisted jobs (owner, with all four reviewers): a restart limit as Durable's (five crash
  interruptions, counted and persisted, clean closes not counted; then parked as `blocked`, cleared by `abort` or a
  reload); a `finish` that keeps throwing is retried with backoff and then `blocked` after five consecutive failures,
  its outcome, state and key kept, retried on a reload; how a persisted run resumes after a crash (rerun, replay-safe,
  or abandoned with an aborted outcome, wording aligned with Durable) is required, with no default.
- **Routines for slice 5 (owner, 2026-10-24; C4 decided):** two kinds, declared in the factory, no names and no
  `routines` namespace: `self.on(source, fn)` (first call with the current value, W2b; then one call per change, calls
  never overlap, changes meanwhile folded; a running call is not aborted by a change; a throwing call is reported and
  called again with the current value after a backoff of 1 s doubling to 60 s, a change during the backoff calls at
  once; the source ending ends the routine) and `self.onLive(fn)` (called once when the object goes live; returning
  ends it until the next reload or activation; throwing is reported and restarts it after the same backoff, reset
  after a run of a minute; an abort is no error). Both start when the object is live and stop when it ends (`ctx`
  aborted, then the drain); on reload all old routine calls of the object finish (bounded) before the new routines
  start: a handover per object, which needs no names. Routines are idempotent reconcilers; Chord keeps no state for
  them; what must survive is a document. Helpers `sleep(ms, ctx)` and `untilAborted(ctx)`; routines and handlers wait
  only through calls that take `ctx`. Errors: `HostError` `routine_failed { object, routine, error }` (`routine` =
  kind and position). Routines do not count in `host.activity`. Dropped: `every` (an `onLive` with `sleep`; a due
  time that must survive is a document), `custom` and `run(fn)` (an `onLive` with `try`/`finally`), names, the due
  time across reloads. Kept separate from jobs (different lifecycle, reload behaviour and output). Open: the
  handover's bound (`closeTimeout`, whose default may drop from 30 s to 10 s, or its own).
- **Slice 6 first decisions (owner, 2026-10-26):** (1) **Durable's internal commit observers run inside `adopt`**
  (pi change, upstream first, built and reviewed before the slice): the Session's `observeCommits` listeners (view
  mounts, task graph, scheduler, submissions) move from `#publish`, after `Storage.commit` returned, into the `adopt`
  callback, so every Durable view changes inside the storage's commit step; with `StoreStorage` Durable's `adopt` runs
  inside the host's batch, and Chord follows Durable's views as sources marked in the step (W1). Reason: today a
  derive over two Durable views (conversation view and task graph), fed by two watches, computes between their frames
  of one Durable commit ("tool call issued, no task running"). `adopt` stays throw-free (a listener's throw is kept and
  fails the Session after `Storage.commit` returned, as today); `subscribeCommits` and telemetry events stay in
  `#publish`; nothing changes for users of Durable's own storages. (2) **Persisted singletons load sequentially** right
  after the factory, all singletons of an object in one read transaction (S4), before its references are bound; a
  storage error is `storage_failed`, a fingerprint mismatch, a throwing `migrate` or an invalid migration result is
  `broken`. (3) **Durable's ids in the store:** `StoreStorage` keeps a `record_ids` table (Durable's one namespace
  across its five tables); the counter at open is `coalesce(max(id), 1) + 1` over it (1 is the root conversation). (4)
  **Few statements per commit:** the store keeps seq and head in memory (read at open, the head persisted with each
  commit, S9) and folds the documents engine's checks into the writes (a unique `record_ids` key, a partial unique
  index on the live address, `UPDATE … WHERE id = ? AND version = ?`), so a delta commit is about three statements
  (revision, version, outbox); `StoreStorage` maps constraint errors to the messages Durable's conformance suite
  expects. A benchmark compares `SqliteStorage` and `StoreStorage` on the same workload. Still open: the split of slice
  6, and retirement in watches (point 3 of the discussion: no `null` frame, Chord documents that retire).
  **Refined (owner, 2026-10-26), after four reviews of the first build:** the first build moved only Durable's internal
  observers into `adopt` and deferred host-waking work (`afterPublish`); the reviews found host-visible regressions in
  the gap between `adopt` and the end of `Storage.commit` (watch listeners before `subscribeCommits`, `waitForIdle`
  early, a late subscriber missing a commit, the active-task metric drifting after a rejection). Under review now,
  nothing built: "publication at adoption" (the whole publication, host `subscribeCommits` listeners and telemetry
  events included, inside `adopt`; no `afterPublish`; `adopt` runs no task code, so a marked run's `abort()` is
  queued). **No Durable special cases in Chord's store** (owner): the store never knows or waits for Durable's
  continuation.
  **Decided (owner, 2026-10-26), after four checks of the proposal (`/tmp/observers-proposal-*.md`, explainer
  `packages/chord/docs/next/durable-observers/`):** publication at adoption in Opus's variant. Inside `adopt`, in
  HEAD's order: the trackers, the telemetry events, the queueing of one microtask that dispatches the host
  `subscribeCommits` listeners (the listener list read inside that microtask), the internal observers. Microtasks run
  in order, so host listeners still run before every wait continuation, abort and `onWake` of the commit (before
  every watch delivery too, as first stated: **superseded**, see "Superseded (owner, 2026-10-26)" below), but after the storage's synchronous step, so never inside Chord's batch (Chord calls from them work; Chord
  needs only its step and flush to be synchronous). `afterPublish` is dropped. `adopt` runs no task code (a newly
  marked run's `abort()` is queued) and is fully throw-free (listeners, reports, metrics and telemetry contained; an
  internal observer's error fails the Session after `Storage.commit` returned). Accepted changes from HEAD: abort
  listeners fire after host listeners; a commit the storage rejects after `adopt` is published (it is durable; a
  replica stays equal to storage; spec invariant 2 changes) and its waits resolve before the Session fails; with a
  storage that works after `adopt` (JSONL) the publication runs before `Storage.commit` resolves; a throwing telemetry
  call is reported as `host_error` with callback `"telemetry"` and no longer rejects a durable commit. Nothing in pi or
  p2 depends on the old orders (checked: p2's three `subscribeCommits` users).
  **After the reviews of the second build (owner, 2026-10-26):** one delivery rule for every watch: a watch delivers a
  frame in a microtask queued after the frame arrived, also when its listener was busy (Chord's shared `src/watch.ts`:
  after a call the drain reschedules instead of taking the next frame in place). Without it a busy watch's
  continuation, queued before `adopt`, delivered a commit before its host listeners (Astra, Opus). Cost measured:
  about 170 ns per back-to-back delivery with a promise, less with a plain `queueMicrotask`; only busy watches pay it.
  Also: a host listener added between `adopt` and the dispatch gets the commit only when a listener existed at
  `adopt` (documented, accepted); a rejection after `adopt` keeps the storage error as the failure and still reports an
  observer's error.
  **Superseded (owner, 2026-10-26), after the third reviews:** the delivery rule did not hold (Astra, Opus: a delivery
  already queued folds frames that arrive later, so a watch can still deliver a commit before its host listeners, also
  in a shared commit step chained through promises); a complete fix (a late delivery queues itself again) would stall
  watchers behind a source that changes in every microtask. Decided instead (option b): **no ordering promise between
  host `subscribeCommits` listeners and watch listeners** (independent observers; nothing in pi or p2 depends on their
  order); waits and aborts still follow the host listeners by construction; the hop in `src/watch.ts` is reverted.
- **Durable's synchronous observers (owner, 2026-10-26):** `observeConversation(id, observer, ctx)`,
  `observeTaskGraph(observer, ctx)` and `observeDoc(token, …, observer, ctx)` become Durable's public primitive: the
  observer's `advance(change, ctx)` (the listener bag `{ value, ops, retired }`) runs synchronously inside `adopt`,
  `end(failure)` when the Session closes or fails; attaching returns the current value and `detach`, taken atomically
  on the line. `watchXXX` stays, built on it (a `Watch` is such an observer), for app code; `observeXXX` is documented
  for adapters (record only: no awaits, no Session calls, no throws, quick). Chord's `durableView` (slice 6b) is a
  source over it, marked inside Chord's batch in the store and grouped into one batch per Durable commit on the next
  microtask outside it.
  **After the reviews of its build (owner, 2026-10-26: fix everything to HEAD's level of correctness, performance and
  memory; the owner delegated the details):** `onWake` is no longer ordered after host listeners (same cause as
  watches); `Watch.endAfterDelivery()` exists (a task document's watch delivers its retirement, then ends `ended`),
  detaching only when the watch really ends and never while a listener call runs; the `observeXXX` context covers the
  attachment only; observers get `end(undefined)` when their task document's task ends; the change object a listener
  gets carries no context (the context is a separate field of the watch); a watch keeps only its address, never a
  loaded document; `observeXXX` rejects like `watchXXX`; Durable's file-watcher type in `/env` is renamed
  `FileChange` so `WatchChange` names only the listener bag.
- **One retirement mechanism for Chord and Durable, watches follow the address (owner, 2026-10-26; option A):**
  supersedes W2a's last frame `[["r", null]]` and the end reason `retired`, and Q11's silent reset as the only meaning
  of retiring a singleton. A document lives at an address (Chord: definition and key; Durable: kind, scope and key);
  every document, singleton or keyed, Chord or Durable, is watchable; a retirement is signalled to the watch listener
  as one last call with the last good value, no ops and a `retired` flag (no `null` anywhere); the watch goes on, and a
  later write delivers the new incarnation as `[["r", value]]` on the same watch. A watch ends when its owner ends
  (`ended`): a Chord document's object, a Durable task document's task (the retirement call, then `ended`, in the same
  commit), the Session; and by `stop`, cancellation, failure or a throwing listener. Durable's watches change from
  incarnation to address (breaking; nothing in pi or p2 watches a document that retires). Leaks: none new for task
  documents (they end with their task and invocation); a forgotten watch of a session or conversation document that
  is retired for good stays until its taker's context, `stop` or the Session ends it (GC tests). Still to decide: the
  shape of the flag, the value an absent address shows to members, derives and `.value`, and the per-key source in a
  factory.
  **Details decided (owner, 2026-10-26):** (1) a watch listener (and an `on` handler) takes one object before the
  context, `(change, ctx)`: `{ value, ops, retired }` for JSON watches, `{ value }` for native ones (a breaking change
  of the shared `WatchHandle`/`NativeWatchHandle` and of `self.on`, accepted). (2) A retirement call carries the
  address's value after the retirement: `initial()` for a Chord document (as Q11 reads an absent singleton), so
  `watch.value` equals the source's value for every reader; for Durable, which has no value for an absent document,
  the last value with no ops. (4) Watching an absent address gives `undefined` (`notes.watch(key, ctx)` as Durable's
  `watchDoc`). The wire carries a `retired` list per hold entry in `state`, like `failed`. (3) **A per-key source in a
  factory:** `handle.at(key)` declares a singleton per key: loaded at activation with the object's singletons, it reads
  `initial()` while the key is absent, and is a state member, a derive source and an `on` source; its watchers learn
  of a retirement through the flag. Telling "absent" from "empty" is `await handle.get(key)` (`undefined`) or the
  flag. Not adopted: the key as an activation dependency (fails when absent, ends `gone` on retirement).
- **Text is plain UTF-8, in code point order (owner, 2026-10-26; reviews `/tmp/text-review-{astra,fable,opus,sol}.md`):**
  supersedes S16's JavaScript order and W8's UTF-16 BLOB. `str()` columns are plain UTF-8 `TEXT` (`STRICT` tables;
  strings bound and read as they are), and text compares by Unicode code point on every backend (SQLite `BINARY`,
  Durable Objects, sqlite-wasm; Postgres `COLLATE "C"`, MySQL `utf8mb4_0900_bin` later). Written values and every
  query operand (`where` values, `inArray`, prefixes, cursors, `set` operands) of a `str()` column go through
  `toWellFormed()`: a lone surrogate becomes U+FFFD (what `TextEncoder` and Node's SQLite binding do), documented; a
  value containing NUL fails `invalid/args` (Node 24.4.1 truncates text at NUL on read; Postgres refuses it; content
  goes into `json(...)` columns, which escape both). A leading U+FEFF stays allowed: sqlite-wasm's reader drops it, so
  its backend reads values starting with `EF BB BF` as bytes and decodes them keeping it. The store exports
  `compareText(a, b)`; the memory backend uses it for ordering, ranges, `max`/`min` and `when`; a prefix's upper bound is
  the next code point after its last (portable); `substr` offsets count code points; a SQLite file must use the UTF-8
  encoding (checked at open). The guide states the rule: store order differs from JS `sort()` only for U+E000-U+FFFF
  against characters above U+FFFF; sort store text with `compareText`, page with the store's cursors, use `prefix()`,
  cut strings with `[...s].slice()` or `toWellFormed()`. Durable's strings in `StoreStorage` (`requestId`, kinds) keep
  Durable's JSON encoding in indexed columns, so Durable stays lossless. Rejected: CESU-8 in `TEXT` (a read path of
  special cases on best-effort SQLite behaviour; Postgres refuses it), CESU-8 in a BLOB, keeping W8.
- **Slice 6 is split (owner, 2026-10-26):** 6a, the store with Chord's persisted documents and tables (backends,
  tables, query runner, writes, commit queue, outbox, documents engine, index definitions, migrations, export and
  import, `self.table`, persisted `self.state`, P3, the host's store option, `storage_failed`, W12, keyed watches and
  retirement); 6b, what builds on it (persisted jobs, `StoreStorage` with Durable's conformance suite, the Chord source
  over Durable's views). The API points (the host option's name, how a Chord transaction enters the commit step, the
  table API in `self.tx`, the Durable view source, the commit benchmark) are proposed in the 6a and 6b specs.
- **The host's store and how it is opened (owner, 2026-10-26; slice 6a point 1):** the host option is `store`
  (`createHost({ …, store })`), not `storage`: it is the store itself, and in 6b Durable's `Storage` is `StoreStorage`
  over the same store. One entry point, `openStore(backend, ctx)`, with `sqliteBackend(db)` over any `SqliteDatabase`
  (Node through `chord/sqlite/node`, Durable Objects, sqlite-wasm later) and `memoryBackend()` for tests; the backend
  interface stays internal; `importStore(backend, archive, ctx)` takes the same values. `openStore` runs the store's
  own migrations, checks the file is UTF-8, and reads the head, the definitions and the id counters once. The app owns
  the store's lifetime: the host never closes it (in 6b the host and the Durable Session share it); the app calls
  `store.close()` after `host.close(ctx)`; on `storage_failed` the store stops, the host closes, and the app closes or
  reopens. No `openNodeStore(path)` shortcut.

  ```ts
  const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "session.sqlite"))), ctx);
  const worker = createHost<P>({ address: Session({ id }), principal, store, onError });
  …
  await worker.close(ctx);
  await store.close();
  ```
- **A Chord transaction enters the commit step as Durable's does (owner, 2026-10-26; slice 6a point 2: "if this is
  Durable's proven flow we should use it here too"; checked against Durable's `#runCommit`):** the object's line ~~(and
  the facet's)~~ (facet documents removed the same day) is held from the callback until the step returned; an abort or error before the step discards
  everything; then every draft is prepared, `checkpointWhen` picks base or delta per persisted document, and
  `await store.commit(writes, adopt, ctx)` runs without the caller's abort signal (once admitted, a commit runs to its
  end). `adopt(seq)` is one `host.batch.commit(...)` adopting the persisted documents, the in-memory documents and the
  staged changes together (Chord's addition: Durable has no in-memory documents; adopting them apart would show half
  a transaction, or publish an in-memory change of a commit SQLite then refused). An error before `COMMIT` returned
  rejects the transaction with nothing adopted; an error during or after `COMMIT`, or a failed `adopt`, is
  `storage_failed` (the commit stays published if it was adopted). A transaction with only in-memory writes never
  enters the queue and commits synchronously as before (W12): no extra await or promise.

  ```
  line -> fn -> (abort/error: discard) -> prepare, checkpointWhen
    -> await store.commit(writes, adopt)   // queue; BEGIN; revision, version, rows, outbox, head; COMMIT
         adopt(seq) = host.batch.commit(() => { persisted; in-memory; staged })
    -> release line(s) -> settle staged -> drafts revoked
  ```
- **Facet documents are removed; persisted data stays in objects (owner, 2026-10-26; slice 6a point 5; reviews
  `/tmp/facet-persist-review-{astra,fable,opus,sol}.md`):** cut C16 accepted (supersedes its rejection in "Slice 1
  approved"): a facet has no documents (`FacetSelf.state` goes), so no facet line, no lock order across two lines, no
  `Documents.facet` and no `Transaction.#facetLine`; a served object's transaction covers only its own object. Shared
  plugin state lives in a `local` store object with empty params, reached through its methods (its own failure domain,
  R18 recovers its dependents). Point 5 (persisted facet data) is moot: persisted documents and tables stay only in
  `local` objects with empty params (P3 unchanged). Why: the four reviewers found no stated reason in the history (the
  frozen kernel let facets persist; P3 was written for objects only), but a facet cannot fail at runtime (slice 2: a
  facet setup or `initial()` that throws rejects `load`, closing the host; C5 was rejected because a plugin's always-on
  parts would share one failure domain), and persisted data fails at runtime (fingerprint mismatch, throwing `migrate`,
  a newer version after a rollback, no store on the host): one plugin's stale document would close the worker, or need
  a second failable lifecycle for facets. In-memory facet documents had no real use either: none of p2's 46 `self.state`
  calls is in a facet; their only ability, one transaction over an object's and its facet's documents, is a
  cross-owner transaction, which the design rejects elsewhere (§9 "Rules across owners"). Other findings kept for a
  later facet lifecycle: reads of shared tables need the writer's line; an owner string `facet:<plugin>` collides with
  type names. Built in slice 6a (carry-over).
- **The table API in `self.tx` (owner, 2026-10-26; slice 6a point 3):** (a) the first argument is the table handle
  from `self.table(Def)`, never the definition (the handle belongs to one object, so `tx` refuses another object's
  table, as it refuses its documents); (b) keys are objects with exactly the key columns, `{ path, entry }`, not tuples
  (two swapped `str` columns of a tuple are silent at the type level; other or missing fields fail `invalid/args`, a
  trust boundary); (c) reads are async (`await tx.get(t, key)`, `tx.page(t, q, limit, { after? })`, `tx.rows(t, q)`),
  writes synchronous and buffered like a draft's ops (`tx.put(t, row)`, `tx.update(t, key, set)`, `tx.delete(t, key)`,
  `tx.updateWhere(t, where, set)`, `tx.deleteWhere(t, where)`): they check the row and stage it, no I/O, no line, so a
  bad row throws at its own call; the buffer goes into the commit step's backend transaction or is dropped on failure,
  like aborted drafts (writing at once would hold SQLite's one write transaction for the whole callback). As Durable
  (`setTask`, `settleSubmission` synchronous, reads async) and Chord's `tx.start`. (d) No write shorthands on the table
  handle (`edits.put(row, ctx)`) until real code repeats the one-liner. Outside a transaction the handle reads
  committed state: `edits.get(key, ctx)`, `edits.page(q, limit, ctx, { after? })`, `edits.rows(q, ctx)`,
  `edits.count(q, ctx)`. `tx.get` exists for tables only (documents keep `tx.draft`).

  ```ts
  self.tx(async (tx) => {
    const old = await tx.get(edits, { id });
    tx.put(edits, { ...row, at: now });
    tx.updateWhere(edits, (e) => prefix(e.path, from), { path: replacePrefix(from, to) });
  }, ctx);
  ```
- **Chunks of `rows` migrations (owner, 2026-10-26; slice 6a point 6):** 100 rows per commit, a fixed constant.
  Measured on slayer (`node:sqlite`, WAL, 20,000 rows of about 3 KB, a primary-key `UPDATE` plus an outbox `INSERT`
  per row): the total is flat from 100 to 1000 rows per chunk (about 15 µs per row); the step's median is 0.94 ms at
  100, 2.4 ms at 250, 9 ms at 500, 14.5 ms at 1000, 32 ms at 2000, and every other owner's commit waits for it. The
  store benchmark measures it again with the real store. Can change later (owner), e.g. a table definition naming its
  own chunk size; not built until a case needs it.
- **`lastSeq` instead of "head" (owner, 2026-10-26):** the seq of a store's last commit is called `lastSeq`, never
  "head" (Durable's "head" is a conversation's head: head markers, `findLatestHeadMarker`). Every "head" of the store
  in earlier entries (S3, S4, S5, S9, "Slice 6 first decisions" (4), "The host's store and how it is opened", the
  commit-step trace) reads `lastSeq`; a replica's "applied head" is its `lastSeq`. Renamed in design.md, the store
  book and the slice 6a spec.
- **Export archives are operations, the encoding is pluggable (owner, 2026-10-26; slice 6a point 7):**
  `store.export(ctx)` yields `AsyncIterable<ArchiveRecord>`: the state after its `lastSeq`, written in the outbox's
  operations as one synthetic batch from 0 to `lastSeq` (a manifest `{ kind, format: 1, lastSeq, schema }`; `table`,
  `index`, `put` per row; `document.create` per live record with its base, plus its later `document.change` records
  for `history: "full"` ones (Durable, 6b); an `end` record with counts). Retired documents, blobs, the outbox and sync
  state are not in it. `importStore(backend, records, ctx)` refuses a non-empty backend, an unknown format, records out
  of order and a missing or wrong `end`, and applies everything in one backend transaction with the replica's applier
  (import, bootstrap and batch apply are one code path). Export holds the commit queue until the iteration ends,
  throws, is closed or `ctx` aborts (a slow consumer stalls commits; the guide: export to a local file, then upload;
  snapshot reads on a second connection only if exports get large, S4). The encoding is pluggable, as the link's
  codecs: the store yields and takes records only and ships plain JSONL (`encodeJsonl`, `decodeJsonl`) with no size
  optimizations; gzip or a Delta-style dictionary encoder come later as formats without touching the applier (owner:
  "then it doesn't matter that the first thing we do is plain JSONL"). Sync is not export: it ships outbox batches as
  commits happen (S5); a full archive is needed only where no history can be replayed (a session moved as a file, a
  split-off session, a replica restored after divergence). Open for the sync layer: a session that never syncs keeps
  every outbox record (trimmed only after Radius acknowledges it), so its outbox grows without bound.
- **State and job names are restricted too (2026-10-27, slice 6a fix round, under the owner's delegation):**
  `defineState` and `defineJob` names follow the pattern of object type and table names, `[a-z0-9@/._~-]+`, lowercase,
  checked at declaration: they become the documents engine's `kind` and keys of job records, where NUL or lone
  surrogates would be truncated or replaced by SQLite.
- **Slice 6a build reviews (2026-10-27, under the owner's delegation to the reviewers' majority):** two rounds of four
  build reviews (`/tmp/s6a-build-review{,2}-{astra,fable,opus,sol}.md`), merged into two fix lists
  (`/tmp/s6a-fix{1,2}-brief.md`, 28 and 16 items) by majority, a point raised by one reviewer taking that reviewer's
  recommendation. Rules they settle beyond fixes of the spec: (1) **members across attempts:** a local object's state
  member is followed by its references and by other objects' derives through one member source per object and member
  name; when a new attempt goes live every member re-binds by name (one diff frame from the last value, consumers'
  derives recompute, a member the new variant lacks fails `invalid/member`), as a remote reference re-holds and gets a
  fresh snapshot (Opus B1); supersedes slice-6a §1.2's "derive members' watches end with their attempt". (2) While an
  object that was live is failed or activating again, same-host reads and new watches return the last values and get
  no frames (was `not_ready` while activating again). (3) A live failure freezes the members only after the commits
  admitted before the seal adopted and published once; a retry's factory and hydration wait for that, so no old commit
  lands in a new attempt. (4) Re-exposed and forwarded members freeze at the re-exposing object; the provider's source
  stays untouched. (5) A transaction cut at the seal while queued for the step rejects `released` at once; line jobs
  queued before the seal are refused. (6) The seq, document id and revision counters stop at
  `Number.MAX_SAFE_INTEGER` (`storage_failed`). (7) `evolveTable` checks each edit when it is made; import checks
  `meta` with the text rules; an export never started rejects `released` after `store.close()`. (8) The migration
  yield between chunks: `setImmediate` where the runtime has it, otherwise a `MessageChannel` message, never
  `setTimeout(0)` (clamped to 1 ms in Node; a message costs about 0.27 ms per yield there: a 10,000-row migration takes
  70 ms against 100 ms and 191 ms); supersedes round 1's `setTimeout(…, 0)`. (9) Round 1: keyed keys follow the
  `str()` rules (the empty key valid); same-host reads of a failed live object return the last value; stuck handlers'
  counts, references and presence released at teardown; refusing a new job version on a live object kept for 6a
  (slice 7 carry-over); in-memory keyed slots migrate on access. Measured against HEAD (`benchmarks.md`): calls 1-3%
  faster (19 promises per call against 20, guarded), watches through a reference at HEAD's level, a document member's
  read through a reference 0.25 ns slower, host setup about 3% slower.
- **Derives heal on a re-bind (owner, 2026-10-27: "a all the way, self healing is good"; Opus's F2 in the third
  build review):** a consumer's derive that failed on a provider member's earlier error recomputes when that member
  re-binds to the provider's new attempt (and every derive downstream of it), so it recovers once its source works
  again; watches over it get the recovered value as a fresh frame. Before, a failed derive ignored later changes (as at
  HEAD) and recovered only when its own object restarted.
- **Failures are watch calls; derives heal on every change (owner, 2026-10-27: "B", "beautiful, let's do it"):**
  extends "Derives heal on a re-bind". (1) A failed derive recomputes on every later change of its sources (and on a
  re-bind), so it heals as soon as it gets a value it can compute. (2) A watch stays open through a recoverable failure:
  the listener gets one tagged call `{ kind: "failed", error }`, and the next good value as `{ kind: "value", value,
  ops: [["r", value]], retired }`; the call is a tagged union (`WatchCall<T>`: `value | failed`; native watches
  `NativeWatchCall<T>`: `{ kind: "value", value } | { kind: "failed", error }`), so the compiler makes every listener
  handle the failure (an optional `error` field would let `({ value }) => render(value)` render the old value).
  Supersedes the listener bags `({ value, ops, retired }, ctx)` and `({ value }, ctx)` of "One retirement mechanism"
  (1). (3) Applies to derives, replica members a hold lists as failed, a member a new variant lacks (it comes back with
  a later attempt), registry values whose `compose` throws (slice 8). (4) A watch ends only for good: its owner ended,
  `stop()` or a cancelled context, a throwing listener, `storage_failed`; Durable's watches fail only for such causes
  and only take the new shape. (5) `self.on` handlers are not called for failures (a reconciler acting on an error call
  would act on the old value); the routine waits for the next good value; the failure is reported where it happens:
  a derive's owner reports `derive_failed { object, member?, error }` once per failure episode (the first failure after
  a value or after creation; a heal ends it), a new `HostError` kind (2026-10-27, slice 6a fix round 4: there was no
  report for a throwing derive besides a routine's `routine_failed` on its ended watch). One failure call per
  episode (a value turning into a failure), not one per source change while failed; a hold keeps only a member's
  newest pending failure. Watching a failed source (2026-10-27, slice 6a fix round 5, under the rule "the routine
  waits for the next good value"): `watch(ctx)` opens at the last good value and delivers one `failed` call first;
  a source that never had a good value rejects `watch()` with its error; `self.on` on a failed source waits for the
  first good value instead of ending.
  (6) `ref.state` stays a separate watchable of reachability (`loading | live | failed | released`; `ended` since
  "One vocabulary, groups 2 and 3"), same words: a
  value's watch says whether it can be computed, `ref.state` whether its object is reachable (values stay readable
  while loading). No new leaks: an open watch on a failed source holds what it held before and ends with its owner,
  reference or context (GC test). Built: the shared `src/watch.ts` upstream in pi first (Durable's listeners adapt),
  then slice 6a (points 1-3 except registries; registries in slice 8).
- **One vocabulary, group 1: the shared watch (owner, 2026-10-27: "yes"; vocabulary audit `/tmp/vocab-audit.md`,
  A1, A3, A8):** built in the same upstream change as the failure calls. (a) `WatchEnd` is tagged by `kind`, not
  `reason` (`end.kind === "failed"`). (b) A watch whose context is aborted ends `aborted`, not `cancelled` (one word
  for a requested end, as `AbortSignal`, the `aborted` code and `JobError.aborted`). (c) Durable's synchronous
  observers take the watch's shapes: `advance(call, ctx)` with a `WatchCall`, `end(end: WatchEnd)` (Durable never
  sends a failure call: its failures are final). (d) A member a new variant lacks behaves the same locally and over a
  link: a failure call, the watch stays open (today local `failed`, remote `ended`). (e) Durable's `FileChange` is
  tagged: `{ kind: "paths", paths } | { kind: "overflow" } | { kind: "failed", error }`. The audit also found that
  "Slice 6a small items" (1) is wrong: Durable's `Storage.close(context)` takes a context (decided with group 2).
- **One vocabulary, groups 2 and 3 (owner, 2026-10-27: "lgtm"; Durable's stored formats stay the same):**
  Chord v2 (built in slice 6a): (1) `ref.state` `{ kind: "ended", error }` replaces `released`; the `released` code
  gets reasons `ended` (object ended), `closed` (host, store, native), `settled` (`ctx.get` after its call),
  `version` (an old handle), `discarded` (a transaction cut at the seal); a holder's own release stays `released`
  without a reason. (2) Internal results are `done | failed { error }`; the attempt's `Outcome` is `Activation`,
  the jobs' `Ended` is `Settled`. (3) `DocumentSlot.remove` is `retire`; `StoredChange` is `create | change |
  retire`. (4) The wire's `cancel` message is `abort`; a native's close reason `stop` is `close`; ~~`job.abort(id, ctx)`
  returns `"marked" | "terminal"` (Durable's words)~~ (**superseded**, owner 2026-10-27: Durable's `abortTask` stores a
  mark and joins the run, Chord's 6a abort only fires a signal in memory; `job.abort(id)` stays in 6a, and becomes async
  and stored with persisted jobs in 6b, its result chosen there). (5) Homonyms: the store's `Staged` is `StagedWrite`, its `Phase`
  `WriteOrder`, the host's `KeyedMember` `KeyedBinding`, `KeyedMembers.hold` `pin`, `Presence.origin` `incarnation`.
  (6) Context last: `runState.change(fn, ctx)`, `host.route(Kind, options, ctx)`, `store.close(ctx)` (as Durable's
  `Storage.close(context)`; supersedes "Slice 6a small items" (1)'s "no context"). (7) `failed` and `gone` carry the
  wire error format (`WireError`). (8) `HostError`: `failure` where the value is a `FailureCause`, `error` otherwise;
  positions `{ kind: "on" | "onLive" | "native", position }`. (9) Store types as Durable's: `history: "latest" |
  "rewindable"`, pages `{ items, next }`, a singleton's address has no key (`""` only in the column). (10) The
  listener parameter is `call`; holds `served | relayed`; `put.v` is `version`. Durable's public API (pi upstream,
  with group 1): (11) `onReport(report)` with `report.kind` and `report.error`; `session_failed` is `storage_failed`.
  (12) `subscribeCommits` is `observeCommits` with the observer shape (`{ value, detach }`); a file watcher stops with
  `stop(ctx)`. (13) `CompactionFailure.reason` and `CompactionStatus.reason` are `trigger` (`pi.live`'s definition
  bumps its version with a `migrate`). (14) ~~One word for a definition that cannot take the stored state:
  `incompatible`~~ (**superseded**, owner 2026-10-27: `task_too_old` is stored in orphaned outcomes and settlements, and the
  report's `incompatible_task` covered two cases): the `task_outdated` report uses the scheduler's own words,
  `missing_task | task_too_old | migration_failed` (newer without `migrate`: `migration_failed`); Chord's jobs name
  their blocked reasons in slice 7.
  (15) `TaskInspection` uses `TaskState`'s words (`ready` is `pending`). (16) `DocumentCommitChange` is tagged
  (`{ kind: "retire" }` instead of `value: null`). Not done: Durable's stored tags (`status`, `type`; group 4), Durable
  throwing Chord's codes (6b), one retirement value ("One retirement mechanism" (2) stands).
  Added (owner, 2026-10-27, "lgtm"): Durable's `SessionEnd` and the `ReportFrom` argument of `runtime.report()` are
  tagged by `kind` too (neither is stored).
- **Chord v2 and its docs live in pi upstream (owner, 2026-10-27: "we can put chord v2 in upstream", "the docs can
  all be public, and in upstream"):** `packages/chord/src/next`, `src/next-node`, `test/next`, `test/next-node` and
  `docs/next` moved to pi `main` (`93029a0f1`), not exported until v2 has an entry point (experimental, noted in the
  changelog); the decision log moved from `apps/p2/docs/redesign-decisions.md` to `packages/chord/docs/next/decisions.md`;
  the root `AGENTS.md` carries the "Chord v2 Code Style" section. From now on every slice and every design doc change
  goes to pi first (worktree of `upstream/main`, check, tests, push, CI, merge into `private`); only `apps/` stays
  private.
- **Slice 6b D1: `StoreStorage` and `durableView` live in Durable (owner, 2026-10-27: "they are only used if durable
  is used"):** in Durable's own `src` (an ordinary pi module, now that Chord v2 is upstream), importing
  `@earendil-works/chord/next` (Chord's `./next` export comes with them). No package cycle: Durable already depends on
  Chord, Chord imports nothing of Durable (S13). Durable's conformance suite runs in Durable's tests and CI.
- **Slice 6b D2: Durable's records are ordinary declared tables of the store (owner, 2026-10-27: "a, that's the whole
  purpose of this slice"):** `StoreStorage` declares conversations, entries, tasks, submissions and `record_ids` as
  `defineTable`s, writes them with `put` (Durable replaces complete records), and reads them with the store's queries;
  the outbox, export, import, the applier and later `evolveTable` versions handle them as every table. The partial
  head index becomes a table `entry_heads` (one row per entry with a head; build, 2026-10-27, faster than an index on
  `(conversation_id, has_head, id)`); indexed strings that must stay lossless keep
  Durable's JSON encoding.
- **Slice 6b D3: one id counter per store (owner, 2026-10-27: "a"):** the store's counter (`next_document_id`, renamed
  `next_id`; the archive manifest's `nextDocumentId` becomes `nextId`) numbers every id in the store: Durable's
  `mintId` (conversations, entries, tasks, submissions, documents) takes from it in memory, explicit ids in Durable's
  writes raise it (an entry committed with id 100: the next mint is 101), and Chord's commit step takes its documents'
  ids from it; it is persisted as a high-water mark with every commit. `record_ids` stays for Durable's type check of
  an id ("already belongs to entry"); supersedes "Slice 6 first decisions" (3)'s `coalesce(max(id), 1) + 1` and 6a's
  "document ids monotonic with seq". Durable's own ids still rise in its creation order (its Session line serializes
  its commits and mints inside them), which its scans, transcripts and windows rely on; Chord's ids are gaps between
  them, as the five record types already leave. A minted id never committed may come again after a reopen (S10).
- **Slice 6b D4: the store has Durable's Storage semantics (owner, 2026-10-27: "agreed"; supersedes in part "Store
  errors: Durable's rule" and slice-6a rule 10's "an expression result outside it fails the step, which is
  `storage_failed`"):** Durable has two levels: its `Storage` rolls a failed commit back and stays usable (the
  conformance suite tests it), its Session fails on any commit error (`GuardedStorage`). "Store errors: Durable's
  rule" had put the Session's level into the store. Now: a step that fails before `COMMIT` rolls back and rejects that
  commit only (the step's code runs in the transaction callback, so an error there is known to come before `COMMIT`);
  the store stops only when the outcome is unknown (`COMMIT` or `ROLLBACK` failed), when `adopt` threw, or on a read's
  backend error. Owners react as Durable's Session: Durable's Session fails (unchanged); a Chord object whose commit the
  step refused fails live (`object_failed`, `broken`: memory and disk disagree); an `int` `CHECK` failure (a plugin's
  value out of range) fails only that transaction (`invalid/args`). `StoreStorage` runs Durable's commit checks in the
  step, where `SqliteStorage` runs them: no special case. Built in 6b (the store's step and object failure).
- **Slice 6b D5: persisted run records are documents of their object; one harness per store (owner, 2026-10-27:
  "sure"):** each unsettled run's record is a keyed persisted document of its object in the engine's namespace
  `chord.jobs` (owner the object's owner string, kind the job name, key the run id); Chord sets that namespace, a plugin
  never does, so nothing collides; the state document stays an ordinary document of the run; `finish` deletes the
  record and retires the state (Q9), so only unsettled runs are stored and in memory; activation loads them through the
  engine's key listing and a load per run (no new engine read). Durable's tables are named under the type name
  `pi.durable` (`"session:pi.durable:entries"`; type names are unique per app). One `StoreStorage` per store: a second
  one on the same store is refused (`invalid/args`), as one host per store (rule 7). Rejected on the way: a table per
  job, a store-wide runs table, `$`-marked internal names (owner: "if our abstractions can't cleanly support this
  without $ magic, it's a bad abstraction").
- **Slice 6b D6: persisted jobs restart as Durable's tasks (owner, 2026-10-27: "yes, same rule for chord"):** at
  activation a run recorded `running` gets `restarts + 1` (stored) and resumes per its `resume`; a clean close writes
  its stopped runs back so the next activation counts nothing (as Durable's `writeAtClose`); a `ctx.state.change`
  resets the count; at five in a row the run ends `failed { kind: "restart_limit", restarts }` (a new `JobError`),
  `finish` runs, `job_interrupted` is reported. Supersedes design §15's `blocked { restart_limit }` (no parking, as
  Durable since #11139).
- **Slice 6b D7: `job.abort(id, ctx): Promise<"marked" | "terminal">` (owner, 2026-10-27: "yes"):** Durable's words
  and behaviour (`abortTask`): a running run's abort is stored and its signal fired, resolving `"marked"` once `run`
  settled; a finishing run is only marked; a blocked run is dropped (`"marked"`, as Durable's orphan); no unsettled run
  with that id resolves `"terminal"` (Chord keeps no settled runs, Q9). Supersedes "job.abort stays until 6b".
- **Slice 6b D8: deferred persistence of a run's state, per change (owner, 2026-10-27: "agree"):** `ctx.state.change(fn,
  ctx, { persistence: { kind: "deferred", withinMs? } })`, Durable's `CommitPersistence` shape (default 1,000 ms):
  adopted and published at once, stored with the next immediate change, before the outcome is recorded, at close, or
  after `withinMs`; a crash loses what is not stored. Only run state documents for now.
- **Slice 6b D9: `self.follow(attach)` follows Durable's views (owner, 2026-10-27: "sounds good"):** a generic Chord
  primitive, no `durableView` module in Durable: `attach(observer, ctx)` returns `Promise<{ value, detach }>`
  (Durable's `Observation`; its observers have Chord's watch shapes since pi `5f312dac4`). Chord makes the observer,
  attaches during activation (early calls held, `value` the start value), detaches at the attempt's end; calls inside a
  batch mark the source in the step, calls outside one are grouped into one batch on the next microtask; a rejected or
  `undefined` attach fails the activation as a failed dependency; Durable's `failed` end ends the watches `failed`.
  Returns a `Watchable` (state member, derive source, `on` source). Supersedes the carry-over's `durableView` and D1's
  `durableView` part.
- **Slice 8 is "Registries and `host.root`"; the harness object is p3's (owner, 2026-10-27: "we want to get chord done
  this week. p3 needs design and is next week. just need all chord primitives in"):** Chord builds the primitives the
  harness needs (registries, `self.writable`, `retryOn`, a `RegistryReader` for Durable, `host.root`, `chord(fn,
  context)`); the harness object (`Harness.open` over `StoreStorage`, `resume()` after the start barrier, the models,
  environments and extensions registries) is p3's base code, shown in Chord only as an example or test. Plan: Chord v2
  (6b, 7, 8, 9) this week, p3's design next week.
- **Slice 6b R1: retirement per record by `history` (owner, 2026-10-27: "sgtm"; spec review, all four reviewers
  found that Durable keeps retired records):** the engine's `history` gets three values, set by the adapter at
  creation and applied at retirement: `none` (Chord's documents and job records: older revisions dropped at a new base,
  row and revisions deleted at retirement, 6a's behaviour, until now called `latest`), `latest` (Durable's session, task
  and latest conversation documents: older revisions dropped, the row kept with `retired_at` at retirement, so reads at
  a point find it), `rewindable` (everything kept). `retireDocument` reads the record's `history`; no flag, archives
  and replicas carry it. Rejected: keeping every retired record (one rule, but a dead row per finished job run, two
  with its state, and per retired keyed document, that Chord never reads).
- **Slice 6b R2: no host kind in store names (owner, 2026-10-27: "what use is host in table names anyways? seems
  stupid. no host"; supersedes the host-kind part of W7, "Restricted names" and "Slice 6a's three code questions" (3)):**
  tables are `"<object type>:<table>"` (`"notes.store:edits"`, `"pi.durable:entries"`), document owners
  `"<object type>"`; a store belongs to one host (rule 7), so the host kind told nothing, and `StoreStorage` and stores
  used before or without a host get the same names. W7's rule stays: no host instance in a name. Changed in 6a's code
  in 6b; the applier checks two parts.
- **Slice 6b: owner names and claims, no `pi.durable` (owner, 2026-10-27: "seems reasonable"; supersedes D2's and D5's
  `pi.durable` type name and D5's "one `StoreStorage` per store" rule):** every table and document in the store belongs
  to an owner name, claimed once per store. A `local` object with empty params (P3) claims its type when it first
  declares persisted data (`self.table`, persisted `self.state`, persisted `self.job`); `StoreStorage.open(store, owner,
  ctx)` claims `owner`; a second claim of a name is refused (`invalid/args`): a second harness, or a plugin type that
  meets the harness's name. `StoreStorage` declares its own tables (`entries`, `tasks`, …) through the store, the path
  `self.table` takes, named `"<owner>:<table>"`, and writes its documents under `owner` in the engine's namespaces
  (Durable's scopes; corrected 2026-10-27, it was "`durable`"). In p3 the harness object passes its own type (`StoreStorage.open(store, Harness.name, ctx)`; base code gives
  the store to the core facet); Durable's conformance suite passes a test name. The owner name plays the role of
  `SqliteStorage`'s `prefix`, checked by the store. Objects never see the store: their API writes to the host's store
  under their type; a host without a store fails an object declaring persisted data (`broken`, 6a). Rejected: an owner
  handle (`self.storage`), an indirection that only added protection against trusted code.
- **Slice 6b R3: a seal is a clean stop for persisted runs (owner, 2026-10-27: "a"):** a persisted run cut off by
  its attempt's seal while the object continues (a live failure, then a retry) is written back stopped, and the next
  live attempt resumes it per its `resume` (rerun or abandon) without counting a restart, as after a clean close (D6).
  In-memory runs keep 6a's rule (`failed { aborted, reason: "restart" }`, finished on the next live attempt).
- **Slice 6b R4: a follow source's end (owner, 2026-10-27: "yes"):** Durable ends an observer `failed` (its Session
  failed: the object that opened Durable fails `transient`, its retry reopens its natives, Durable included, and attaches
  again, as Durable's own recovery is to reopen from Storage) or `ended` (the observed owner ended normally, a task
  document's task: final, the member keeps its last value, its watches end `ended`).
- **Slice 6b: claims per table and per document namespace (owner, 2026-10-27: "agree"; refines "owner names and
  claims"; Fable's second review N2):** what can collide is claimed once per store: a table by its SQL name, documents by
  `(owner, namespace)`; so the object that opens Durable can also declare its own persisted data under the same owner
  name, and two harnesses can share a store under two owner names (owner: "seems like they could"); a second
  `StoreStorage` on the same owner is refused by its tables. "One harness per store" is no rule, only how p3 uses it.
- **Slice 8 D1: a registry's token is shared, its provider serves it (owner, 2026-10-27: "b", "yes"):** the token
  `defineRegistry<C, V>(name, { version })` carries identity only (bundled by every contributor, as a contract); the
  defining plugin's facet provides it with `host.serve(R, { compose, accepts? })`, as it serves object types. One rule
  for versioned things: a shared definition (object types, registries) keeps its adapters with the provider; a
  definition of one owner (documents, tables, `json(...)` columns, jobs) keeps them in itself. Refines Q8's "one
  authoritative declaration" (the serve is it) and design §17's example.
- **Slice 8: registry failures (owner, 2026-10-27: "ok", "agree"):** contributions never fail a registry: a
  watchable contribution that fails is left out of the table and reported (`contribution_failed`), back once healed;
  a throwing `compose` (the owner's bug) is reported (`registry_failed`), its watches get a `failed` call, and `.value`
  keeps the last good composition (before any, it throws). Derives keep `.value` throwing while failed: state must match
  its sources, an extension point must stay available.
- **Slice 8 D2 and D3 (owner, 2026-10-27: "yes"):** D2: a `retryOn` source retries a failed object only on a `value`
  call; a `failed` call does nothing. D3: `host.root<T>(fn, context, { principal? })` gives `fn` a handler's call
  context (the host's principal or the given one, this host's incarnation, `context`'s telemetry and signal linked
  until `fn` settles, `ctx.get`); at settle or abort the context is sealed (`ctx.get` rejects `released`, its references
  released, their calls reject), so an uncooperative `fn` fails at its next use of Chord; before `load` its gets park;
  after `host.close` it rejects `released`. `chord(fn, context)` is p3's helper. Closes design §26 #25.
- **Slice 8 S1: a Session close fails Durable's observers (owner, 2026-10-27: "a"; spec review, all four reviewers):**
  Durable ends an observer `failed` (error "session closed") when its Session closes, and `ended` only when the
  observed owner ended (a task document's task); refines R4 (Durable change, upstream). So a follower of a harness
  reached through a registry fails `transient` when that harness closes, and its retry follows the new one. A
  `retryOn` wake that arrives while the object activates is kept and retries it at once if that attempt fails.
- **Slice 8 S2: registry readers of an older version (owner, 2026-10-27: "a"):** as contract state, the provider maps
  back: `host.serve(R, { compose, accepts: { [old]: { contribution?: (old) => current, value?: (current) => old } } })`;
  a reader bundling an older token gets the composed value mapped to its version (computed once per composition and
  version, only while such a reader exists); without a `value` mapping, or for a reader newer than the provider, its
  value is failed `contract_mismatch` (reported); such a reader fails `broken`, not `transient` (nothing heals it before
  a reload, which retries broken objects; build review 2026-10-27).
- **Slice 8 S3: `self.registry` is a dependency, as `self.get` (owner, 2026-10-27: "isn't self.registry meant to wait
  like self.get?"; my spec had it as a plain read, a mistake against design §6, §7 and §17):** activation waits until
  the registry has a value (served and composed once; an empty table composes too, at the serve); after `load`'s
  setups a registry without a value cannot get one before a reload, so a reader then fails at once `transient`
  (`unavailable/undeclared`) and is retried when the registry gets its first value (R18), as `self.get` of a type not
  served here fails at once (refined 2026-10-27 after the second spec review: no `readyTimeout` wait at start); once live, a later failure of the registry changes nothing (last good value).
- **Slice 7b's open points, as recommended (owner, 2026-10-29: "yes"; brief `slice-7b/`):** (1) the API is
  `host.reload(facets, ctx)`, by plugin name (added, changed; a plugin missing from the list is removed), resolving with
  a report of what each object did, rejecting with the code error and nothing changed; `load` stays the first call. (2)
  A `writable` across a pure swap goes back to its initial value (the new factory makes a new one; no positional
  matching). (3) The rollout across hosts is the app's: it calls `host.reload` on each host in order (server, workers,
  clients); Chord guarantees per host (staging, commit, `installing`, rollback). (4) No install watchdog: `reload`
  takes a context and the app passes its deadline. (5) The loader lives in Chord (`chord/next/loader`, slice 7c). (6)
  Chord ships the app kit as optional subpaths: `loader` and `dev` (7c), `http` and `workers` (slice 10), `web` and
  `tui` (slice 11); telemetry (slice 9) last.
- **A plugin's npm dependencies are bundled; external only by opt-in (owner, 2026-10-29: "explicit opt in + (a)"):**
  a plugin's `dependencies` are installed into its own `node_modules` (`npm install --ignore-scripts`) and bundled into
  each facet that imports them (host packages, its `peerDependencies`, stay external and are passed in). On Node a
  plugin may keep named packages external with an explicit list in its `package.json` (`"chord": { "external": [...] }`):
  server and worker facets then load them from the plugin's `node_modules` (`createRequire`, as pi 1.0 loads extension
  dependencies), native addons included; they stay in Node's module cache until the process ends, so a new version
  takes effect after a restart. A browser or TUI facet importing an external package fails to build. Slice 7b
  (the loader).
- **The dependency model is decided (owner, 2026-10-29: "just build this"):** `packages/chord/docs/next/dependencies/model.md`
  (explainer `book.md`, `index.html`) as decided, with its remaining four points taken as recommended: (1) the barrier
  is (a), `load` resolves at the first outcomes of this host's host-lifetime objects (local blockers still in their
  first attempt are waited for; waits on other hosts or failed dependencies end the first pass); (3) `waiting` is a new
  `FailureCause` kind; (4) a pure swap whose new factory needs a missing dependency parks the object, no overlap of old
  and new code; (5) a registry's last good value is kept only while every contribution it was built from is still in
  the table. Supersedes R18's dependency deadline and backoff, S2's `broken` and S3's backoff, §7's throw for a missing
  local type and getters' rejection, §21's `gone` on removal and its rollout `updating` deadline, the start barrier's
  admission gate (holds wait only for the publication). Built as slice 7a (`slice-7a.md`); design.md is folded with
  the build.
- **Cycles across hosts: no probe, a diagnostic (owner, 2026-10-29: "yes"; dependency model, decision 6):** cycles stay
  found as today: on one host by the walk over waiting edges at `self.get` (exact), across hosts by the activation chain
  in holds (objects that start one after another). The remaining gap, a ring across hosts whose objects start at the
  same moment, is not detected: under the dependency model, which has no dependency deadline, such a ring stays parked.
  It is made visible: an attempt parked longer than its `readyTimeout` on a remote attempt that is itself only
  `loading` is reported once per parking episode as `HostError` `parked_long { object, waitingFor, since }`; nothing
  fails or retries. A cycle is a plugin bug (owner: "if no plugin bug, we don't need it"); the guide's rules for plugin
  authors and agents: (1) a factory declares only what the object needs, never a type that needs it back; (2)
  back-references and occasional lookups go into methods and routines (`ctx.get`); (3) data flows up through state and
  registries, not mutual `self.get`; (4) host-lifetime objects on the server never declare worker types in their
  factory. Rejected: the probe (edge-chasing searches with a check along the recorded trail, `/tmp/model/review*`,
  seven review rounds; complete only with a re-search timer or a full search lifecycle, the most intricate code in
  Chord for a plugin bug) and the slice 4b timeout narrowed (it polls chains across hosts again, misses a ring of
  waiting attempts, and retries in lockstep without finding the ring). Supersedes slice 4b review decision (2)'s
  timeout once the dependency model is built (slice 7); folded into design §6 with it.
- **Getters wait through `waiting` (owner, 2026-10-29: "(b) with a default seems fine; UI stays responsive anyways
  because it usually holds instead of get"; dependency model, decision 2):** `host.get`, `ctx.get` and `host.registry`
  wait while the reference is `loading`, `failed { transient }` or `failed { waiting }`, bounded by their
  `readyTimeout` (default 60 s; callers choose their own), and reject at the deadline with the last cause; only
  `failed { broken }` rejects at once. Calls stay as they are: on a `loading` reference they park, bounded; on a
  `failed` one (any cause) they reject at once. A UI holds (`host.hold`) and shows `ref.state`; code that needs the
  object now gets it. Reviewers (`/tmp/model/stw-*.md`): Fable (b, calls included), Opus (a, plus a `whenLive`
  helper), Sol and Astra (c: callers park until their own context aborts, with caller deadlines and caps on pending
  calls; (b)'s default deadline is that cap). Sol's p2 note: cleanup in a `finally` after an abort needs its own
  bounded context, not the aborted one.
- **Only hosts with an address serve remote types (owner, 2026-10-29: "b"):** a host serving a `remote` type needs an
  address and a principal; `load` refuses a facet that serves one on a host without an address (until now a host with
  a principal but no address served remote types and placed every one of them "here"). So "here" is decided by the
  address alone, as the host address of the type. Holds carry their `address` always (required on the wire).
- **`hostAddress` instead of `placement` (owner, 2026-10-29: "yes, rename"):** the field of a `remote` contract that
  computes where its object lives is `hostAddress: (params) => Address` (it returns the address of the host that serves
  the object, the vocabulary of `createHost({ address })`, routes and holds); supersedes the name of "`placement`, not
  `host`" (2026-10-21). The error reason `invalid/placement` is `invalid/host_address`; the internal module that decides
  where a request goes (`host/placement.ts`, `Placement`) is `host/destination.ts`, `Destination`. Earlier entries' and
  slice specs' "placement" reads "host address"; they keep their wording as history.
- **Every remote type declares its placement (owner, 2026-10-29: "yes, let's remove it"):** `placement` is required in
  `remote()` (a type error without it, and a declaration error at runtime); a remote type without placement, a leftover
  of slice 3a (remote objects over one link, before host kinds in 4a), is gone, and with it the fallback "here if served
  here, otherwise the parent" and its re-placement at the first parent link. Every remote request is placed by its
  address alone (dependency model, `packages/chord/docs/next/dependencies/`). Tests and examples get `placement: () =>
  Server()` or their own host kind.
- **No client providers for now (owner, 2026-10-28: "yeah, no client providers for now"; reviews
  `/tmp/barrier-{astra,fable,opus,sol}.md`):** clients stay unaddressable and serve only `local` types (design §3).
  Client-side capabilities (a phone's camera, clipboard, a page's WebMCP tools) go through an owner's state, as the
  Questions service: a tool asks an owner store (`request`, `wait`), clients watching its open requests carry them out
  and answer with a method call (the answer is method arguments, checked against the owner's schema; bytes as `bytes()`
  leaves, chunked if large); a client may advertise the tools it can run to such a store, tied to its presence. Why:
  a client as a provider would feed untrusted results, state and ops into server and worker objects (consumers never
  validate them), needs client addresses, routing down through relays and a principal for clients; the owner pattern
  needs nothing new in Chord and survives link drops and several devices by the owner's rule.
- **Design audit of slices 1-6a (owner, 2026-10-27; `/tmp/design-audit-{opus,sol}.md`):** the built code follows the
  design except for five bugs, fixed after 6b's commit with the auditors' reproductions as tests: on a failed
  activation references are released after the natives closed (§6, §13); a dependency going live while the dependent
  activates retries it (R18, the wake remembered); a call on a `local` object runs with the host's incarnation (§4); a
  retirement of an unloaded document checks its stored version and fingerprint (§9, R15); `ref.retry()` holds a refused
  hold again with a new id. Two choices: (6, "a") a link drop while a remote dependency is still loading leaves the
  dependent `loading` until `readyTimeout` (§6; supersedes slice-3b race 18's transient failure); (7, "a") `host.hold`
  and `host.get` check params at once, also before `load`; "fails once `load` resolved" stays only for a local type
  not served here (§7). Stale design text updated: `mapShared` per array, job runs keeping a failed object alive only
  while an attempt is live or activating, `ctx.state.change(fn, ctx)`, revocation closes child links, routes take a
  context, §22's `revoke`/`chain`/`limit`, native watches collapsing only past 100 pending values.
- **Slice 6b: numbers accepted (owner, 2026-10-27: "yeah the reopen times are ok"; "i accept the 12%": resuming a
  conversation watch 20 entries back costs about 12% more CPU on `StoreStorage`, once per reconnect, about 0.1 ms per
  mount, from the extra promise per read in the fork scan):** reopening a store with
  `StoreStorage` costs about 0.15 ms more than `SqliteStorage` once per open (0.28 to 0.43 ms: six table declarations,
  the allocator read, compiling the reads); the one-entry commit's mean is raised by one outlier among 20 samples while
  its p75 is equal or lower. Neither is a hot path or a steady regression. Accepted by the redesign session in fix
  round 1 and shown to the owner (not his quote): `StoreStorage.close` waits for its commits only (its reads go straight
  to the store, which stays open).
- **The performance and memory bar, and converging reviews (owner, 2026-10-27: "yes"):** supersedes "as good as
  HEAD in everything" for Chord v2 slices and pi changes. CPU: each hot path (calls, changes, watches, links) within
  about 5% of HEAD, measured in bursts with alternating processes pinned to one CPU; worse is fixed or goes to the
  owner with numbers. Memory: allocation per operation and memory retained after GC no worse than HEAD beyond noise,
  with GC probes for everything that must be collected (ended objects, released references, closed hosts, watches on
  failed sources). No super bad regressions; small differences within noise are not chased. Reviews converge: a fix
  round adds no new decisions or features; the same reviewers (restored, with their context) re-review their own
  findings; when only small items are left, the slice is committed and they are carried over.
- **Size is not a goal by itself (owner, 2026-10-27):** no cut pass after slice 6a: "if the user-facing API is great
  and the underlying implementation fast and correct, we're ok". `src/next` is about 13.2k lines without blank lines
  and comments after 6a's build (about 8.5k before), against the earlier target of 6-7k for all of Chord v2, which this
  supersedes; the bar stays a great API, HEAD-level speed and memory, and correctness.
- **Second spec review: the majority (owner, 2026-10-27: "pick the majority vote for everything, get building"):** the
  second review of slice 6a (`/tmp/s6a-review2-{astra,fable,opus,sol}.md`) is decided by the reviewers' majority; a
  point raised by one reviewer takes that reviewer's recommendation; ties take the simpler single mechanism. Folded
  into slice-6a.md (section 9 and section 15, 27 rules) and design.md. The main points: (1) **migrations by
  `evolveTable`** (all four): a base `defineTable` and one `evolveTable(prev, edits)` per version, each materialized and
  fingerprinted (`TABLE_FORM_VERSION`), edits `rename add drop index dropIndex json` and at most one data step (`rows` or
  `update`), the editor's types ordering them, per version an (A) commit (DDL, `migrating`) and a (Z) commit (last
  chunk, later edits, `ready`), recorded as `alter`/`index`/`dropIndex`/`table` writes; fresh tables created at the
  newest version; shared with contracts only `hash64`, the normal form per column, `Increment<N>` and the editor-return
  check (supersedes the derived adds and drops of "The migration API: the reviewers' consensus"). (2) The store's
  admission check through `store.commit(writes, { admit, adopt }, ctx)`. (3) An admitted commit's staged job changes are
  adopted into the object (supersedes "The seal fence"'s "staged job changes of the sealed attempt abandoned"); a run cut
  off by its attempt's seal ends `aborted { reason: "restart" }`. (4) A transaction at the seal is discarded; pending
  async `tx.*` operations tracked as in Durable. (5) Key columns immutable in `set`. (6) Writes serialized before
  `BEGIN`; canonical `set` vocabulary with an explicit null for clears. (7) `int` columns kept in the safe range by a SQL
  `CHECK` (an out-of-range result in the step is fatal, accepted), the JS evaluator checking the same. (8) The outbox
  floor (`read(afterSeq)` valid from the floor to `lastSeq`). (9) The manifest carries `nextDocumentId`. (10) A bounded
  LRU for `chord/sqlite/node`'s prepared statements (pi change). (11) Slots keep `valueVersion` and `storedVersion` (as
  Durable's `LoadedDocument`). (12) An admitted commit of a failing object adopts and publishes once (Sol, Fable). (13)
  Retiring a `latest` record deletes its row. (14) One host per store. The rest: section 15 of the spec. Carry-over to
  slice 7 recorded in slices.md.
- **Slice 6a small items (owner, 2026-10-27: "all yes"; from the four spec reviews):** (1) `store.close()` (no
  context, as Durable's `Storage.close()`) waits for a running step, rejects queued commits, running exports and reads
  `released`, closes the backend; idempotent, also after `storage_failed`. (2) The store tells its host of
  `storage_failed` through an internal listener, once; the host reports once and closes itself. (3) An omitted outbox
  option keeps the persisted setting; switching needs an explicit `outbox: true` or `false` (supersedes in part "The
  outbox is optional": "opening with the other setting is that explicit switch"). (4) `store.outbox` is `undefined`
  without an outbox (typed); `read(afterSeq)` before the first stored seq and `trim` beyond `lastSeq` reject; `trim` is
  idempotent. (5) **No hand-written memory backend:** tests run on SQLite `:memory:` through `chord/sqlite/node`; one
  semantics (`NULL`, text order, the `set` evaluator, ordering), no conformance suite across two backends; every real
  target is SQLite (supersedes the memory backend of "The store", S3 and "The host's store and how it is opened").
  (6) Export takes the queue at its first `next()`, an abort listener releases it while the consumer is suspended (a
  later `next()` rejects `aborted`); it reads page by page with plain reads, not one long read transaction. (7) Parts in
  order: manifest; per table its `table`, `put`s, `index`es; the `document.create`s; `end`; parts after `end` refused;
  `importStore(backend, parts, ctx, { outbox? })`, the outbox starting after `lastSeq`. (8) A live object failing is
  reported as `object_failed { object, cause }`. (9) `keys(ctx)` is in code point order, in memory too (`compareText`).
  (10) A migrated base is written back by the next commit that changes the document (supersedes design §9's "a
  read-only transaction right after a version bump writes the migrated base"); until then a load re-migrates (once per
  object). (11) Document ids are assigned in the step, monotonic with seq, given to `adopt`. (12) A run waiting for a
  live attempt keeps its object alive only while an attempt is live or activating. (13) Chord's own loads take no read
  transaction (the object holds its line, so plain reads are consistent); S4's read transaction stays for reads outside
  a line (Durable's, 6b); supersedes "Slice 6 first decisions" (2)'s "in one read transaction". (14) `put` is an upsert
  (the whole row replaced); `update`/`delete` of an absent key change nothing and are recorded with their count (0).
  (15) At write `int` is a safe integer, `num` finite, `bool` stored 0/1; one compiled closed check per table. (16) The
  column helpers are L1's (`str int bool num opt`), a restricted subset. (17) Default order by key ascending; the key is
  appended to every `orderBy` as the tie-break; one direction per query in 6a. (18) Cursors are opaque strings bound to
  table, order columns and direction; decoding them is a trust boundary (`invalid/args`). (19) Generated SQL has a
  bounded number of texts (the facade caches every prepared statement): `limit` and cursor values bound, `inArray` as
  one JSON parameter through `json_each`. (20) Cut to 6b: the engine's reads at an older seq (`find`/`load` with `at`)
  and exporting `history: "full"` (the format defines the fields now).
- **Cold keyed loads on the line; Chord aligns with Durable (owner, 2026-10-27; slice 6a spec review blocker 9):**
  a cold read of a keyed document (`get`, `watch`, an `at` subscription) is a job on the object's line, as Durable's
  `snapshot` loads on the Session line: it waits for the line, loads, installs and releases it; cached reads take no
  line; `tx.draft` loads inside its transaction, which holds the line; one load in flight per key, shared, each
  caller's `ctx` ending only its own wait; a load installs its tracker only while the key is still absent (`adopt`
  always wins). Why: a load outside the line could install a value from before a transaction that committed meanwhile,
  and the next delta would be computed on it. **General rule (owner): Chord and Durable align as much as possible**
  (the same rules and mechanisms where they solve the same problem: commits, lines, loads, errors, watches).
- **The migration API: the reviewers' consensus (owner, 2026-10-27; slice 6a spec review blocker 8):** the owner
  delegates the shape to the spec reviewers ("whatever the reviewers all like and find consistent and easy to implement
  correctly"); only a disagreement among them comes back. Proposal in the spec (Opus's shape, Sol's protocol): adds and
  drops derived from the declared versus the recorded columns (a new column `opt(...)` or with a `default`; a dropped
  column loses its indexes first); `migrations: { N: { rename?, rows? | update? } }` with renames explicit; a version
  bump without an entry is a schema-only change; columns or key differing at the same version fail `broken`; key and
  column-type changes (`rebuild`) cut from 6a; `rows` synchronous and pure, chunks of 100, writing changed columns plus
  `$v` through an internal write form (`tx.update` never writes `$v`); `update` one `updateWhere` stamping `$v`; one
  version at a time (a DDL commit recording `version N, migrating`, the data step, `ready`), indexes diffed after all
  versions; resume continues `migrating` skipping rows with `$v >= N`; a `rows` function gets the stored row with
  `json(...)` columns migrated on access.
- **Nullable columns and the `set` form (owner, 2026-10-27; slice 6a spec review blocker 6 and the DSL):** columns
  are non-null by default; a nullable column is L1's `opt(...)` (`note: opt(str())`): in a row an optional field,
  absent when `NULL`, never an explicit `null`. A `put` carries every non-`opt` column (a missing or unknown field
  fails `invalid/args`). Queries follow SQL's rules for `NULL` (a comparison with `NULL` never matches, `ne`/`not`
  included; ask with `isNull` or `or(isNull(...), ne(...))`), on every backend. Keys, index columns and `orderBy`
  columns must be non-null (types and `defineTable`), so cursors are total. `alter` adding a column: `opt(...)` or a
  declared `default`. The `set` of `update`/`updateWhere` is a plain object of values (`{ note: "fix" }`) or a callback
  getting typed column references (`(e) => ({ hits: add(e.hits, 1) })`), like `where`; `col()` and `value()` are gone;
  `undefined` clears an `opt` column. The semantics the reviewers listed (simultaneous evaluation of a multi-column
  `set`, integer arithmetic and overflow, `replacePrefix` without the prefix, empty and U+10FFFF prefixes, `inArray([])`
  and long lists bound as one JSON parameter, `when`'s condition, default order and key tie-breaks, one evaluator for
  `where` and `set`) are specified in the 6a spec; no separate DSL review (owner: the spec review is enough).
- **Restricted names instead of assigned table names (owner, 2026-10-27; slice 6a spec review blocker 5):** names
  that become SQL names are restricted at declaration (and checked on import) instead of being mapped. Host kinds,
  object types (every contract, not only stores) and table names use npm package-name characters `[a-z0-9@/._~-]`,
  lowercase only (SQLite compares identifiers case-insensitively), so plugin-prefixed type names (`@pi/file-history.store`)
  stay valid; the separator is `:`, which they cannot contain, so the rendering `"session:@pi/file-history.store:edits"`
  is injective (`a/b` + `c` and `a` + `b/c` differ) and readable in `sqlite3`. Index names `[a-z0-9_]+`, rendered
  `<table>:<index>`. Column names `[A-Za-z_][A-Za-z0-9_]*` (camelCase allowed), two columns equal ignoring ASCII case
  refused at `defineTable`, no `$` (the hidden `$v` and `<column>$v` cannot collide). Import is a trust boundary: every
  name in an archive is checked against these rules (no `"` can occur: quoting is always safe), every row against its
  table's recorded columns, the parts against one compiled `ArchivePart` schema; a failure refuses the whole import.
  Rejected: physical names assigned by the store (`t1`, `t2` with a mapping table: unreadable, owner), escaping logical
  names into physical ones.
- **`runCounted` in `chord/sqlite` (owner, 2026-10-27; slice 6a spec review blocker 4):** `SqliteExecutor` gains
  `runCounted(sql, ...params): Promise<number>`, running one statement like `run` and resolving with the rows it
  inserted, updated or deleted (SQLite's `changes()`: index writes and trigger rows do not count); `run` stays
  `Promise<void>`. The store uses `runCounted` only where a count matters (bulk writes' `count`, the engine's
  conditional `UPDATE`, single `update`/`delete`). Node takes it from `StatementSync.run()` (free); the Durable Object
  driver reads `SELECT changes()` after the statement, because the cursor's `rowsWritten` is Cloudflare's billing
  count and includes index writes (verified in workerd 2026-10-12: an insert with two indexes 3, a 10-row bulk update
  20, `changes()` 1 and 10). Measured in workerd: `SELECT changes()` costs about 1.5 µs per statement and reads or
  writes no billed rows, so making every `run` count would nearly double a small write on Durable Objects for callers
  that need no count (Durable's `SqliteStorage`): hence a separate method (option 2, owner). Name `runCounted`
  (owner). pi `8025c414d` (upstream first), with a real Durable Object test in Durable's workerd suite.
- **Store errors: Durable's rule (owner, 2026-10-26; slice 6a spec review blocker 3; **superseded in part** by "Slice 6b
  D4: the store has Durable's Storage semantics": a step failing before `COMMIT` rejects only its commit):** any backend error in a commit
  step is `storage_failed` (the store stops, every later commit and read rejects `unavailable/storage_failed`, a new
  reason in the protocol list; the host closes; `onError` once), as Durable's `GuardedStorage`: the SQLite facade cannot
  tell a failed statement from a failed `COMMIT`, and what reaches the step is a real storage problem or memory and disk
  disagreeing. Plugin mistakes never reach the step: they are refused when the write is staged (`invalid/args`). A
  commit refused by the seal fence is rejected `released` before `BEGIN` and is no error of the backend. A backend
  error on a read is `storage_failed` unless the read's `ctx` was aborted (`aborted`); invalid arguments are checked
  before the backend (`invalid/args`). An `adopt` that throws is `storage_failed` (owners never throw from it).
  Accepted: integer overflow past 2^63 in a bulk `add` is fatal (a `STRICT` integer column refuses SQLite's REAL).
  Supersedes the 6a spec's "an error before `COMMIT` returned rejects that commit".
- **A live object can fail (owner, 2026-10-26; slice 6a spec review blocker 7):** a runtime failure of the owner (a
  `migrate` that fails on access, a stored version newer than the code) seals its live attempt (the seal fence) and
  makes the object `failed` with a `broken` cause: calls on it reject at once with the cause, its state members keep
  their last values and get no frames, its natives close, its documents stay on the object (the failed data intact in
  the store), `onError` gets one report (the kind is settled in the 6a spec; `object_failed { object, cause }`
  proposed); recovery only by a reload or `ref.retry()` (a new attempt; only the failed load is redone). Nothing
  cascades: dependents that are live stay live (§6), only their calls into it fail.
- **A native restart drains first (owner, 2026-10-26; general-model discussion):** when a reload restarts an object
  with natives, new calls park, the running calls are awaited (the drain, bounded by `closeTimeout`), then the natives
  close (reason `reload`), the new factory runs and the natives reopen; only a call that outlives the drain is cut off
  by the seal fence. Supersedes §21's "running work ends `aborted`" for calls (running job runs: slice 7 decides with
  the job ownership change). The general-model discussion is closed with this entry (owner: "model discussion done").
- **Keyed state members, `local` contracts only (owner, 2026-10-26; reviews
  `/tmp/keyed-members-review-{astra,fable,opus,sol}.md`, all four for A):** the gap: across objects live state travels
  only as state members, one value per object, so a view with params (`NoteView { session, id }`) could not follow one
  keyed document of a persisted store (P3 keeps persisted data in `local` objects with empty params). A contract member
  may be `keyed(schema)`, a third member kind (part of the fingerprint), only in `local` contracts (`remote()` refuses
  it): a provider returns a keyed document handle for it (in memory or persisted) or re-exposes another reference's
  keyed member; a consumer on the same host takes `ref.member.at(key)` in its factory (only there: a counted pin on the
  provider's per-key source while the consumer lives, loaded before the consumer goes live and never evicted while
  pinned) and `ref.member.watch(key, ctx)` / `get(key, ctx)` anywhere (`watch` on an absent key gives `undefined`). An
  absent key reads `initial()`; a retirement arrives as the `retired` flag; a key whose `migrate` fails breaks the store
  (6a's keyed rule). Nothing on the wire changes: tabs and other hosts hold the view, an ordinary remote object with
  singleton members. A derive over a retired source carries the `retired` flag on (a reader's redacted member learns of
  the deletion). Versions of keyed members are mapped per key in slice 7 (`"refuse"` only for removed ones). Rejected:
  B (persisted `local` objects with params: one object per entity, nothing lists or retires across them). Kept for a
  real case: keyed members across links (Fable's design: keyed entries inside a hold's `bound`/`state`, a `keys { hold,
  add, drop }` message, re-holds carrying their keys; or Sol's selector holds), as a later slice. Option C (a singleton
  map plus a lookup derive, p2's `DraftStore`, `Status`) stays for small collections (§12 cookbook). Built in slice 6a
  (about 300-350 lines), which already builds the per-key source behind `handle.at(key)`.
- **The seal fence (owner, 2026-10-26; the fence review `/tmp/fence-review-{astra,fable,opus,sol}.md`):** leftovers of
  an ended or replaced attempt (handlers past the drain, queued commits, routine calls, watch deliveries) are cut off
  by one token per attempt, and one per job run invocation for its state changes and outcome. (1) Sealed handles:
  after the seal, new work through the attempt's handles is refused at use with `released` (`self.tx`, `ctx.get`,
  which checks the abort signal first, a job start, a routine start); the attempt's references stay usable for its
  own natives' closes, then are released. (2) Commits are checked at two points: when they enter the store's commit
  step (sealed: rejected `released`, nothing written; not a storage failure) and at adopt (admitted while current,
  sealed during the SQL: durable, adopted into the object's documents, staged job changes of the sealed attempt
  abandoned); in-memory commits are checked inside the batch. (3) At the seal, a transaction of the attempt that has
  not entered the step yet is aborted and the object's line released; a step already started finishes before the
  attempt's teardown completes. (4) Cleanup still runs after the seal (releasing what stuck calls hold, `ctx.get`
  references, presence entries, `host.activity` counts), so a stuck handler cannot keep a worker busy forever. The
  existing start guards stay (an old activation finishing after the object ended, `Job.#invoke`, a `ctx.get` resolving
  after its call settled). Unit: the attempt (every way an attempt ends already goes through `Attempt.seal`); a pure
  swap is not a replacement (the same attempt continues), so a stuck old routine call past the handover is fenced per
  routine invocation (slice 7). Natives' effects outside Chord are the plugin's; their `close` is honoured, and their
  writes to Chord state go through transactions and are fenced. Cost: one boolean read per commit at one (in memory) or
  two (persisted) points. Replaces slice 6a's per-path rules ("`adopt` of a dropped handle is a no-op", race 4, staged
  job runs adopted after `Job.end()`); `Documents.seal`/`assertWritable` become the token's check.
- **Job runs belong to the object; singletons stay resident (owner, 2026-10-26; the four fence reviewers'
  follow-ups):** (1) A job's records, keys, active count, `running`, run state documents and pending actions belong to
  the object (per job name), with its documents; the attempt keeps the job's implementation (`run`, `finish`) and the
  running invocations (its drain, its seal). A run's state changes and its outcome are fenced by the run's own
  invocation, not the attempt; `finish` runs on the object's current live attempt (a finishing run waits for one); a
  run whose job the new code no longer declares stays `blocked`. Why: with runs per attempt a native restart breaks key
  dedupe (a run can start twice), `concurrency` (undercounts), `running` (loses its runs), the state documents (a dead
  attempt's cleanup would clear them) and §15's rule that the current code finishes a run aborted by a restart. Open
  for the spec: whether a run waiting for a live attempt keeps a `broken` object alive (proposal: it counts only while
  an attempt is live or activating). (2) Persisted singletons and `at(key)` documents stay in memory while their object
  lives; only keyed persisted documents are evicted. Why: `handle.value` is a synchronous read (methods, derives,
  snapshots for new holds), so the value must be in memory when read; an evicted singleton would need an async read,
  as keyed documents have. Memory is bounded by the number of declared singletons, one value each; data that grows
  belongs in keyed documents or tables.
- **Documents and the line belong to the object, not the attempt (owner, 2026-10-26; general-model discussion after
  the slice 6a spec reviews and the fence review `/tmp/fence-review-{astra,fable,opus,sol}.md`):** an object (one
  identity) owns its documents (in memory and persisted, their trackers) and its line for its whole life, across
  retries, failures and native restarts; an attempt (one try at activating the object: factory, references, natives,
  members, derives, routines) keeps only what belongs to one try: its natives, routines, derives and its seal token.
  A new attempt's factory gets handles to the same documents (`self.state(def)` by name). Persisted documents load
  once per object, and again only after a load failed (a `migrate` that needs fixed code). In-memory state survives a
  failure and retry too; ending the object clears it. Why: per-attempt documents let a late commit of a dead attempt
  leave the next one on a stale base (the review's race), contradict §9 ("in-memory documents survive native restarts
  of a live object"), and were an accident of slice 2 (each activation a fresh instance, documents created inside it).
  Built with slice 6a (carry-over), which needs it; replaces slice 7's carry-over "run records and state documents
  belong to the object across attempts (documents belong to an attempt today)" for documents. Decided the same
  day: the seal token's rule ("The seal fence") and job runs ("Job runs belong to the object").
- **Writes carry their versions; archives are lossless (owner, 2026-10-26; spec review blocker 1, all four reviewers):**
  every `put` write carries the row's `$v` and each `json(...)` column's version explicitly, in the outbox and in
  archives alike (`{ kind: "put", table, row, v: 3, columns: { meta: 1 } }`); the applier never infers a version from
  the table definition (an archive's `table` write has the current version while cells may be stored at older ones; an
  inferred stamp would label an old shape current, and an export runs no plugin code, so it cannot migrate). A `table`
  write carries the table's `state` (`migrating` | `ready`), so an export between migration chunks imports as
  `migrating` and resumes. A `document.create` carries the record's stored version and fingerprint; for
  `history: "latest"` its base is the current value (base plus deltas, as a load gives it); for `history: "full"`
  (Durable, 6b) the archive carries every revision with its seq, retired `full` records included (format 1 defines the
  fields now, 6b builds them); retired `latest` records stay out. Supersedes in part "Export archives are operations"
  ("a `document.create` per live document record (with its base)", "Retired documents … are not in it").
- **Slice 6a's three code questions (owner, 2026-10-26):** (1) keyed reads take a context: `handle.get(key, ctx)` and
  `handle.keys(ctx)` for every keyed handle, in memory too (one signature; persisted, they read the store; "Contexts
  are required"). (2) The activation attempt's `readyTimeout` deadline does not run while an eager migration step runs
  (a `rows` step over 10M rows takes longer than 60 s; the scan resumes after a crash anyway); getters still time out
  by their own `readyTimeout`. (3) A host without an address uses `client` as its host kind in store addresses (owner
  strings, table names), so a browser tab with sqlite-wasm can have a store later.
- **The commit-step benchmark (owner, 2026-10-26; S3's condition "SQLite must not get slower"):** in 6a
  `test/next/bench/store.ts` measures the store without outbox against Durable's `SqliteStorage` per commit on (a) a
  commit of one document delta, (b) a commit with one table `put`, (c) 1,000 commits back to back, in bursts (median
  and p95 over several runs) with memory after GC; each must be no slower. The outbox's extra cost per commit is
  reported separately. A failed gate goes to the owner with numbers and options before the build continues. 6b repeats
  the gate with `StoreStorage` on Durable's own storage benchmark.
- **The outbox is optional, internal and versioned (owner, 2026-10-26):** supersedes in part "The store" and S1/S5 where
  every commit writes the outbox. (1) A store has an outbox only when opened with one, `openStore(backend, ctx,
  { outbox: true })`; the setting is persisted in the store's metadata. Without it the commit step writes data and
  `lastSeq` only (tests, web tabs, a server's instance store, a session before sync). Turning it on records "outbox from
  seq N+1" and the sync layer starts from an archive at N; turning it off drops its commits (a later start needs a
  snapshot again). Opening with the other setting is an explicit switch with these rules, never a silent gap. (2) The
  outbox is a table in the store's own backend, written in the commit step's backend transaction: SQLite commits data
  and outbox atomically even with `synchronous=NORMAL`, for one `INSERT`. An external outbox would work only as Durable's
  JSONL storage commits across files (outbox entry first, SQLite `COMMIT` as the commit point, recovery cutting entries
  above `lastSeq`), only for a local, truncatable outbox (never Radius: an uploaded entry cannot be taken back), and only
  with an `fsync` of the outbox before every `COMMIT` (otherwise a power loss keeps the commit and loses its entry, which
  no pull-back recovers); can be retrofitted later if needed (owner). (3) No pluggable outbox encoding: the store keeps
  commits as it likes and exposes them typed, `store.outbox.read(afterSeq, limit, ctx)` -> `{ seq, writes }[]` and
  `store.outbox.trim(throughSeq, ctx)`; the sync layer encodes for the wire. (4) Versioned on two levels: the outbox
  table's layout is part of the store's schema (the store's own migrations at `openStore`); the write vocabulary has a
  `format` number, the archive manifest's `format`, stored per outbox commit (`outbox(seq, format, writes)`);
  `outbox.read` hands out the current format (older commits through the store's pure step functions), a newer format
  than the code is refused with the data intact, and batches and archives carry it. (5) The benchmark gate (S3) is
  measured without the outbox; its cost per commit is reported separately. Replaces the sync-layer carry-over "outbox
  growth without sync".
- **Writes, commits, batches, archives (owner, 2026-10-26):** the names of what the outbox, sync and export carry. A
  **write** (`StoreWrite`, tagged by `kind`, Chord's rule for tagged unions) is one change of the store: `put`,
  `update`, `delete`, `updateWhere`, `deleteWhere` (with `count`), `table`, `alter`, `rebuild`, `index`, `dropIndex`,
  `document.create`, `document.change`, `document.retire` (as Durable's `StorageWrite`, "one record or document
  mutation in an atomic storage commit"; S17's "five writes"). A **commit** is the writes of one seq as the outbox keeps
  them (`{ seq, writes }`); a **batch** the commits `from..to` that sync uploads and a replica applies; an **archive** a
  manifest, the writes from 0 to `lastSeq` and an `end` (its parts are `ArchivePart`). Not "record" (document records,
  run records, Durable's records), "op" (Delta ops inside document changes), "entry" (Durable's conversation entries)
  or "change" (`WatchChange`, Delta's `Change`). Earlier entries' "outbox record" reads "the outbox's commit" and
  "operation" reads "write"; the book's `op:` tags read `kind:`. `StoreStorage` (6b) turns Durable's `StorageWrite`s
  into `StoreWrite`s.
- **The `json(...)` column helper (owner, 2026-10-26; slice 6a point 8):** `json(schema, { version, migrate? })`.
  The schema is required (reads are typed from it; a migration's result is checked against it once, R8; written values
  are not walked, R9); `version` is required, as for `defineState`; `migrate(old, from)` is optional and pure: without
  it, or when it throws or returns an invalid value, reading an older value is refused, the data stays intact and the
  owning object fails `broken` (R8, R15). New: each `json(...)` column's version and schema fingerprint are recorded in
  the table definition (the `table` write); at activation, the same version with another fingerprint fails the object
  `broken` (D9; one comparison per column per activation, none per row). A read does not write back: an old row pays
  the migration and the check on every read until its column is written; an eager `rows` step rewrites a table at once.
- **Facets only declare (owner, 2026-10-26: "remove facet routines, everything done through objects seems sensible"):**
  facet routines (`self.on`, `self.onLive` in `FacetSelf`, added in slice 5 because §16 listed routines) are removed
  with the documents. A facet's setup declares only: `host.serve`, `self.contribute` (slice 8), `host.references`;
  no natives, documents, routines or jobs, so a facet has no runtime behaviour and cannot fail after `load`. Without
  documents a facet routine owned nothing it could write and acted only through other objects' methods; standing
  behaviour belongs to the object whose state it reconciles. p2 already works so: all 63 facets are
  `defineFacet((host) => …)` with no `self`; its routines and loops live in host-lifetime objects. Built in slice 6a
  (carry-over): the routines in `FacetSelf`, their start in `host.ts#setUp`, their drain at close, tests, the facet
  part of example 18.
- **Relays do not check answers (owner, 2026-10-24; second 4b review):** supersedes the third fix-round choice. A
  relay forwards answers from upstream (`bound`, `state`, results) unchecked and unparsed; the end that parses a part
  checks it against its own link's limits. Reason: the relay's check had to release the hold upstream and hold it
  again with the same id on `retry`, and an old `state` or `gone` still in flight then looked like the new hold's
  (reproduced by three reviewers). The relay still checks everything arriving from downstream. A reference failed
  `too_large/part` leaves its path (a reconnect does not hold it again) until `ref.retry()`; this lives only in the
  consumer's memory.
- **Slice 4b fix round (owner, 2026-10-24):** the builder's five choices accepted and folded into design.md: call
  arguments sent up a parent link are never compressed (a host cannot tell whether its parent sees it as a child or a
  route); `revoke` goes on route links before revoked child links close (worker objects end `forbidden/revoked`, not
  `released`); ~~a relayed answer over the route link's wire limit fails its call, or releases its hold upstream and
  sends `loading` and a broken `failed` downstream (`retry` re-holds with the same id)~~ (**superseded** by "Relays do not check answers"); compressed hold params are a
  protocol error on every link; the asynchronous inflate runs one part at a time (its queue is bounded by the parent's
  or route peer's window; a misbehaving one of the app's own hosts is accepted). No extra performance regression tests
  (cost guards, GC tests and manual benchmarks suffice). A second, non-pedantic review (correctness and performance)
  before the commit.
- **Slice 4b review decisions (owner, 2026-10-24; reviews `/tmp/s4b-review-{astra,fable,opus,sol}.md`):** (1) a
  dependency failing with `invalid/cycle` makes its dependent broken (exception to R18). (2) Cycles that enter an
  already activating object (simultaneous starts) are a documented limitation: they time out transient and retry; no
  probe message. (3) Child links refuse compressed parts (protocol error): clients never send them, and a small part
  could inflate to 64 MiB on the server; asynchronous inflate then happens only on a host receiving from its parent.
  (4) The text codec tags every part, so no JSON value is reserved for compression. (5) A departure discovered while a
  batch is sending lands in the next batch (one commit stays one message per link). (6) Presence `origin` is one rule:
  the caller's incarnation, also for `ctx.get`. (7) Revocation's error is `forbidden` with a new reason `revoked` (a UI
  can say "access revoked"; the protocol table changes, version stays 1 until p3 ships). (8) Compression details: a
  tagged adapter result (too large or corrupt), compression also on IPC, `./next/node` export later, hold params never
  compressed. (9) `host.references` keeps a type's list from its first ask (entries come and go with references).
  (10) Instance ids on restart are slice 7's (carry-over). Revocation propagates over route links; the decoded limit is
  stamped on holds only (design §4, §22 aligned).
- **Slice 4b to building (owner, 2026-10-24):** `slice-4b.md` revised for flow control per origin goes to a builder
  directly; fresh reviewers (Astra, Fable, Opus, Sol) review the build; the owner then decides the open points the
  spec marks as proposals (a cycle error makes the dependent broken; compression as built; `host.references` lazily
  per type). Compression is built as option (b) (owner leaning, decided after the build): hosts with a synchronous
  compressor compress parts above 16 KiB at their origin; browsers send uncompressed and inflate asynchronously with
  `DecompressionStream`, holding later messages of the link in order (bounded by the window and N; acks after apply).
- **Slice 4a approved (owner, 2026-10-24):** `packages/chord/docs/next/slice-4a.md` as revised after the reviews. Build
  order: the pending queue in Chord's shared code first (pi, upstream), then the slice by a fresh Opus builder (`s4`).
- **Slice 4a review decisions (owner, 2026-10-23; Astra's and Fable's spec reviews, `/tmp/s4a-review-*.md`):**
  supersedes in part "Slice 4 split and first decisions" (resets as `r` ops). A `hold` carries the address the caller
  computed; relays route by address and never need the contract or parse params. A `hold` carries `principal?` and
  `incarnation?`, honoured only on the parent link (calls inherit their hold's, so calls carry none; refines R1/Q13
  "hold and call"); a reference made on a host sends its maker's principal over route links (`ctx.get` in a guest's
  handler acts as the guest); upward, a server ignores a child's fields (a worker acts as itself; documented
  boundary). Resets deliver full bindings: `bound` carries a list of holds (`bound { holds: [...] }`, one batch), a
  `bound` on a bound hold replaces its replicas (another variant allowed; moved from slice 7 to 4a); overflow stays an
  `r` op. A provider answers `reset` through its pending path (never exceeding K). A relay recovers per (downstream
  link, upstream link): once something from U cannot reach D, everything from U to D is dropped, and the next free slot
  requests one reset of every hold D has on U; an answer that finds no slot is requested again. Heartbeat: one
  `lastReceived` timestamp per link and one host timer; the 30 s silence covers the handshake. Transports: a connecting
  WebSocket buffers; IPC `send() === false` is backpressure. A hold from the parent is never routed back to it.
- **Slice 4a spec decisions (owner, 2026-10-23; `packages/chord/docs/next/slice-4a.md`):** a heartbeat on every link
  kind, in the protocol layer (`ping`/`pong`; a side that received nothing for 15 s pings, a link silent for 30 s
  closes; host options with these defaults); supersedes design §3's "heartbeats are the adapter's policy". The text
  codec may carry relayed links (one parse per part per hop, accepted for a debugging codec). `resolve(address,
  context)` takes a Context. Upstream reconnects at a relay are `loading` downstream, then the new `bound` (3b's
  re-hold path, another variant allowed); flow-control resets stay `r` ops.
- **Compression at the origin (owner, 2026-10-19):** a JSON part above a threshold (e.g. 16 KiB) is compressed once
  at its origin, whatever the link; byte segments stay raw; relays forward it compressed; IPC carries compressed parts
  too. No per-link compression.
- **R6 and contract compatibility (owner, 2026-10-18), strict, like documents:** a hold carries only the consumer's
  contract version and fingerprint, never a description. The provider binds when they equal its current version and
  fingerprint, or an accepted old version's fingerprint, computed from the provider's own old schemas. Every contract
  change, additive ones included, bumps `version`. (**Superseded in part** by Q10: forward evolution in code and
  `checkAccepts`; old versions come from the materialized history, not from copies in `accepts`.) `accepts[v]` carries the provider's own copy of version v's member
  schemas plus value mappings: old arguments are validated against the provider's old schema, then mapped (state:
  new to old; methods: old arguments to new, optional result mapping back); an additive change needs the old schemas
  and no mappings. Anything else is `contract_mismatch` (or `updating` during a rollout). Consequences: no
  descriptions on the wire (the `describe` message kind of R1 and the per-link description cache go away), R3 is moot,
  the coverage check across fingerprints of one version is gone.

## Portability boundaries in the kernel

From `research/chord-on-durable-objects.md`, adopted for the Chord v2 kernel because they cost little and help tests:

- **A host is a logical identity plus an incarnation**, not an OS process.
- **The loader is a host adapter:** the kernel also accepts facets imported ahead of time (static composition, as on a
  Durable Object or in tests); loader D is one adapter.
- **Values are JSON plus bytes, defined independently of the transport;** (**superseded in part** by Q4 (IPC carries the same binary message, V8-serialized bytes)) IPC structured clone and WebSocket binary
  frames are carriers, not the definition.
- **Durable plugin state:** whatever must survive a host teardown (a DO eviction, a crash, a restart) is a persisted
  document written in transactions (`DocumentStorage`). Everything else is rebuilt on activation: in-memory documents,
  natives, derives (`previous` is a cache), routines, presence and references (re-held by clients); job runs end
  `lost` unless their records persist.

## Object kinds

- **`local` stays** next to `remote` (owner, after the plugin scouts judged "one kind only"; all four would have
  accepted it with conditions).
- **`local` means:** (**superseded in part** by R7 (validation for every caller; `local`'s exception is Q15, open) and R9 (no dev freeze)) same host, no validation, no copy, no principals; plain data only; **no `opaque`, no callbacks**
  as arguments. Behaviour goes through registries, multi-step work through jobs, input through flows (or Questions),
  runtime services through host values (**superseded:** host values were removed; runtime services are core objects,
  "Hosts and placement" and "Review round 1"). Without a copy caller and object share values: neither may mutate arguments
  or results (the playground freezes them in dev mode to check).
- **Kernel semantics decided while building step 2:**
  - `local` factories are `(input, self)`; a local method's `ctx` has no principal; references a local object makes
    run as the host principal; attribution is passed as data.
  - ~~Calls on `remote` types validate and copy arguments and results also on the same host.~~ **Superseded** by "The
    state path": same-host calls pass values by reference; arguments are validated only for callers that are not
    host principals, at the provider.
  - (**superseded in part** by R9 (no dev freeze)) `Uint8Array` leaves are never copied in process (shared, immutable by convention); the dev freeze of `local`
    values freezes objects and arrays only. Transports carry bytes raw (IPC structured clone, WebSocket binary
    segments), never base64.
  - (**Superseded** by Q12: unknown fields are rejected.) Undeclared argument fields are stripped as in today's Chord: the consumer strips to its schema, the provider to
    its own, then validates; a handler receives exactly its declared shape (additive rule; no mass assignment).
  - A failed reference stays alive: `ref.state` is a tagged value (`loading`, `live`, `failed` with `cause` and
    `retryAt`, `released`); while held, Chord retries per the per-address backoff; `ref.retry()` tries at once; calls
    on a failed reference reject at once. Calls park on link drops, loading or restarting objects and rollout
    `updating`.
- **Pattern: shared core, per-principal views** (confirmed; renamed "shared store" in "The state path"). Identity stays (type, input, principal key): the
  factory receives the principal and builds its variant and principal-specific state (e.g. a read-only guest's
  filtered view). Heavy or shared parts (a Durable watch, a prompt watcher, a sandbox, a store) live once in a
  `local` core object (no principals: one per (type, input) on the host; no copy); per-principal remote objects
  `self.get` it and derive their view from it. Same for stores that serve different views per principal.
- From the scouts' review of "one kind only", still valid for `remote`: same-host state as immutable snapshot plus
  deltas (never a full clone per change); bytes transferred, not cloned; real schemas instead of `Type.Unsafe`; double
  copies through facade layers are fixed by merging owners.

## Reload

- **Per host:** load (bundle; a load error rejects) → staging (run the facet setup and every live object's new factory
  with a recording `self`, declarations only, nothing activated; a throw rejects) → commit (atomic) → after.
- **Rollback is all-or-nothing per host:** any load or staging error leaves the host entirely on its previous code.
  A host is completely at revision R or R−1, so status per host suffices.
- **Pure objects** (**superseded in part** by R15 (old code touching a document migrated past its version throws)) (no `self.open`, old or new) are swapped in place: new methods and derives; documents, references
  and jobs stay; routines restart serialized; new references become live; then the object's gate opens. Running calls
  finish with their old code.
- **Native objects of the plugins in the reload restart:** running work in them is aborted (outcome `aborted`),
  natives close, the factory runs, natives reopen. ~~No per-module digest: if a native is expensive to restart, the
  author splits it into its own plugin.~~ **Superseded** by R16 (restart patterns: drain in the background, swap
  through a registry). An open that fails makes that object `failed` with backoff; the rest of the
  host runs on the new code.
- **Remote consumers** of a restarting object see what they see for any object that briefly goes away: `loading`,
  values readable, calls park, re-hold; calls running on the old instance end with an error.
- Rollback covers code errors (load, setup, factories); activation errors (opens, new references, migrations) stay per
  object; a bug in a method fails that call.

## API additions

- `self.derive(name, sources, (values, previous) => …)`: `previous` is the derive's last value, kept across factory
  re-runs by name.
- `job.start(args, ctx, opts)` returns a run with `outcome(ctx)`: the caller can await the outcome; the caller's abort
  ends only its wait, never the run.
- Jobs stay as designed (intent / run / finish). Jobs as objects with an "until done" lifetime are an option for later.
- **Bytes are a schema type** (**superseded in part** by Q4 (IPC carries the same binary message)) (`Uint8Array`), transported natively: structured clone on IPC (`fork` with
  `serialization: "advanced"`), binary frames on WebSockets. No base64 in JSON. (Today an IPC payload is JSON, deflated
  and base64-encoded; a 1 MiB chunk of compressed data grows by a third or more.)
- **Large transfers are chunked by the owner, not by Chord:** the owning object offers `begin` / `append({ upload,
  offset, bytes })` / `finish` and `read({ id, offset, length })`, chunks of about 1 MiB. Each side holds one chunk;
  the awaited `append` is the backpressure; after a link drop the writer asks for the stored offset and resumes; an
  unfinished upload is removed after a timeout by the owner. A small helper wraps the loop. Chord gets no stream type
  (it would need its own rules for link drops, cancellation, relays and restarts); reconsider only if many owners
  repeat the protocol.

## Registries and HTTP

- **Registries work like Durable's** (option c): (**superseded in part** by R21 (only facets and `lifetime: "host"` objects contribute) and "Changing contributions, `self.writable`") each contributor (a facet or an object, by its identity) contributes
  at most one value per registry; the table is an immutable, ordered list of `(contributor, value)`; Chord has no
  generic keys and no `conflict` flag. The owner composes the table (in the registry's `compose`, below) and decides
  conflicts and order (**superseded:** composition runs at runtime and reports conflicts, D1 in "Review round 1"). Chord ships helpers for the common compositions
  (`keyed(...)` with a conflict rule, `ordered(...)`). Several contributors (model providers, environment kinds) are
  the owner's composition, not a special case; selection (which contributions apply where) stays possible.
- ~~The composition runs in staging and a conflict rolls the host back.~~ **Superseded** by D1 ("Review round 1"):
  `compose(table, { report })` runs at runtime, always delivers a value and reports conflicts.

- **Registries may carry natives.** An entry lives exactly as long as the object or facet that registered it; the
  table changes when it goes away. Consumers look up at each use or follow the table and keep nothing from an entry
  beyond a use (a pinned Durable phase holding an old table is fine). Natives reach other plugins only this way: no
  `opaque` members, no natives in method results. What a native's old value does after its owner restarts is the
  owner's `close` (a model runtime keeps working until collected; a closed SSH connection fails its in-flight `exec`).
- **HTTP is an optional Chord component** (`@earendil-works/chord/next/http`): a route gets a plain request summary
  (method, path params, query, principal, selected headers; parsed and capped JSON bodies; uploads handed over in
  chunks) and returns a response description (`json`, `page`, `bytes` with `size`, `mime` and `read(offset, length)`,
  `redirect`, `error`). The component does ranges (206/416), HEAD, download headers, streaming, abort on disconnect and
  the CSP nonce once, instead of every plugin. Request resolvers (who sent a request) are a hook taking the summary.
  A **channel component** provides WebSocket byte channels (`send`, `onData`, `close`) for terminals.
- **HTTP routes and wraps (middleware):** a contribution holds `routes` (pattern to route) and `wraps`. Routes are
  composed with `keyed` (two contributors with one pattern: a reported conflict, D1). Wraps run in **phases the owner defines** (e.g.
  `observe`, `headers`, `transform`; outermost first), within a phase in contributor order; no numeric priorities
  (plugins have no single registration order, unlike Express or Hono; Fastify's lifecycle phases are the model). A wrap
  applies by default only to its own contributor's routes (`scope: "own"`, Fastify's encapsulation); `scope: "all"`
  is explicit; `route` narrows it to one route, and a `route` that does not exist is a reported conflict (D1). Wraps
  may add a security boundary on top of the owner, never instead of the owner's own checks. A request uses the router
  as it was when the request started.

## Durable harness inputs

- **`HarnessOptions.models` and `settings` accept a function** (`() => Models`, `() => HarnessSettings`), like
  `env`; a plain object is still accepted. Internally both are stored as functions; generation, hooks and tools get
  the function's current return value. Replaces p2's `Proxy` around the registry entry. Done in pi main first, then
  merged into `private`.
- Models and environments reach the harness through registry entries (functions) registered by the objects that own
  their natives; the `Harness` object opens Durable itself (no host value) and looks the entries up at each use.

## Input into running work

- **Questions (`questions.md`) is one possible pattern, not the required one.** Another: the owner of a flow keeps it
  as state keyed by a uuidv7. Example login: `start({ provider })` returns an id; the flow's live state holds the
  current step (`{ id, kind, ... }`), notices and status; `answer({ id, step, value })` resolves the waiting step (a
  late or second answer to a step that is gone gets "no longer active"); `cancel`. The client watches the state, so no
  `next()` is needed. pi-ai's promise-based `prompt` callback stays inside the owner (the job keeps the resolver);
  nothing crosses an object boundary. Open: the flow as a keyed document of `Login`, or an object `LoginFlow {id}` that
  lives until done ("jobs as objects").
- **Imperative consumers get a client helper over the same flow state,** (**superseded in part** by design section 20 (flow state is tagged by `kind`, not `status`)) not a second server protocol. Tests,
  scripts, a CLI or an agent tool loop over the steps; the web UI watches the state; both see the same steps:

  ```ts
  async function* steps(flow, ctx) {            // generic: any flow with { status, step?: { id, ... } }
    let last = 0;
    for (;;) {
      const s = await until(flow.state, (v) => v.status !== "running" || (v.step && v.step.id > last), ctx);
      if (s.status !== "running") return s.status;     // done | failed | cancelled
      last = s.step.id;
      yield s.step;
    }
  }

  const { id } = await login.start({ provider }, ctx);
  for await (const step of steps(await ctx.get(LoginFlow, { id }), ctx))
    await login.answer({ id, step: step.id, value: answerFor(step) }, ctx);
  ```

  Why not a long-held server `step()` call: a link drop fails it and the consumer cannot tell whether it missed a
  step; the helper reads state that re-holds by itself, and `last` keeps steps from being lost or repeated. The
  same shape fits login, tool approval and a question from the agent.

## Ownership principle

- **Every thing has exactly one owning object: the smallest object it belongs to.** The owner holds its data
  (documents), enforces its rules (in its methods) and offers the operations others need. Nobody reaches past the
  owner into its data, writes its files or documents, or attaches rules to it from outside.
- Ownership nests: the session owns the set of its conversations and its location (creation, relocation); each
  conversation owns its content and rules (read-only, follows the session cwd) and enforces them in its own methods.
  Rules set at creation are written in the creating commit (Durable `createConversation` with `init`).
- Methods return data, never objects; an object is handed out as its address, and the receiver gets it with
  `ctx.get(Type, address)` (identity, lifecycle and principal stay with Chord).
- Registries are extension points that add behaviour (tools, routes, renderers, commands, send routers, input gates);
  they never guard owned data.
- Core owners are always present; a plugin owner may be missing (optional dependencies are registries owned by the
  dependent, "Cuts and closed deferred points").
- Risk to avoid: a core god object. Each core owner owns only what belongs to it.

## Porting guidelines

- **What core enforces on data belongs in a format core owns,** written by the plugin when it creates the data; a
  plugin's private document is read only by that plugin. Example: subagents/agent mark one-shot and cwd-following
  child conversations in a core per-conversation policy document (`readOnly`, `followsSessionCwd`) in the creating
  commit; chat and relocation read it directly; `ReadOnlyConversations` and `SessionCwdFollowers` go away. (This was
  plugin design, not a missing mechanism: today the rule is lost when subagents is not loaded.)

## Still valid from `target-design.md`

Documents and the store (async `tx.draft`, keys, tags, eviction, Durable's transaction rule), job sandwich, routines
(`self.routines.on/every/loop/custom`), registries (versioned, immutable tables, no late binding), the
Questions service (`questions.md`), retry triggers and `retryOn`, revisions over the complete code set, mismatch rules
during a rollout, start barrier. (**Superseded in part** by R25 (contributions may change; rejected are registries
created at runtime and mutable indirection), R17 (the harness starts after the barrier) and R6 (strict compatibility).)

## Open

Everything else from earlier lists is decided (see the entries above and `packages/chord/docs/next/design.md` §26).

- **Future goal: deploy Chord apps to Cloudflare Durable Objects and similar platforms.** Hot reload there is not
  needed; composition through plugins is (plugin set fixed at deploy). Research in `research/chord-on-durable-objects.md`.
- Deferred until a concrete case: jobs as objects and where a flow lives (when login is ported); project plugins.
- **Every object may contribute** (owner, 2026-10-29: "note it down as something to consider for the future; can be
  changed later without a need for migrations"): lift R21 so objects with params and `remote` objects contribute too;
  the entry lives while the object is live, its identity is the object's (type, params, principal key); `contribute`
  on every `self`. Not decided; R21 stands.
- p3 domain points (decided per domain when p3 is designed): `SessionFiles {session}` (proposed), session delete,
  connection pools, config files with a single writer, file formats as versioned interfaces, the terminal host
  process as a revision artifact.
