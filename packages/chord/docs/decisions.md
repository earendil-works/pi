# Redesign decisions (input for target design v2)

Decisions made with the owner after the plugin review round on `target-design.md` (6559589bd), in the order they were
made. Later entries supersede earlier ones; superseded entries are marked inline and point to their replacement. The target design v2 is `packages/chord/docs/design.md`, written from this log; new decisions land here
first and win until the design is updated.

## Plan

- **p3 next to p2, fully isolated.** The new design is built as a new app (`apps/p3`) with its own data directory. p2
  keeps running unchanged with its data. Plugins are ported to p3 one at a time.
- **No legacy data migration.** p3 starts empty: no import of p2's `catalog.sqlite`, `shares.sqlite` or subagents table.
- **Chord v2 lives in `packages/chord/src/next`** (export `@earendil-works/chord/next`), developed on `private` only
  (owner override of the "pi first" rule for this directory) and upstreamed to pi once stable; then `next/` replaces
  today's Chord and p2 is deleted. `next/` imports `../context`, `../delta`, `../json`, `../output` directly, so
  Durable's `Context`, `Draft` and `JsonValue` are the same modules and types in v2 (no copies, no type conflicts).
  (Replaces "Chord v2 lives inside p3". Now `src` and the package's root: "Chord v2 becomes the package's root".)
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
  it directly; v2's `diff.ts` is removed. Derives reuse today's derived cells (`chord/src/cell.ts`) on top of the
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
  in `packages/chord/docs/benchmarks.md`.
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
  Implemented and reviewed (Fable, Astra: thumbs up) in `packages/chord/src/contracts/` (`7d2bb8ea8`).
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
- **S18, group commit (owner, 2026-11-04):** the commits queued behind a running commit step form one group, which the
  next turn of the commit queue admits at its entry and writes in one backend transaction: each commit keeps its own
  step, seq and outbox commit, the metadata is written once, and after `COMMIT` memory follows commit by commit, each
  adopted when memory stands at it, in queue order, before the next turn (S1 as for lone steps). Fewer transactions are
  always good, and a remote SQLite backend would pay a round trip per statement. A series, an export or a batch apply
  queued after an open group ends it (queue order stays); an empty commit never joins one. A refusal in a group (one
  commit's own writes throw, D4) rolls the group back whole and its admitted commits run again one by one, not admitted
  again, so only the refusing commit is refused; their live queries run again too (`chord.query.runs` counts both
  attempts, the statements only the stored one). The ids the rolled-back attempt took stay unused (D3: the allocator
  is shared with Durable's `mintId`, never rewound; so within a group's worth of ids of `Number.MAX_SAFE_INTEGER` a
  refused group can exhaust the id space a little earlier, accepted). A group that would pass the end of the seq range
  runs its commits one by one, so the ones that fit are stored. A backend failure while the store closes (a commit's,
  a read's, a maintenance write's) still refuses the admitted commits after it. No savepoints (two statements per
  commit, and Durable Objects refuse them) and no check/write split of Chord's writes (their counted conditional writes
  are the checks).
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
  supersedes W4's "JSON plus bytes" for watchables). `mapShared` lives in v2's `watch/` until v2 goes upstream. C10 is
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
  `packages/chord/docs/next/carry-over.md` (later folded into `slices.md`), under the layer that must do them, by whoever defers them, in the same
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
  Plan: `packages/chord/docs/slices.md`.
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
  Explainer: `packages/chord/docs/flow-control/` (Radius artifact 01m5n82vsbe5rtn4nm6wzaq0mp).
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
  Animation: `packages/chord/docs/flow-control/fold/` (Radius 01m5nc9s24e9kscppen2fxgwye).
- **Slice 4 split and first decisions (owner, 2026-10-23):** slice 4 is split into 4a (links and relays: IPC and
  WebSocket links, trusted links, parts as opaque bytes, flow control, host kinds and placement, routes, relayed holds
  and calls) and 4b (revocation, cycles across hosts, `host.references`, `host.activity`, size limits, compression);
  draft with structural changes and races: `packages/chord/docs/slice-4.md`. Decided: trusted links are an
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
- **Simplification pass after 4a (owner, 2026-10-24):** two cutters (Opus 5.5, GPT-6.1 Sol) read all of v2 (`src/next`)
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
  `packages/chord/docs/durable-observers/`):** publication at adoption in Opus's variant. Inside `adopt`, in
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
  recommendation. Rules they settle beyond fixes of the spec: (1) **members across attempts** (**superseded in part** by "References are the only indirection": the reference, not a member source on the object, follows the object across instances): a local object's state
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
  changelog); the decision log moved from `apps/p2/docs/redesign-decisions.md` to `packages/chord/docs/decisions.md`;
  the root `AGENTS.md` carries the "Chord v2 Code Style" section. From now on every slice and every design doc change
  goes to pi first (worktree of `upstream/main`, check, tests, push, CI, merge into `private`); only `apps/` stays
  private.
- **Slice 6b D1: `StoreStorage` and `durableView` live in Durable (owner, 2026-10-27: "they are only used if durable
  is used"):** in Durable's own `src` (an ordinary pi module, now that Chord v2 is upstream), importing
  `@earendil-works/chord/next` (Chord's `./next` export comes with them; now the root export). No package cycle: Durable already depends on
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
- **Slice 7b's build decisions (owner, 2026-10-29, answering the builder; `slice-7b.md` §13):** a loaded plugin passed
  as the same facet object (`===`) is unchanged and untouched, any other facet value for a loaded name is changed;
  activating (not parked) and backoff-waiting objects of a reloaded plugin are retried; the report's `parked` covers
  swaps and retries (their first dependency check), restarts are reported at once; a swapped-out attempt is sealed
  once its calls settled (bounded by `closeTimeout`) and the swap ended, its job invocations finishing on their old
  code; a stuck old routine call is reported `drain_timeout` and fenced by the old routine calls' shared token; a swap
  to another variant sends holds a fresh `bound`; a native restart ends in-memory runs `aborted { reload }` while
  persisted ones follow 6b R3 (stopped, resumed per `resume`, no restart counted); staging is synchronous
  (`installing` tested from a staged factory); a removed object's member sources and pinned keys are handed to the next
  object of its identity (fix round 3: one hand-over per identity for removal, version refusal and an object ending
  while requests wait, `slice-7b.md` §13 item 11); keyed members' versions are built in 7b (L1's keyed edits and an accepts `keyed` section,
  decision "Keyed state members, local contracts only"). The builder's own choice, accepted by the owner (2026-10-29):
  adapted state members are derives per object and version, not per binding. (**Superseded in part** by "References
  are the only indirection": the hand-over of member sources and the per-version sources that outlive an object go.)
- **References are the only indirection (owner, 2026-10-29: "go"; after seven fix rounds of 7b found one edge case after
  another in sources handed between objects):** supersedes in part 6a's "members across attempts" (one member source
  per object and member name) and slice 7b decisions 8 and 11 (member sources and pinned keys frozen and handed to the
  next object of the identity; per-version outward sources owned by (identity, version); `host/handover.ts`). The
  problem: a consumer's watch or derive over `ref.count` was attached to the referenced object's own document or derive
  (the reference was bypassed), so every change of what the reference points at needed a stable node somewhere else
  (`MemberSource` on the object, then sources that outlive the object and move to the next one). The rule: (1) a
  consumer's watches and derives over a referenced object's member attach through the reference's member, which passes
  the subscription straight through to the object's own document or derive (no extra hop on commits). (2) When what the
  reference points at changes (a new object instance after a factory re-run: reload, retry, restart; a new object
  after the type was removed and served again; another variant), the reference moves its subscriptions to the new one
  and sends one frame, a diff from the last value. (3) While it points at nothing, its members keep their last values
  (a pointer, no copy): while loading (a restart, a retry, a swap whose new instance is not live yet) its watches get
  no call; while failed (a live failure, its version refused, its type removed, a failed dependency) one `failed` call
  with the cause's error, and they stay open (replaces 6a's "no frames while failed"); a reference that never had a
  value reads `not_ready` while loading and its failure's error while failed, and its watches wait for its first values
  (a member the new variant lacks fails `invalid/member`, as before). Keyed watches and pins re-pin on each new instance the same way (the
  cross-attempt key sources of 6a go; a key keeps its last value until the new instance loaded it; a dependent's
  factory pin is still loaded before the dependent goes live). Once hydrated, a reference has last values for every state member of its bound variant, read or not: when it
  detaches it takes them at its version from the outgoing instance (through that instance's mapping for an older
  version), keeping no node of it. After a `failed` call, the next good value arrives as `[["r", value]]` even when
  unchanged; a watch opened while failed starts at the last value and gets the failure once. No source, mapping,
  document handle or pin of an instance outlives it through a reference: a detached reference keeps only plain last
  values and its failure; releasing it drops them and its bindings; stopping a keyed watch drops its pin. (4) The same rule over a link: a replica keeps its last values
  readable while its hold is failed. (5) An older consumer (`accepts`) attaches to the object instance's shared mapping
  for its version: per member one derive `(current) => old`, made on first use, dropped when no reference of that
  version is left, gone with the instance (one map and one diff per commit per version, whatever the number of old
  references); a version the instance does not accept gives no member (unbound, last values kept). A reference knows
  its version from the contract token it was made with. Nothing outlives its object instance; nothing is handed over.
  Kept: requests never end on a code change, healing on rebind, `accepts` for arguments and results. A simplification
  audit of slices 6a to 7b follows 7b's commit (owner: "how much other such bullshit was added in the last slices").
  Refined after the gap checks (Astra, Sol, Opus) and the build (owner, 2026-10-29: "i accept the recommendations"):
  a detaching reference follows the old instance until it stops changing (its seal after admitted commits, a restart
  after its drain), then takes its last values for every member of its bound variant, read or not, never from an
  instance it never followed; after a `failed` call the next good value is `[["r", value]]`; a watch on a reference that
  never hydrated resolves at its first binding (rejects on release, revocation, close, abort); release drops last
  values and bindings; registry values and job state are not affected. **Derives over a failed reference member compute
  on its last value** (G2 (A), as 6a): a contribution built on it stays in its table; only the reference member's own
  watches get the `failed` call, and `ref.state` shows the failure. **Activation churn +9.6% accepted** (CPU 22, 104.7-107.9
  → 114.7-118.3 µs, allocation equal): an object whose derive reads another object's member makes one pass-through
  node per reference member per instance; calls, commits, links and memory are within the bar. Two references to one
  key hold two pins (counted on the key's one source; the document is loaded and kept once). **Binary append commit-to-frame
  median +10% accepted** (owner, 2026-10-29; CPU 10, 0.031 → 0.034-0.035 ms): equal with the young generation pinned, fewer
  scavenges over the whole benchmark (V8's young-generation sizing, slice 7b fix round 3).
- **Per plugin at startup and reload (owner, 2026-10-30: "yes", "1. lgtm 2. yes"; analyses
  `/tmp/per-plugin-{opus,fable}.md`):** supersedes "Rollback is all-or-nothing per host" (2026-10-2x, 7b §2, design §21)
  and 7c's Q2 ("a facet throwing while evaluated fails its host's whole step"). Why all or nothing was chosen: per plugin
  was decided first and p2's plugin reviewers found counter-traces (a dropped argument field written into a transcript; a
  copied Durable document written by two versions; a provider's failed factory leaving the harness hanging; mixed copied
  code and registries); v2 has since closed them (closed argument schemas for every caller, Q12, Q15; version binding
  with waiting, 7a; ownership of documents; registry versions with `accepts`, Q8; copied cross-plugin files limited to
  contracts without dependencies, 7c). Rules: (1) **at startup** a plugin whose build, evaluation or setup fails is left
  out; `load` resolves with a report `{ failed: [{ plugin, error }] }` and never closes the host for it (the core facet
  included: base code decides whether that is fatal); its consumers wait `failed { waiting }` as for any missing plugin.
  (2) **At reload** a plugin whose new code fails (build, evaluation, setup, a factory in staging, a declaration error,
  `checkAccepts`) keeps its old code (its loaded facet, unchanged), and every other plugin of the reload applies; the
  report lists it (`failed: [{ plugin, error }]`, as `load`'s; an added plugin that fails is left out); staging retries without it. (3) **The closure rule** (Opus): after
  staging, a changed plugin whose recorded requests would not bind because the plugin they need was kept old or left
  out is kept old too, so a consumer edited together with a broken provider keeps working on its old code. Its "missing"
  branch (owner, 2026-10-30: "keep", against narrowing it to names served before): a request nobody serves keeps its
  plugin old whenever any plugin of the reload failed, since a failed new setup may be what would have served it. (4) What no
  rule detects: a consumer relying on new behaviour of a kept provider whose contract (version, fingerprint) did not
  change: the same risk as a rollout across hosts, documented. (5) `rollout` keeps a plugin dirty while it was kept old
  on any host. Built with slice 7c (the kernel's `load` and `reload` change with it).
- **Slice 7c's points (owner, 2026-10-30; `slice-7c.md` §5):** (1) esbuild is an optional peer dependency of Chord,
  imported only by the plugins component. (2) **No dev/prod split** (owner: "chord apps are supposed to not have a
  prod/dev split. they are supposed to be self modifying applications"): watching, rebuilding and rolling out are core
  machinery; one component `chord/plugins` (discovery, build, evaluation, `pluginFile`, the watcher, `rollout`) in
  `src/node/plugins/`, exported with v2's entry point; it turns V8's compilation cache off when created; reloads
  stay explicit (the watcher marks, never applies). Supersedes the separate `loader` and `dev` subpaths of "Slice 7b's
  open points" (5), (6). (3) `installDependencies(plugin, ctx)` as coding-agent installs package dependencies (`npm
  install --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund` in the plugin's real directory, the
  command overridable). (4) Cross-plugin imports: any file of a discovered plugin, copied, documented as contracts and
  side-effect-free modules only, listed by the build, no static check yet. (5) `pluginFile` answered per facet by the
  `require` evaluation passes.
- **Slice 7c build: an abort after the commit names what it applied (owner, 2026-10-30: "yes"; fix round 1, item
  11, Astra):** `host.reload` still rejects `aborted` when its context aborts after the commit (the commit stands, only
  the wait ends), and the error carries `details.committed`, a `CommittedReload { added, changed, removed, failed }`
  (plugin names; `failed`: kept on their old code). Why: the plugins component keeps per host the facet each plugin
  runs and adopts it when the reload resolves; on this rejection it would keep the old facet and pass it at the next
  reload, swapping the committed plugin back silently. Rejected: resolving with the report after the commit despite
  the abort (it would change the rule that an abort after the commit rejects). Examples for 7c (owner): full coverage,
  each example a folder with the host code and real plugin directories (35-39).
- **Slice 10's points (owner, 2026-10-30; `slice-10.md`):** (D1, "a"; `httpServer` **superseded** by `createHttp`, decisions "The HTTP core is a fetch handler" and "Settings are arguments") the HTTP component defines the registry `Http`
  (`"chord.http"`) and serves it through a facet of its own (`http.facet`, plugin name `chord.http`) that the app loads
  with its plugins; its `compose` builds the router; the server reads it with `host.registry(Http, ctx)` per request.
  (D2, "a") Wraps are built in slice 10 as designed (decision "HTTP routes and wraps", design §23): a contribution's
  `wraps` run around routes in the component's phases (`observe`, `headers`, `transform`, outermost first), within a
  phase in contributor order, by default around their own plugin's routes (`scope: "own"`; `"all"` explicit; `route`
  narrows to one, a missing one a reported conflict). The server's `headers` option stays for every response, also
  those no route makes (a 404, a refused request).
  (D3, "a"; **superseded** by "The HTTP server is a native object": the `Authenticators` registry) Authentication is one app function, `authenticate(request, ctx) => P | undefined`, called once per request
  and per upgrade; no Chord registry of resolvers (p3 composes its own from sharing, devices and the relay, with its
  own precedence rules).
  (D4, "k": a) Request bodies: `request.json(limit?)` (parsed JSON, 1 MiB by default, malformed: 400) and
  `request.body(limit?)` (an async iterable of byte chunks, for uploads); nothing is read until a route asks; past its
  limit the read stops and the request is answered 413; a disconnect aborts `ctx` and ends the iteration.
  (D5, "a") Responses are descriptions: `json`, `html` (a full document; replaces the design's `page { title, body }`),
  `bytes` (`mime`, `size`, `read(offset, length, ctx)`, `download?`, `ranges?`; 206/416, `HEAD`, safe
  `Content-Disposition`, 64 KiB reads with backpressure, stopped on disconnect), `redirect`, `error`; `headers` on every
  kind (cookies, a preview's own CSP); `fileResponse(path, options)` over a file; a throwing route is a 500 without its
  message.
  (D6, "a") Plugin WebSockets are `sockets` in the `Http` contribution: `{ "/terminal": (socket, request, ctx) => … }`;
  the component checks the origin and runs `authenticate` (no principal: refused, 403, before plugin code), upgrades
  and hands the plugin a `ws` WebSocket for its own protocol; patterns as routes; wraps do not apply; the links path is
  the component's (`host.accept`). The design's channel component (acknowledged byte channels) waits for a second user
  and would be built on top of it.
  (D7, "a") `ws` is an optional peer dependency of Chord (pinned exactly), imported only by `node/http`, as
  esbuild for plugins.
  (D8, "a") Route patterns: exact segments, `:name` (one non-empty segment, percent-decoded, `params.name`) and a
  trailing `/*` (the rest, possibly empty, `params["*"]`); the most specific match wins, segment by segment from the
  left (exact before `:name` before `*`); one pattern from two contributions is a reported conflict, the first by
  plugin name wins; `HEAD` falls back to the `GET` route.
  (D9, "a") Worker keep-alive: the child reports `host.activity` and the app's `busy` counts (a JSON watchable of
  numbers, e.g. Durable's active tasks) whenever they change; the server stops a worker whose counts were all zero for
  `idleMs` (default 5 min, checked every second), never while it starts; a stop sends `shutdown` (the host closes),
  the process tree killed after 5 s.
  (D10, "a"; **superseded** by R2 below: no automatic restarts, no route backoff) A failed worker start uses the kernel's route backoff (1 s doubling to 60 s while holds exist,
  `resolve_failed` reported); no sticky failure; `workers.state` shows the error and when it is tried again.
  (D10b, "b") `host.route(Kind, options, ctx)` returns a `RouteHandle` with `retry(address)`: it ends that address's
  backoff, so `resolve` runs now if the address has holders (a Retry button for a worker that failed to start, wired
  by the app to the handle; the workers component has no `retry` of its own).
  (D11, "a") Workers never build: the server's plugins component discovers and builds every plugin; a worker's start
  message carries its kind's current scripts (`Built`, plain data) and a reload ships new ones (D12); the child's
  `plugins` only evaluates (no esbuild, no watcher). So plugins are defined where the server can read them, one set for
  every host (owner: "no cwd specific plugins, which might be alright; that way workers can live anywhere"); project
  plugins (design §26 #14) would be discovered and built by the server too. A worker on another machine needs the
  plugin directories there only for `chord.external` packages and `pluginFile`.
  (D12, "a") A rollout step returns one report per host, `{ hosts: [{ host, report }] }` (7c's `RolloutStep` changes;
  the in-process server step returns a list of one); the workers step reloads every running worker in parallel; a
  worker that closed during it is listed with its error and does not stop the rollout; a plugin's dirty mark clears
  only when it applied on every host of every step.
  Spec review (Fable, Opus): (R1, "a") `RouteHandle.suspend(address)`: while suspended the route does not resolve the
  address, its holders stay `loading`; `retry(address)` ends the suspension; `workers.stop` suspends, then stops (an
  archived session stays stopped while a tab still holds it).
  (R2, owner: "take it"; **supersedes D10 and the kernel's route backoff**) **Workers start on demand and never
  restart by themselves** (owner: "if it crashes, chances are it had a good reason to crash, and restarting it won't
  fix that"; D10 as recommended was a restart loop whenever a consumer holds). A worker starts for a hold of an address
  that has not failed (the first, or one after an idle stop or `stop`). A crash or a failed start marks the address
  failed with its error until `workers.retry(address)` (`RouteHandle.retry`) or a rollout that reaches workers (new
  code may fix it, as a reload retries failed objects); its holders and new holds see `failed` with that error, nothing
  forks. Kernel: a route has no backoff timer; it resolves only for a hold, on `retry`, or after its link dropped while
  held, and a rejected `resolve` fails the route's holders with its error (no endless `loading`); a network route that
  wants to reconnect keeps that policy in its own `resolve`. The workers component owns its route
  (`createWorkers(host, Kind, options)` calls `host.route` and keeps the handle) and answers a resolve of a failed
  address with the stored failure at once. A start finding the lock still held by a draining old worker waits for it in
  the child (bounded by the start timeout). R1's `suspend` and D10b's `retry` stay.
  Other timed retries (owner, 2026-10-30: "keep them as is for now"): objects' transient failures (1 s to 60 s while
  held), `self.on` handlers that throw (1 s to 60 s while live) and `self.onLive` restarts (the same, reset after a
  minute's run) stay; they heal real transient failures (a network down for a while) and cost at most one try a minute
  each; revisit if one shows up as a loop in practice.
  (R3, "a"; refines D9) The child reports only the flip: `{ idle: true }` when every count (`host.activity` and `busy`)
  becomes zero, `{ idle: false }` when one becomes nonzero; the server's idle clock starts at `true` (a status message
  costs about 6 µs on each side, a local call 2.9 µs: no report per call).
  (R4; **superseded in part** by "allowed hosts only through contributions" and "The HTTP component's security baseline": no `allowedHosts` option, provenance by the socket; "a if configurable at runtime so allowed domains can be added and removed by a plugin") Before `authenticate`, the
  component refuses (403) a `Host` that is neither loopback nor allowed, and an upgrade (`/chord`, a plugin socket)
  whose `Origin` is not the request's own origin; `request.origin` comes only from an accepted `Host` (`http://` on
  loopback, `https://` for an allowed host); `headers(request, principal)` gets the principal. Allowed hosts are the
  server option `allowedHosts` plus every `hosts` list in `Http` contributions: a plugin adds and removes its domains
  at runtime by contributing a writable (`self.writable`, design §17), the router recomposed on each change (a tunnel or
  relay plugin names its public host).
  **The app kit is malleable by plugins** (owner, 2026-10-30: "all of this should be malleable via plugins"; "yes"):
  in `http`, `workers` (and slice 11's components) every option that is not bootstrap is either a contribution to
  `Http` (routes, wraps, sockets, hosts; writables where it changes at runtime) or a function the component calls per
  use (`authenticate`, `headers`, a worker's `start`, `idleMs`), which the app backs with its own registries; nothing is
  copied out of a contribution or an option at startup. Bootstrap stays base code, changed by a restart: the listen
  address and port, the links path, the worker entry module with its `execArgv` and `env`, the host kind workers serve.
  (R5, "agree") `workers.state` per address key: `{ status: "starting" | "running" | "stopping", pid, startedAt }` or
  `{ status: "failed", error: { message, code?, reason? }, at, stderrTail? }`; no entry when stopped or never started
  (a clean stop removes it); `failed` stays until Retry or a rollout; plain JSON (a core object may serve it).
  (R6, "b, common enough") `bytes` may omit `size`: chunked transfer encoding, no ranges (no `Accept-Ranges`), `read`
  called with growing offsets until it returns an empty chunk (a zip built on the fly, a growing log, an export paged
  from a worker).
  Spec review round 2 (Fable, Opus, Astra, Sol): (Q1, recommended) holders of a failed worker get `failed { waiting }`
  with the stored error as cause and stay on the address's path: a later link of the address (Retry, a rollout) binds
  them without a re-hold; a `get` waits its `readyTimeout` meanwhile.
  (Q2, "a") A rollout that reaches workers clears the failures from before it, then calls `RouteHandle.retry` for the
  cleared addresses that have holders (they start with the new code and are listed in the step); an unheld one starts
  at its next hold; a worker that fails during this rollout stays failed (no loop: one start per held failed address per
  rollout a person triggers).
  (Q3, "a"; refines R1) A `stop`'s suspension lasts while the address has holders; they see `failed { waiting }`
  ("suspended"); with the last holder the record goes, and a later hold starts the worker on demand (as after an idle
  stop); whether an archived session may be opened is the app's (`authorize`, its views). Memory stays bounded.
  (Q4, "a") The start timer (60 s) covers fork, lock and connect (`started`) only; after `started` a slow `load` is
  objects showing `loading`; `ready` sets `state` to `running` and lets idle stops begin; a `load` that never ends
  shows `starting` until `stop` (no kill, no retry).
  (Q5, "a"; refines R3) A worker's idleness is `references`, `jobs`, `lingering` and the app's `busy`, not `calls`: a
  remote call runs on a hold (counted), local calls come from routines (not counted, §14), jobs, Durable tasks (`busy`)
  and handlers under a hold; no message per local call, no timer. The first report goes with `ready` (`ready { idle }`),
  so a worker idle from its start is stopped too.
  (Q6, owner: "if sockets are a contribution, why keep them when the contribution is removed?": design §17's rule, an
  entry lives as long as its contributor and consumers keep nothing beyond a use) A plugin socket is closed (1012,
  "service restart") when the contribution that handed it out leaves the table (a reload changing or removing it); a
  `/chord` link or socket whose `Host` is no longer allowed closes (1008) when the allowed hosts change.
- **Slice 11's points (owner, 2026-10-30; `slice-11.md`):** the surfaces are generic plumbing; the app keeps
  everything visible (owner: "this one needs to be generic, so apps can do whatever they want, css, tui components,
  themes"). (P1, "a") `chord/web` (its server side now `/surfaces`) ships serving the surface (the base bundle, the
  plugins' web scripts, stylesheets and assets, the page through the app's template, all as `Http` contributions), the
  browser's client host with its connection loop, and loading and applying the plugins' web facets; not HTML, CSS,
  components, themes, navigation, slots or layout.
  (P2, "script tag") A plugin's web script is served as a file that registers itself
  (`chordFacet("<plugin>", "<digest>", function (require, module, exports) { … })`) and is loaded with `<script src>`
  under a `'self'` CSP: no `eval`, no `new Function`.
  (Kinds, owner: "ya"; changes 7c's `createPlugins` options, built in slice 10) One definition per facet kind:
  `kinds: { server: { platform: "node", hostPackages: [...names] }, web: { platform: "browser", hostPackages: [...] } }`
  replaces `kinds` plus `browserKinds` and the component-wide `hostPackages` map. The platform decides the build (Node:
  builtins and `chord.external` external, no CSS or `?url` assets; browser: CSS and assets collected, builtins and
  `chord.external` refused); the names keep those imports external. The module objects are given where scripts are
  evaluated: the server's own at `plugins.load(host, { kind, core, modules })`, a worker's in `workerMain`'s
  `hostPackages`, a page's in `startPage`.
- **Slice 10 build: plugin sockets get a heartbeat (owner, 2026-10-30: "does it make sense? then yes"):** the HTTP
  component pings every plugin socket with WebSocket ping frames after 15 s of silence and terminates one silent for
  30 s (the link heartbeat's numbers); browsers and `ws` answer pings by themselves, so plugin code is unchanged. A dead
  peer (a phone that vanished) no longer keeps a plugin's resources (a terminal view) until TCP gives up.
- **Origins only from relays (owner, 2026-10-31: "why would child links carry origin? the server keeps track of origin
  per connection and relays that to workers"; slice 10 security audit, Opus K1/K2, a hole since slice 4a):** `origin`
  is read only on parent and route links (where a relay's messages arrive); on a child link (a tab, a TUI) a message
  carrying `origin` is a protocol error that closes the link; the server numbers each child connection itself, as it
  does. Every link drops a per-origin record once it has no holds, no calls and nothing in flight (origins are never
  reused). Was: honoured on every link, so a tab could invent origins, each with its own call window (5,120 concurrent
  calls from one guest socket) and a record kept until the socket closed (about 1 KiB each). Supersedes design §3's
  "`origin` is honoured on every link". Fixed in slice 10's fix round.
- **Slice 10 fix round, worker errors in public (owner, 2026-10-31: "a"; refines R5):** two levels. Public (`workers.state`
  and the holders' `failed { waiting }`): a `fatal` as the child's `redact` made it; a start error or a crash as a fixed
  message with a code (`"worker failed to start"`, `"worker exited (SIGSEGV)"`); no stderr in `state`. Private: the full
  error and the stderr tail go only to the server's `onError` (`worker_failed { address, error, stderrTail }`), the app's
  logs to redact. Was: `state.stderrTail` and the raw start error, which leaked secrets to guests (security audit, Astra,
  Opus H3).
- **Slice 10 fix round, allowed hosts only through contributions (owner, 2026-10-31: "a, and we close everything that's
  been removed"; refines R4):** the server option `allowedHosts` goes; the app contributes its hosts like any plugin
  (fixed ones from its core facet, changing ones from a host-lifetime object's writable). Whatever is removed is closed
  at once: when a host leaves the allowed set, or a plugin's contribution (its sockets) leaves the table, every link and
  socket that came through it is terminated immediately (no graceful close the peer could ignore, Astra A1), its scope
  sealed; an upgrade still authenticating is checked again against the current set and router before it is handed out
  (Astra A2).
- **The HTTP component's security baseline (owner, 2026-10-31: "this mechanism should come out of the box in http/app kit;
  basically encode all the best practices so users never have to think about it again"; "yes"; p2's rules from
  `hosts/principals.ts`, `hosts/server.ts`, `loopback-cookie.ts`, devices, sharing):** on by default in
  `chord/http`. (1) Provenance: local only when the socket's local address is loopback, `Host` is a loopback
  form with the port, and no `Forwarded`/`X-Forwarded-*` header; otherwise only an allowed host (https); else 403;
  duplicate `Host` and absolute-form targets 403; `request.provenance` `{ kind: "local" } | { kind: "remote", host }`.
  (2) Foreign requests (Fetch Metadata: `Sec-Fetch-Site` `cross-site`/`same-site`, or a frame another site embeds)
  never reach `authenticate`: they run anonymous, except a top-level navigation (`GET`, `navigate`) to a route marked
  `page: true`. (3) A foreign `Origin` is 403 on every request and upgrade; unsafe methods from a browser need `Origin`
  equal to the app's; a route may opt out (`crossSite: true`, a webhook), then it always runs anonymous. (4) Default
  headers on every response, the component's own included: `Cache-Control: no-store`, `nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a CSP with a per-server script nonce (`default-src 'none'`,
  scripts `'self'` and the nonce, `connect-src` self and its WebSocket, `frame-ancestors 'none'` or the contributed
  `framers`); a route widens its own CSP through its response headers. (5) `cookie(name, value, options)`: `HttpOnly`,
  `Path=/`, `SameSite=Strict` (or `Lax`), `Secure` on a remote origin, signed with a given secret. (6) `bytes` and
  `fileResponse` refuse foreign requests, are `attachment` unless the route says inline, and inline ones get a
  `sandbox` CSP. The app decides only who someone is, which routes are pages, its extra CSP sources and its framers.
  Replaces the CSRF question of the security audit; extends R4.
  Relays (owner: "sure"): a contribution may declare `relays: [{ name, verify(request) => { origin, framer } |
  undefined }]`; admission calls them for a request that would be refused for forwarded headers on loopback (p2's
  Radius relay); a verified one gets `provenance: { kind: "relayed", relay, origin }` and its framer allowed for it,
  an unverified one stays refused; `authenticate` decides its principal.
- **The HTTP server is a native object (owner, 2026-10-31: "still unconvinced the server can't be a native object; it's a
  singleton, unlikely to change"; supersedes D3 and the `httpServer` function of D1):** `chord.http`'s facet serves the
  registry `Http` and a host-lifetime object whose native is the listener; its configuration (`HttpConfig`: port,
  links path) and `Authenticators` are registries the app (or the app kit) contributes to. The facet is passed as the
  same object at every reload, so the listener never closes before the process ends. The port opens right after
  `load`'s publication (a few hundred milliseconds later than listening before `load`; a reconnecting tab retries).
- **The app kit is opinionated (owner, 2026-10-31: "the app kit should be super duper opinionated and make for small
  app code"; "i suppose"):** after slice 10's fix round and before slice 11, a design pass on `chord/app`: one
  entry (`startApp`, `startWorker`), conventions for layout, hosts, principals, authentication, storage, plugins, web
  and TUI, decided point by point; the slice 10 components are its inside. Inputs from the owner: user management is
  part of it ("user management will also need to be a thing we support"), and app shapes without workers (server and
  clients only: "a chat app doesn't need workers").
- **Plugins import each other by name (owner, 2026-10-31: "i like it"; changes 7c's cross-plugin rule; **superseded** by "Contracts come from where the plugin's code came from", 2026-11-01):**
  `import { Notes } from "@app/notes/contract"` resolves to the discovered plugin named `@app/notes`, its file
  `contract.ts`, wherever its directory is (any root), copied into the importer's script as before (contracts and
  side-effect-free files only; they may import only host packages and files of their own plugin); a missing plugin is
  a build error naming it; relative paths into another plugin's directory are refused. Owner's notes for the app kit
  pass: third-party plugins need the imported plugins' sources or types for type checking (publishing each plugin to
  npm works but is unpleasant); plugins should be testable on their own, with their dependencies mocked.
- **The HTTP core is a `fetch` handler; Chord's own Node server is the easy path (owner, 2026-10-31: "could http just plug
  into hono/express?"; "we should still provide the easy path using just node's shit as well, for small apps or apps
  where we don't care"):** the component builds one Web-standard handler, `(request: Request) => Promise<Response>`,
  from `Http` (admission, the security baseline, router, wraps, descriptions), plus per-runtime upgrade adapters for
  `/chord` and plugin sockets. The default is Chord's own listener, the native host-lifetime object of `chord.http`
  over Node's `http` (decision "The HTTP server is a native object"); an app with its own server mounts the handler
  (`hono.all("/*", (c) => http.fetch(c.req.raw))`, an Express adapter) and passes upgrades to the adapter. The same
  routes then run on other runtimes later (Bun, Durable Objects, design §26 #16). Built in slice 10's fix round
  (reworks `server.ts`, `request.ts`, `response.ts`; router, admission rules and descriptions stay).
- **Slice 10 fix round, three small points (owner, 2026-10-31: "yes on fileResponse etc"):** (1) `fileResponse(path, {
  root? })`: with a `root`, a file whose real path lies outside it (a symlink out) is refused 403; without one the path
  is trusted (a plugin's own file). (2) The worker lock on macOS and the BSDs fails closed on a stale lock file, with an
  error naming it (no takeover; Linux and Android use abstract sockets and are unaffected). (3) A route's overhead:
  Opus's two trims, measured again after the `fetch` rework, and the numbers brought to the owner.
- **Stale lock files are cleared by the starter (owner, 2026-11-03: "do both"; refines point (2) of "Slice 10 fix
  round, three small points"):** on macOS and the BSDs a worker killed by a signal (the grace's SIGKILL, the start
  timer, a dev supervisor) runs no exit hooks and leaves its lock's socket file; every later start of that address then
  failed closed on it, also `retry`, until someone removed the file by hand. Takers still fail closed (two takers
  clearing could race); the workers component, the one process that starts an address's workers, removes a socket file
  nobody accepts on (`clearStaleLock`) before each start's message and after a child's exit by a signal, both in the
  address's queue, so never two clears of one name at once. A live holder (an older worker still exiting) accepts and
  is kept. One connect per start on macOS and the BSDs, nothing on Linux, Android and Windows. A taker also treats
  `ENOTSOCK` (a non-socket file at the path on macOS) as stale; before it retried until its context ended.
- **A pause of the process is no silence (owner, 2026-11-03; refines "Slice 4a spec decisions"):** after a laptop
  slept, the host's heartbeat timer fires before any I/O is read and found every link silent past `close`: the server
  closed its worker links (and the worker its parent link) though both peers were fine, and p2's session workers
  stayed failed ("worker exited (code 0)") until Retry. A tick at least one interval late is time this process did
  not run (a sleep, a blocked event loop); that time does not count as silence: each link's silence is what it was
  before the pause, at least `ping`, so an open link pings at once and a dead peer (a TCP connection the sleep
  dropped) closes `close - ping` later (15 s by default). One subtraction per link on a late tick, nothing otherwise.
- **A lost worker link is recovered from (owner, 2026-11-03: "should we not auto reconnect?"; refines R2 of "Slice
  10's points"):** R2 counted a link lost while its child lives (the heartbeat, a protocol error, the child closing its
  own link) as a crash. A lost link of a `running` worker is now a stop instead: the child is stopped (grace 5 s, then
  killed), `worker_link_lost { address, error }` is reported, the address does not fail, and its held route resolves
  again (the kernel resolves once after a held link drops): a new worker starts after the exit. No restart loop: a
  second lost link within a minute of the address's last recovery fails it as before, with the public error `worker
  lost its link` (`worker_exited` and `worker_failed` as for a crash). A link lost before `ready` is still a failed
  start. Crashes, `fatal`s and failed starts stay failed until `retry` or a rollout (R2 unchanged for them).
- **Slice 10: a route's overhead accepted; no header accessor (owner, 2026-10-31: "1 yes, 2 no"):** after the `fetch`
  rework and the Node fast path a route costs +20-21 µs over a plain Node handler on the standard bench, +12-13 µs warmed
  (before the rework +4.5 µs): the request's scope (2.1 µs), URL parsing, admission and routing, the baseline's headers,
  the scope's seal, and about 5 µs of Node's microtask machinery an async path triggers. Accepted against the 10% bar.
  No `request.header(name)` accessor: an authenticator reading headers builds the Web `Request` (about 3.5 µs more).
- **A CSP nonce per response (owner, 2026-10-31: "csp ok"; Fable's recheck):** the HTTP component makes a fresh script
  nonce for every response (`request.nonce`), not one per server: a nonce read from one page cannot be reused by an
  injected script elsewhere.
- **Settings are arguments, extensions are registries (owner, 2026-10-31: "making that config a registry is dumb; it's a
  general problem for all host-lifetime natives that need initialization at host startup"; "k"; supersedes the
  `HttpConfig` registry of "The HTTP server is a native object"):** what the app decides once at startup (a port, frame
  limits, a timeout, a data directory, which implementation to use) is an argument to the component's facet, which base
  code constructs; the facet and its host-lifetime objects close over it; changing it is a restart; no plugin can
  touch it. What plugins add while the app runs (routes, authenticators, tools, panels, more indexers) is a registry.
  HTTP: `createHttp(host, { listen, links, closeTimeout, onError }, ctx)`; `Http` and `Authenticators` stay registries.
  The same for the harness (its store and defaults as arguments; models, environments, extensions as registries) and
  the app kit's components (a session index takes its indexer as an argument, and may also follow a registry of
  indexers if plugins should supply them).
- **API versions in the import path (owner, 2026-10-31: "this sounds about right"; "must be declared by the plugin in
  code, we do not want to dig around package.json files anymore"):** the app's base code is internal except its API
  modules, which it exposes as host packages with a version in the path (`@acme/app/v3`; Chord's
  `@earendil-works/chord/v2`); the app lists the versions it still provides (an older one as the same module, or a
  thin layer); an import of an unlisted version is a build error naming the available ones. No `package.json` field
  and no npm ranges for this. Contracts and registry tokens inside an API keep their own versions. The rest of the
  plugin model is a proposal (`docs/plugin-model/`).
- **A schema package beneath pi-ai and Chord (owner, 2026-10-31: "i want the schema package"; "if we keep it a
  dependency in pi-ai, we must be able to rip it out"; TypeBox is "horrible to treeshake"):** a small package with no
  dependencies (working name `@earendil-works/schema`) under both pi-ai and Chord (siblings: neither depends on the
  other): helpers returning plain JSON Schema, a structural `JsonSchema` type, `Static` from the helpers' literal
  types, and a validator for general JSON Schema (tool schemas from MCP servers and extensions use `$ref`, `anyOf`,
  `pattern`, ...), without `eval` or `new Function` (CSP-safe). Chord v2 drops TypeBox; pi-ai's core never imports
  it (TypeBox schemas still pass as JSON Schema; TypeBox-typed extras only in an optional subpath, so ripping it out
  is deleting that subpath). Not omptype (its validator compiles with `new Function`; its 10.7k lines are mostly
  ArkType's API). Open: which validator (measure `@cfworker/json-schema` and TypeBox against the official
  JSON-Schema-Test-Suite and Chord's argument checks first), and moving `Type` out of pi-ai's main export.
  **Built** (owner, 2026-10-31: "clone pi add the package, done"; pi `fab2c53`): `packages/schema`,
  `@earendil-works/pi-schema`: `compile(schema, { draft, formats, schemas })` with `check` (narrowing) and `errors`
  (JSON Pointer paths), Chord-style builders typed with `Static`, formats as the opt-in `./formats` entry, leaf and regex
  checks shared through weak caches (GC-tested); its own closure-compiled validator, chosen after measuring
  (`/tmp/schema-measure.md`, Radius 01m69x3dz2fsg9k1r33vde7hv6): 2,222 of 2,223 core suite tests (TypeBox 2,200,
  cfworker 2,167, omptype 1,522), Chord checks at 0.95-1.3x TypeBox's compiled speed and the same with `new Function`
  blocked, 7.9 MB for 3,200 distinct schemas (cfworker 7.6, TypeBox 54.7), 8.5 KB gzip. Still open: switching Chord v2
  and pi-ai to it (`Type` out of pi-ai's main export), formats on by default in pi-ai.
- **The schema switch (owner, 2026-10-31):** TypeBox leaves Chord (v1 too: "remove typebox wherever we can"),
  pi-ai, pi-agent-core and pi-durable; extensions must not break ("absolutely 100%"), proven by a guard over our own
  extensions, built-in tools and generated arguments (verdicts, coerced arguments, provider payloads and inferred
  parameter types identical; owner: "just use ours", no npm corpus). **Coercion lives in pi-schema** as an opt-in,
  the superset of TypeBox's `Value.Convert` rules and pi-ai's own (TypeBox's rule first where they conflict):
  `compile(schema, { coerce: true })` adds `coerce(value)` (a copy, never mutating) and `parse(value)` (`{ ok, value }
  | { ok, errors }`); pi-ai uses it for every tool, whatever built the schema (so plain-JSON MCP tools gain the
  TypeBox rules). **Error texts are pi-schema's own** (no mapping to TypeBox's wording). Extensions keep `Type`,
  `Static`, `TSchema` from the coding agent's bundled TypeBox (the pi-ai they see is compat plus those); an extension
  author type-checking against the published pi-ai no longer finds them there (accepted: "fine"). **`format` is an
  annotation in Chord** ("no format check": no format module in Chord's or Durable's entries; pi-ai still checks
  formats on tool arguments). **Chord's envelope check costs +10 to +100 ns per message** from untrusted links
  (pi-schema reads fields by name from a list; no eval): accepted ("negligible"), no hand-written check.
- **Contracts come from where the plugin's code came from (owner, 2026-11-01: "ok"; plugin model point 1, primer
  `docs/plugin-primer/`; supersedes "Plugins import each other by name"):** a plugin carries the contract it was
  written against, never the running app's newest file. The problem: by name, a third-party plugin's next build copied
  the provider's newest `contract.ts` (version 2), so its version-1 code claimed version 2, `accepts` was never used
  and it computed wrong results silently. Rule: (A) plugins that change together, the app's own in its repository or a
  user's in one root, import each other by relative path (`../notes/contract.ts`), copied into the importer's script
  and listed in `copied`; a copied file may import only host packages and files of its own plugin; a relative path
  leaving its root (into base code or another root) is a build error pointing to the API or an npm dependency. (B)
  Plugins that do not change together take contracts as an npm dependency at a fixed version, bundled at the installed
  version (decision "A plugin's npm dependencies are bundled"); the provider serves it through `accepts` or the
  consumer waits "contract mismatch". Which package carries the app's contracts is point 5. The by-name lookup and the
  `tsconfig` path aliases go; built in the plugin slice (examples 35-38, fixtures, design §21, the plugins README, the
  guide's chapter "Plugins Using Plugins").
- **Plugins import only the app's versioned API; Chord is re-exported in it (owner, 2026-11-01: "makes sense";
  plugin model point 2):** a plugin never imports Chord directly: Chord is not a host package plugins may name, so a
  direct import is a build error pointing to the app's API. The app's API module per version (`@acme/app/v3`)
  re-exports the Chord surface the app supports (contract and schema builders, `defineFacet`, `defineRegistry`, the
  types plugins see) next to its own small part (host kinds, the principal type, `defineFacet` bound to it, core
  contracts, registry tokens). One version number, the app's, describes everything a plugin gets from its host. The
  process runs one Chord: an older API version still listed is a layer over today's Chord; when Chord breaks its
  API it keeps its previous API as a compatibility module for a while, which the app's older version re-exports;
  once that is dropped the app drops the version and old plugins fail at build naming the available versions.
  Contracts are data and bind through `accepts` whatever Chord runs. One facet imports from one API version only
  (checked at build). Only base code imports Chord directly. Bundling is slice 10's host packages: the version is part
  of the name (`kinds.hostPackages` lists `@acme/app/v3`, `@acme/app/v2`), each process provides its own modules.
- **The plugin model, points 3, 4, 5 and 8, imports and builds (owner, 2026-11-01, by voice: "yeah that checks out"; "lock the decisions on the
  points which was discussed"; primer `docs/plugin-primer/`):**
  (3) **Split by host kind, for the app and for plugins alike.** The app's API per version has a shared module
  (`@acme/app/v3`: Chord's re-exported surface, host kinds, the principal type, `defineFacet` bound to it, contracts
  and registries that cross hosts) and per-kind modules (`/v3/web`, `/v3/tui`, `/v3/server`, `/v3/worker` where
  needed: UI components, registries and `local` contracts that live on that kind only). A plugin's contract files
  mirror it: `contract.ts` (shared) and `contract.server.ts`, `contract.worker.ts`, `contract.web.tsx`,
  `contract.tui.ts` as needed. A contract file mentions native things (React components, functions) only through
  `import type`; at runtime it imports only the shared API and its plugin's data-only files (a hard rule). The build
  checks every import by the file it resolves to: a per-kind file (`.web.` etc.) or per-kind API module only for that
  kind, and a file importing a package the kind does not provide (React in a worker) refused. Shared UI between
  plugins: a plain component through an imported file (inlined into the importer's script, frozen at its build), or
  a registry when one live instance is needed (React contexts, a feature others embed).
  (4) **Host kinds on registry tokens** are covered by placement: a token used on one kind lives in that kind's file,
  so other kinds cannot import it; an explicit `hosts` marker only if a shared token must be limited later.
  Registries version by hand: readers and writers work across versions through the token's version and the defining
  plugin's `accepts`; no fingerprint for native values (decided earlier, unchanged).
  (5) **Third parties get the app's contracts through its versioned API:** each built-in plugin keeps its contract
  files; the API re-exports the ones the app promises (`export { Notes } from "../plugins/notes/contract.ts"`), so a
  plugin built against `/v2` keeps v2's contracts; the others stay private. No per-area subpackages.
  (Imports) **Plainly, with no resolution magic:** within one repository (a root, or a repository of several
  plugins), relative paths to the files (`../notes/contract.web.tsx`); across repositories, the package name with its
  exports (`@bob/notes`, `@bob/notes/web`), pinned in `dependencies` by an npm version or a git ref
  (`github:bob/notes#<commit>`; npm's git dependencies, no registry publishing needed; a plugin in a subfolder of a
  multi-plugin repository is cloned and linked by the plugins component, which npm cannot do). Rejected: one
  specifier resolving to a sibling or an npm package depending on `dependencies` ("kinda magic"). Plugins are
  installed from git by cloning a branch, tag or commit into a plugins root (as the coding agent's git packages).
  (8, base code) **Base code shrinks to the API, bootstrap and a start-data facet:** the vocabulary (the versioned API modules,
  host packages, never reloaded), bootstrap (creating hosts, opening the store, components such as `createHttp` and
  `createWorkers`, which take settings and process values and return facets, their natives opened by Chord, passed as
  the same object at every reload) and one small facet serving process values (start data, the opened store) as core
  objects. Every implementation, the harness and the providers of core registries included, is a plugin in the app's
  own root, loaded, reloaded and failing per plugin like any other; the app may mark its root required, so a core
  plugin failing at startup is fatal. Built-in plugins follow the same rules as any plugin.
  (Build) **No build hooks from plugins:** the server builds every plugin with one esbuild call from TypeScript source
  (no `dist` needed; installs run with scripts off); what the build handles (TS, TSX, JS, JSON, CSS, assets and WASM
  by URL) is the plugin's toolbox, generated files are committed; a CSS preprocessor or similar, if ever needed, is
  enabled by the app per host kind, never by a plugin (a stranger's web plugin must not run code on the server).
  To do: a skill and documentation for agents describing a plugin's layout, its contract files, imports and how the
  host builds it. Open from the primer: (6) `testPlugin` with stub facets, (7) single-file plugins.
- **Single-file plugins (owner, 2026-11-01: "agreed"; plugin model point 7):** a root may hold plain files named
  `<name>.<kind>.ts(x)` (`hello.server.ts`, `hello.web.tsx`): files with the same first name are one plugin named
  after it, one facet per file. The name must be a valid unscoped name; a collision with a directory plugin of the
  same root is reported like any duplicate. No `package.json`, so no npm dependencies; it imports only the app's API
  (host packages), no other files and no contract files for others; it may serve objects, define contracts for
  itself inline and contribute to registries. When it needs more, it becomes a directory with the same name, which a
  reload treats as the same plugin. The watcher's `set` mark covers files appearing and disappearing at a root's top.
- **Testing a plugin alone (owner, 2026-11-01: "let's do that"; plugin model point 6):** `testPlugin(dir, { kind,
  modules, stubs, start?, principal? }, ctx)` builds the plugin as production does and loads it on an in-memory host
  of that kind with an in-memory store. A plugin depends on four things, each answered without a mocking framework:
  the app's API and Chord are the real modules (definitions only); other plugins' and core objects are reached
  through contracts, so the test passes stubs, ordinary facets serving those contracts with fake data; registries
  the plugin contributes to are served by the helper, which collects the contributions for the test to read (a
  registry it reads gets fake entries from a stub); process values come as fake start data. The result is a live host:
  the test gets the plugin's objects, calls them, watches their state, and acts as any principal. A contract no stub
  serves leaves its requests waiting `not_served`; the helper lists those names, so the test says what to stub.
  Several hosts at once (a server plugin calling a worker) is a later, larger helper over memory links; the app kit
  may ship stubs for its core contracts.
- **The app kit, point 1: its shape (owner, 2026-11-01, by voice: "yeah"; app kit design pass):** the app's own
  layout is fixed: `src/` with the API versions (`src/api/v3/`, per host kind as decided for the plugin model) and the
  built-in plugins root (`plugins/`). The data directory is deployment configuration, outside the app: a `startApp`
  option set by the app's own start script (no environment variables: owner, "no environment variables"), default a
  dot directory named after the app in the home directory; it holds the store, the user's plugins root, logs and the
  workers' data. The server is fixed (one per app, clients connect to it). Workers are a list of worker kinds the app
  defines, each a host kind with the app's own params (sharding is the app's: a project, a tenant, a document; the kit
  knows no sessions) and how to start it (entry, start data per address, principal, idle time: the workers
  component's options); zero kinds is a server with clients only (a chat app).
- **The app kit, point 2: principals and users (owner, 2026-11-01, by voice: "yeah I guess. just make it nice and
  concise and easy to use and flexible"; "too opinionated might be a problem"):** three things kept apart. (1) The
  principal is tiny (a kind and an id: it travels on every call and is part of objects' identity) and the app defines
  its type; the kit requires only the variants it needs itself (the server and its worker kinds). (2) User data
  (avatar, bio, availability) is ordinary app data in objects keyed by the user's id, never in the principal. (3)
  Authentication turns a connection into a principal. The kit ships optional plugins: a users plugin storing accounts
  with a profile schema the app supplies (a Slack-like profile or just a name), and authenticator plugins (device
  pairing, invite links, an ephemeral one for an IRC-like "pick a name and you're in": a fresh id with the name, no
  stored account, gone with the connection); an app picks, replaces or writes its own. Rejected: a fixed principal type
  with roles.
- **The app kit, point 3: authentication (owner, 2026-11-01, by voice: "yeah, I guess something like that"):** (a)
  no owner by loopback alone (any local process or OS user could claim it): the start script prints a link with a
  one-time token (as Jupyter), whose visit sets a signed `HttpOnly` owner cookie for that browser; drive-by requests
  from pages in that browser stay blocked by the security baseline (foreign requests, also other localhost ports,
  never authenticated; Host and Origin checks). (b) Deny by default, in the HTTP component itself (a change to slice
  10's routes and sockets): a request without a principal is refused before plugin code unless its route or socket is
  marked public (a landing page, a webhook, the ephemeral name login, which hands out a principal). Authenticators stay
  the `Authenticators` registry, filled by the authenticator plugins the app chose; a session helper issues and revokes
  sessions so authenticators do not each reinvent cookies and logout.
  (c) Command-line clients (owner: "that sounds good"; the TUI client too) connect over the same WebSocket with a
  token in a header (no Origin, no Fetch Metadata: not a browser request; the token decides): on the same machine an
  owner token file in the data directory readable only by the OS user running the app; from another machine a device
  pairing flow (the tool shows a code and a link, the owner approves in a browser, the tool stores the token), the
  token a session like any other, listed and revocable.
- **The app kit, point 4: storage (owner, 2026-11-01, by voice: "yeah, I suppose that sounds right"):** in the data
  directory the server has one store; each worker has its own directory under its worker kind, named by its address,
  with its store in it; the kit opens and closes them. Plugins never use paths of the data directory: their state is
  in their objects' documents and tables; a plugin that needs raw files gets a subdirectory of its own, owned by one of
  its objects.
- **The app kit, point 5: plugins, files and export (owner, 2026-11-01: "okay", "yeah"):** two plugin roots: the
  app's built-in `plugins/` (required: a plugin failing at startup stops the app with its error) and the user's in the
  data directory (failures reported). Installs from git or npm into the user's root. One "apply changes" call builds the
  dirty plugins and rolls them out to the server, then every running worker; the app exposes it as a button, a
  command or an agent tool; changes are never applied by themselves. **Files:** the kit ships a files plugin, one owner
  per address (`self.get(Files, { scope })`: `put`, chunked transfers for large files (design §23), a watchable
  index, caps), its files in that worker's directory; apps build on it (p3's artifacts: versions, previews, sharing;
  design §26 #17). Raw directories only where a real path is needed (a git checkout, a library writing its own
  database), each owned by one object, under the worker's directory. **Export and import per address:** the store's
  archive plus the worker's directory as one archive; importing it under another address copies or moves it.
  Refines point 4 (storage): plugins use the files plugin instead of raw subdirectories of their own.
- **Slice 11, P3: the base bundle and plugin scripts (owner, 2026-11-01, by voice: "yep, that sounds good"):** the
  server builds one base bundle per client kind from an entry in the app's source (the app's web start code, its API
  with the kind's module, Chord, React), content-hashed and cached by browsers forever; a change of base code reloads
  the page (as a restart of the server). Plugin scripts: at page load the server serves the current set of the kind's
  plugins as one combined file named by a hash of the set (one request, cacheable); while a page is open, a rollout's
  changed plugins are fetched one script each. A fresh page makes two requests, an update downloads only what changed.
  Rejected: a prebuilt base bundle shipped with the app (could disagree with the plugins' build).
- **Slice 11, P4: new plugin scripts apply in place (owner, 2026-11-01: "yep, agree"):** a page's host reloads the
  changed plugins per plugin (`host.reload`, as on the server): objects swap or restart, the UI re-renders from its
  registries, keeping what is on screen (scroll, a half-typed message). A change of base code still reloads the whole
  page. Rejected: reloading the page for every plugin change (p2's behaviour, which lost the screen on every agent
  edit).
- **Slice 11, P5: pages learn of new scripts through Chord (owner, 2026-11-01: "agree"):** the web component serves a
  small object whose state is the current set of the kind's plugin scripts (names, digests, URLs); every page holds
  it; a rollout publishes the new set without waiting for pages; each page gets one frame and fetches what changed;
  after a reconnect the hold's snapshot brings the current set, so a page catches up on anything it missed. Rejected:
  polling a manifest (p2: every 5 s while visible).
- **Slice 11, P6: the connection loop (owner, 2026-11-01: "agree"):** p2's `keepConnected`: after a drop, reconnect
  with a growing pause (250 ms to 5 s); try at once when the tab becomes visible, the browser comes back online or the
  network changes; replace a socket open but silent; stop when the server reports an outdated protocol (the page
  reloads) or the app's `canRetry` says no (a guest's share ended). References keep their last values and wait while
  down, so the UI shows a banner from the connection state. A network reconnect, not a crash restart.
- **Slice 11, P7: React bindings (owner, 2026-11-01: "we definitely want something like that"; p2's `useObject`,
  `useReadable`, `useRegistry` in `runtime/web.tsx`):** an optional subpath (`chord/react`): `HostProvider`,
  `useHold(Type, params)`, `useWatch(watchable)`, `useRegistry(R)`, `useRefState(ref)`; releasing holds on unmount,
  and a component unmounted by a reload never counts as leaving (design §21). No components, no styling; non-React apps
  never load it.
- **Slice 11, P8: the terminal client always runs sandboxed (**superseded in part** by "The terminal's sandbox is a
  child process", 2026-11-02: no longer a worker thread) (owner, 2026-11-01: "the terminal should always use the
  sandbox approach"):** `chord/tui` is a Node client host that connects with a token (decision "The app kit, point
  3", (c)), downloads the base bundle and the TUI plugin scripts from the server and runs the app's TUI entry, always
  inside p2's sandbox: a permission-dropped worker thread with a bridge terminal, the trusted launcher outside it
  holding the credentials, the terminal and local preferences. No unsandboxed mode, also for the owner's own server.
- **Slice 11, P9: a terminal component scope, library-agnostic (owner, 2026-11-01: "yeah, sure"; p2's `TuiScope`
  in `src/runtime/tui.ts`):** the counterpart of the React bindings: a scope tied to a component's life with `hold`,
  `watch` and `registry`, releasing everything on dispose, calling one `changed` callback the app wires to its redraw
  (one line with pi-tui; any library works). p2's retry with backoff for gone references is not carried over (v2
  references wait and rebind by themselves). No pi-tui dependency.
- **`chord.plugins` is a package's manifest of plugins, as pi's (owner, 2026-11-01: "yes"; slice 12 review, Opus H1;
  refines "The plugin model ... imports and builds" (Imports) and `slice-12.md` §2, §5):** a package (npm, git, local)
  declares the plugins it provides in its `package.json`, `"chord": { "plugins": ["./notes", "./search"] }` (globs and
  exclusions as pi's `pi.extensions`); installing it picks up exactly those folders. Without the field discovery is
  conventional: the package is one plugin when its top has facet files, else its subfolders with a `package.json`.
  Depending on a plugin inside a multi-plugin repository is an ordinary dependency on the whole repository (npm version
  or `github:bob/plugins#<commit>`, installed by plain npm), imported by path into it (`@bob/plugins/notes/contract.ts`)
  or through its `exports`. Removed: the dependency form of `chord.plugins` (`"name": "github:...#ref:subfolder"`) and
  its own clone-and-link installer (it could delete outside `node_modules`).
- **Looks and themes (owner, 2026-11-02: "i suppose", then "do all the things"; proposal `docs/theming/`):**
  shared components come from the app's per-kind API modules (one instance in the base bundle); looks are design
  tokens, CSS custom properties on `:root` on the web, which the app's components and plugins' CSS read; plugins scope
  their CSS with CSS modules (`*.module.css`); the terminal gets the app's components and a theme lookup by role. A
  theme is data in one registry, `Themes`, shipped by the kit in its shared module with the code that writes the active
  theme as CSS variables (web) and the lookup (TUI): a base set of roles the kit defines (accent, bg, fg, muted, error,
  warning, success), apps may add roles; a user picks one dark and one light theme, the system preference chooses;
  `web` extras may name fonts and assets of the plugin under the page's CSP. Plugins contribute themes; they cannot
  change the app's base CSS or components. The open questions' recommendations taken.
- **p3 meeting, 2026-11-02 (Mario and Armin; Armin's summary, relayed by the owner):** session sync: the session
  repository talks to the server process to enumerate sessions; the session index in the server is updated by the
  worker from events and sent to the server by RPC. Sync to R2 goes through Radius: Radius keys each session by id and
  keeps its last sequence number, tells pi which sessions it has with their last sequence numbers (optimization: time
  of last sync), and pi sends the delta commit log from that sequence number; R2 stores the SQLite file and the commit
  log (SQLite DO to R2); sessions have an owner id. The index is a Chord table replicated like sessions; its entry is
  updated only on a session metadata change, a session idle-state change and a subagent idle-state change. p3: each
  host (server, worker, tui, web) has a kernel loading the plugins with contribution points via registries; p2's look
  and feel made great; new session storage; hands (machine daemons) good, secure and connecting proactively.
- **App kit naming and export (owner, 2026-11-02: "startApp > startServer?", "am i exporting an address? i'm exporting
  the store a host created", "export should stop nothing before the export, it slots into the commit queue"; refines
  slice 13):** `startApp` is `startServer` (the pair `startServer`/`startWorker`; an app always has one server).
  `exportAddress`/`importAddress` are `exportData(address, path)`/`importData(path, address)`: the data a host created
  (its store and files directory). Export stops nothing: a running worker exports its own store (`store.export()` holds
  the commit queue while it reads, so the archive is one consistent point) and its finished files to the given path,
  asked through a kit object on the worker; with no worker running, the server takes the worker's process lock (no
  worker can start meanwhile) and reads the store itself. Import still takes the lock and refuses an address whose
  directory exists (nothing is overwritten; replacing a session is delete, then import; a copy is an import under a new
  address); registering the imported host in the app's index is the app's.
- **p3 notes, 2026-11-02 (owner):** subagents may start with the main agent's context: `context: "inherit"` forks the
  parent conversation (Durable's `conversation.fork`) at the last entry before the assistant message with the spawning
  call; model, tools and location may differ; the tool's description names the cost (prompt cache only with the same
  model). pi's `/tree` (in-session branches) is wanted for p3: proposed as forks inside the session's store (edit an
  earlier message to fork, a branch list to switch; a full navigator and branch summaries later).
- **Sync applies batches with the host stopped (owner, 2026-11-02: "sure"; sync example `60-session-sync`):**
  `applyBatch` refuses while a host holds claims on the store; the sync layer stops the session's worker, applies,
  restarts it. Usually nothing runs: Radius receiving uploads runs no host for a session it does not drive, and taking
  a session back pulls before its worker starts. A live view of a replica (watching a session continue elsewhere) is a
  later refinement: fewer pulls while watched, or a read-only view without the worker.
- **The terminal's sandbox is a child process (owner, 2026-11-02: "yes"; refines "Slice 11, P8"; slice 11 recheck,
  Opus E1, E2):** the hardened worker thread was escaped twice in one review round, because downloaded code shares
  one JavaScript realm with Node's internals: E1 replaced `Set.prototype.has`, which the `require` allowlist used, and
  `require("tty")` wrote raw to the terminal; E2 patched `EventEmitter.prototype.emit` and caught Node's real
  `process` when Node emitted a warning on it (environment, `kill`, every builtin). Each fix closes one road and the
  next reachable internal is another. So the sandbox is a child process of the launcher's Node binary: stdin, stdout
  and stderr are pipes to the launcher (no descriptor is the terminal), its environment empty (only
  `LD_LIBRARY_PATH` copied when the launcher has one: needed to run the same binary, set by the user), its directory
  a private empty one, `--permission` with nothing granted (no file system, network, child processes, workers,
  addons, inspector, WASI), `--no-experimental-sqlite` (SQLite opens files past the permission model, Node gist
  https://gist.github.com/badlogic/a83cd80d0669dbcf77e029ac7b25ac96). Messages are length-prefixed binary frames on
  the pipes, not Node's IPC. The JavaScript layer stays as a second barrier (evaluation only through the bootstrap,
  the builtin allowlist, a frozen substitute `process`); the V8 code-generation toggle goes (the bridge evaluates
  strings anyway). Known gaps, accepted until Node closes them: the child can signal the user's processes
  (`process.kill`) and allocate memory outside its heap. Cost: one more Node process per terminal session (measured
  by the build against the worker). Back to a worker only if Node ships per-worker permissions.
- **Messages and languages in the app kit (owner, 2026-11-03: "i18n proposal is a go"; proposal `docs/i18n/`):**
  text people read is translated per viewer, never per server. (1) **Messages in code, per plugin:**
  `defineMessages(namespace, { en: {...}, de: {...} })` in the app's shared API returns a typed `t`; the first catalog
  defines the keys and argument types, every other catalog must match them (a missing key or a wrong argument is a
  type error); values may be functions (plurals, parameters in each language's order); dates and numbers through
  `Intl` helpers (`formatTime`, `formatNumber`) in the viewer's locale. Named keys (`newNote`), the English catalog the
  source of truth. A plugin keeps its messages in one shared file (`messages.ts`) every facet that renders imports.
  (2) **Languages are contributions:** a `Translations` registry (`{ namespace, locale, messages, override? }`) in the
  shared API; `MessagesOf<typeof t>` types a translation; a missing key falls back to the locale's base (`pt-BR` to
  `pt`), then to the first catalog, key by key, reported once; two contributions for one namespace and locale: the first
  by plugin name wins, the other reported; a plugin's own catalogs are its built-in contributions, `override: true`
  replaces one. Contributions are per host, so a translation plugin keeps its catalogs in a shared file and contributes
  them from each facet that renders (web, tui; server and worker facets only when they render final text, an email or
  a push notification). Catalogs never cross links (they hold functions). (3) **The locale is a user preference**
  (kept per principal like the theme choice), defaulting to the browser's `navigator.languages` or the system locale
  in the terminal, matched against the locales the catalogs offer; switching re-renders live (`useMessages(t)` on the
  web, the scope's redraw in the terminal), nothing reloads; the kit sets `lang` and `dir` on the page's root
  (right-to-left through logical CSS properties, the app's components). (4) **Servers and workers send keys, not
  text:** `t.message(key, ...args)` builds typed data `{ namespace, key, params }` (a `Message<"notes">`) for object
  state, notices, tool summaries and errors shown to people (a code plus parameters); each client renders it with
  `t.render` in its own language (checked at runtime across a link: an unknown key shows the key). Never translated:
  the model's prompts and answers, log lines, error codes. No translator file format now; an export/import tool to JSON
  when someone needs it. Built after slice 11 (carry-over "After slice 11"). **Refined in the build (2026-11-03;
  asked by the build, accepted by the main session):** (1) a `Translations` contribution is a list
  (`readonly Translation[]`): a contributor contributes once per registry, and the proposal's French plugin
  contributes `notes/fr` and `app/fr` from one facet. (2) A plugin's own catalogs are its built-in contributions
  literally: each facet that renders contributes them (`self.contribute(Translations, notes.translations)`), because
  `defineMessages` runs at module evaluation, tied to no host, and a host must know every locale its catalogs offer
  (the device default, a settings list); conflicts and `override` as decided (`override: true` wins over a catalog
  without it), and `t` still renders its own catalogs if a facet forgot the contribution. (3) `t` is per host:
  `useMessages(t)` returns `{ t, locale }` bound to the `HostProvider`'s host and its language, `scope.messages(t)`
  likewise (a change redraws); the plain `t(key, ...args)` imported from `messages.ts` renders in the language of the
  render under way (a synchronous render scope: nested `t` calls, `formatTime` in a message function), outside one in
  the first catalog (servers, tests, logs); no module-level current locale, since one process may run many hosts and a
  server renders per recipient. Also from the build: the typed message is `MessageData<N, K>` (the link protocol owns
  `Message`), `t.message` takes only keys whose arguments are JSON scalars, and the theme choice and the locale choice
  share one per-principal preference store (`src/surfaces/preference.ts`).
- **Chord v2 becomes the package's root (owner, 2026-11-03: "src/old", "subpaths", "yes", "yes", "no, chord is
  wip"; for merging pi-private into pi this week; trial `/home/badlogic/chord-root-move/report.md`):** `src/next` is
  the package's `src` (its main export), the Node parts `src/next-node` are `src/node` with short subpaths (`/http`,
  `/workers`, `/plugins`, `/plugins/runtime`, `/app`, and slice 11's `/web`, `/surfaces`, `/react`, `/tui`,
  `/tui/launcher`; `/surfaces` was `/next/web/server`, renamed in the run because it exports the terminal surface's
  server side too), the shared foundations Durable and env use get their own subpaths (`/json`, `/watch`, next to
  `/context`, `/delta`, `/sqlite`), `test/next` and `docs/next` move up (`test/`, `docs/`). Chord v1, which only p2
  still runs on, moves to `src/old` (exported as `/old`, `/old/node`; its tests `test/old`, its docs `docs/old`), not
  into p2 (its vitest tests and about 140 imports would need porting); it is deleted in the change that moves p2 to
  v2. No version bump: Chord is work in progress. Done by a re-runnable script (move, import and link rewrites,
  generated exports and aliases) on the base that includes slice 11; p2's imports updated in private.
- **p2 moves to Chord v2, then Chord v1 is deleted (owner, 2026-11-03: yes to the plan's eleven points; plan
  `/tmp/p2-port/plan.md`):** (1) way (a): p2's kernel, workers and plugin loading move to v2 (`createHost`,
  `createWorkers`, `createPlugins`), p2 keeps its own data directory, auth, devices and sharing, so no data migrates
  (Chord v1 stored nothing for p2; every file in its data directory is p2's or Durable's); (2) Radius Cloud Brain stays
  on its last v1 bundle and moves separately; (3) p2's web UI is p2 code again (brought back from bundled-ui) and is
  ported with p2; (4) `createPlugins` replaces p2's own loader (which leaked a module copy per reload); (5) p2 keeps its
  own SQLite files (catalog, shares, search, subagents) as natives (the rule against plugin databases is p3's); (6) p2's
  terminal uses Chord's child-process sandbox, exported upstream first; (7) `createHttp` for p2 later, optional; (8)
  Chord v1 (`src/old`) is deleted right after the switch; (9) p2's v1 plugin tutorial is retired for Chord's guide;
  (10) the phone gets it once the switch is green on slayer (owner, later the same day: "no hours on slayer first";
  was: after 1-2 days on slayer), about 10 minutes down, rollback by checkout; (11) a small shim
  reloads pages left open across the deploy, removed with v1. Server, workers, the terminal bundle and the web bundle
  switch in one deploy (v1 and v2 links do not talk); prep and cleanup steps deploy on their own. **Done
  2026-11-03:** the switch is private `16329187c` (on the phone since 12:38, data unchanged); Chord v1 deleted upstream
  `ed4f48840` (owner: "delete old chord, clean up anything related to old chord"), p2's shim, v1 tutorial and v1
  fixture generator in private `7dadff697`.
- **Mistakes that wait are reported at once (owner, 2026-11-03: "yes"; p2 port footguns 1, 2, 9,
  `/home/badlogic/p2-port/chord-footguns.md`):** requests keep waiting for providers (slice 7a), but a mistake no
  longer looks like slowness. (a) `get`, `hold` and `registry` on a host that has not loaded throw at once ("call
  `host.load` first"; a client host with nothing to load calls `load([])`). (b) When a load or reload publishes, a
  registry with contributions and no provider is reported through `onError` at once, naming the registry and its
  contributors. (c) A request waiting unbound (`not_served`, `waiting`) is reported once through `onError` after 5 s,
  naming what it waits for; it keeps waiting until its `readyTimeout` as before. (d) An invalid plugin name is a
  programming error: `load` and `reload` throw instead of listing it in the report's `failed`. (e) (owner, 2026-11-03:
  "add report"; p2 port footgun 10) Work a seal cancels before it ran (a document change or transaction waiting on its
  object's line, started with a root's, handler's or attempt's context that ended first) is also reported through
  `onError`, naming the object and the scope, besides rejecting: an empty `catch` cannot hide a change that never
  happened. The rule itself stays: what is started with a context ends with it; await it.
- **No limit on calls in progress per link; references in a method act as the caller (owner, 2026-11-03: "i guess
  it's fine without, guess we document it"; p2 port footguns 7, 11):** v1's `maxCalls` per link has no counterpart and
  gets none (the call window N bounds calls per origin; part limits bound sizes); documented. `ctx.get` in a method
  acts as the method's caller (decision of slice 4a, unchanged): a server object acting as itself towards a worker
  takes the reference with `self.get` in its own object or a server root; documented with p2's `Search.rebuildIndex`
  example in the guide and the porting notes.
- **Tutorial gaps (owner, 2026-11-03: "4. export", "3. ok", "1. b"; the tutorial's findings):** (4) Chord's root
  exports `invalid` and `forbidden`; an app's API re-exports them, so a plugin throws a decided `ChordError`. (3) An app's
  API is a real package (`"name": "@acme/app"`, `"exports": { "./v1": ..., "./v1/web": ... }`), so Node,
  TypeScript and plugin builds resolve it alike and tests import plugins' contract files; the tutorial and
  `plugin-authoring.md` show it, no Chord change. (1) **Refines "Slice 11, P4":** a component of a reloaded web plugin
  is a new function and remounts (its `useState` starts over); state that must survive a plugin update (a half-typed
  message, a scroll position) is kept by the page host: `usePageState(key, initial)` in `chord/react` (and the same
  per-key store for `TuiScope`), untouched by plugin reloads, gone with the page. Rejected: React Fast Refresh (a Babel
  or SWC transform in every web build, fragile when hooks change). Open: a live view of table rows (the tutorial's
  and 59-chat's `self.open` read at activation, which makes every reload a restart): to explain first.
- **Live queries over an object's own tables (owner, 2026-11-03: "if self.query is easy enough, and we document it as
  'there may be dragons' then i guess it's ok"; resolves the tutorial's gap 2):** `self.query(table, q, limit)` in a
  factory returns a `Watchable` of the query's rows, usable as a state member and a derive source. Chord runs the
  query before the object goes live (like loading its documents: no `self.open`, so a reload swaps the object), and
  again in the publication step of every commit of the object that touched that table, diffing the new rows against
  the previous ones (ops to watchers and holds, as for any member). Only the object's own tables (only it writes them,
  so its commits are the exact invalidation); the query is fixed for the attempt (params decide it); a limit is
  required (the third argument, as `page` takes it: the query language keeps the limit an argument of the runner;
  refused `invalid/args` at declaration; build, 2026-11-03). Cost: one query per touching commit, bounded by the
  limit; documented with a warning ("there may be dragons": not for tables written hundreds of times a second).
  Incremental maintenance of the result (an ordered, limited query with row-level changes kept in memory, re-running
  only when a removal empties the window or a bulk write hides which rows changed) is carry-over for when a case
  needs it. Rejected: a window document written beside the table (rows stored twice; app code mirroring every update
  and delete).
- **Swaps: dependents first; calls during a swap never see `not_ready` (owner, 2026-11-04: "if swaps can be invisible
  to dependents that's cool, but I fear correctness bugs"; analysis `/tmp/swap-analysis.md`):** the problem: a reload
  swapping a provider and its pure dependent (61's `todo.store` and `todo.todos(groceries)`) parked the dependent
  every time. `#objects` keeps objects in the order they went live, providers before dependents, and fates started in
  that order: the store's swap showed `loading`, the view's new attempt bound it, parked, withdrew its contributions
  (a registry gap) and unbound its holds over links (`loading` on the client). Worse, a parked swap resolved the gate:
  a call over a link whose hold was still bound (the old instance draining) got `not_ready` while the client showed
  `live`. Decided: (1) the gate (`ChordObject.call`) holds a call while any attempt activates (a swap, parked or not,
  a restart after its drain) until the object is live, failed or ended, bounded by `readyTimeout`
  (`unavailable/park_timeout`, as a call parked on a reference); a parked attempt showing `failed { waiting }`
  rejects it with that cause. When a parked swap's hold then leaves the old instance it tells the consumer `loading`
  and answers its calls in flight `unavailable` (the rule for any object leaving `live`): an error consistent with
  what the client sees. (2) A reload starts the removals first, then the other fates dependents first (the reverse
  of `#objects`); the report keeps the objects' order. A dependent's new attempt binds its provider while that is
  still live, passes its check and reads the old instance until the new one is live (one frame): the path a
  provider-only reload already takes, so no new state. A pure dependent still parks only when its new code needs the
  provider's new version (the provider's `served` changes with its own fate, so the request waits unbound, then
  parks on the swap; it never reads that version off the old instance), when its provider went live after it (a
  provider that failed live and came back), or when it needs something that is not live (a new or missing
  dependency); so a call waiting at the gate when a swap parks is rare. Rejected: same-host references showing
  `live` during a swap by changing `ChordObject.state` (holds, keyed pins, versions and `variant` read it as "a live
  instance exists"; a per-binding view is possible later, the blip is cosmetic). Carry-over: calls surviving a
  `loading` unbind (slices.md, "Later: reload").
- **Telemetry from browser pages (owner, 2026-11-04: "I just need this implemented"; "it couldn't really fuck the
  server up"; tutorial gap):** a page records spans in memory (the click and the calls it makes, carriers on its calls
  as any client) and sends finished spans in batches every few seconds and when hidden, over its existing Chord link,
  to a telemetry object on the server (`ingest(batch)`): sign-in, principals, part limits and flow control apply as for
  any call; an app may admit anonymous pages. The server treats them as untrusted, best effort: batch size and rate
  capped per connection, every field checked and capped (names, attributes, events, ids printable ASCII), spans marked
  as from that browser (`chord.host` `browser`, ids prefixed per sender by the store), never overwriting or posing as
  server spans; the store writes finished spans it receives (a new ingest path). The viewer clamps a browser span
  against its server children (clock skew). General Chord: the page recorder in the web surface, the ingest facet, the
  store's ingest; the app kit serves the object when given a telemetry store and `startPage` records when the app asks.
- **Who a span was for (owner, 2026-11-04: "that hook could also allow us to resolve the username and put that in the
  telemetry if we're fine with that"; refines "IDs are attributes of spans" for principals):** method and call spans
  record the principal's attributes, by default its principal key (`chord.principal`), never other app data. A hook in
  the host's telemetry options maps a principal to the attributes to record (none, the key, or more, e.g. a user name
  the app resolves from its own data). Chord calls the hook for each span it records with a principal; the hook must be
  synchronous and cheap, and caching is the hook's own (owner: "the caching should be done by the hook"). The hook is
  a Chord host option (`createHost({ telemetry, principalAttributes })`); the app kit passes it through `startServer`
  and `startWorker`. Browser spans are stamped with the principal of the
  link their batch came over. The viewer stays the owner's and filters by principal.
- **The server is the one place telemetry is stored (owner, 2026-11-04: "who stores all the telemetry? There must be a
  single place ... the client and the worker would just talk to that object on the server"; refines "Telemetry from
  browser pages" and "Telemetry store"):** the server owns the telemetry store and is its only writer. Browsers and
  workers record in memory and send finished spans in batches over the links they already have to the server's
  telemetry object (`ingest(batch)`), which checks, stamps (`chord.host`, the link's principal for browsers) and writes
  them. Browser batches get the strict checks and caps; a worker's (the server's own child, a trusted link) are
  written as they are, stamped with the worker's host. No worker opens the store file; nothing passes its path to
  workers. The store stays its own SQLite file in the data directory, not the server's Chord store (high volume, 7-day
  retention: it would compete with app data in the commit queue and travel in exports and sync).
- **Calls in flight survive a `loading` unbind (owner, 2026-11-04: "dunno, ask reviewers"; both reviewers, Opus
  `/tmp/calls-survive-opus.md` and `/tmp/calls-survive-2.md`: build it; refines slice 7b's wire rule "A `failed` on a
  bound hold unbinds it"):** a hold unbinding with `loading` (a restart, a parked swap, a live failure retrying) keeps
  its calls in flight instead of rejecting them `unavailable`; `failed` and removal still reject. Each kept call gets
  exactly one answer from what it already waits on: the instance it runs on (its result within `closeTimeout`, else
  `released` at the seal) or the gate (the new code's result, `park_timeout` after `readyTimeout`, the parked cause, or
  the object's end). Not rare: every restart of an object with natives hit it (a client still `live` during the drain
  sends a call that waited at the gate). Calls sent before the client learns of the `loading` and arriving after the
  unbind wait at the gate too (the unbound hold keeps its old method names, as the swap-in-place rebind does), never
  `not_ready`. Consumers and relays need no change (they keep sent calls across `loading`; a method the new variant
  lacks fails `invalid/member`, a dropped version `contract_mismatch`). Cost: kept calls hold call-window slots up to
  `readyTimeout` while the object is parked.
- **The rollout order stays; no `loading` grace (owner, 2026-11-04: "either order has the problem, just in the
  opposite host", "keep"; "no loading grace"; part of the restart-only discussion, `/tmp/restart-study.md`):** (1) The
  kit keeps server, then workers, then clients. A contract change between hosts made in one rollout leaves a gap
  whatever the order: a consumer on an earlier step whose provider on a later step moves to a new version waits
  `failed { waiting }` (with its last values) until the provider's step commits (server first: server consumers of
  worker types; workers first: worker consumers of server types). `accepts` cannot close it within one rollout (the
  old provider never serves the new version). Documented with the recipe that avoids it: two applies, the provider
  first (serving the new version and accepting the old one), then its consumers. The reload suite's two `it.fails`
  targets for it become documented-behaviour tests. Rejected: the kit ordering steps by the direction of the changed
  contracts (works only when every change points one way). (2) No grace on consumers' `loading` (a reference with
  values reporting `loading` only after ~300 ms): rejected from the restart-only proposal.
- **Reload restarts every affected object; old work finishes on old code (owner, 2026-11-05: "if you think the new
  model is good, just ... fix p2"; the final design round: `/tmp/reload-final-brief.md`, three reviewers, model LS3
  `/tmp/reload-final-step3-restart-study.md`, accepted by the attacking reviewer `/tmp/reload-final-step3-reload-review-2.md`;
  supersedes the pure swap of slice 7b §5, "Swaps: dependents first", parked swaps and the swap handover of routines
  and jobs):** the problem: a restart makes new calls wait until the old attempt drained, so any wait of old work on
  something that needs the new attempt closed a cycle that only `closeTimeout` broke (a provider's running call
  reaching its dependent through `ctx.get` while both restart; re-entry; mutual calls; the same across hosts). The
  rules: (1) a reload restarts every live object of a changed plugin (no swap in place); documents and tables stay,
  F-a, F-b, F-c of the restart study apply. (2) **Old work** (the calls running at the commit and every call they cause,
  found through the call chain in `ctx` on one host and an `old` flag on `call` over trusted links, never honoured from
  untrusted ones) runs on the target's open old attempt; a getter of old work for a version the new code dropped binds
  the open old attempt or fails at once. (3) The old attempt seals once its own calls and the old work routed to it
  drained and its successor's requests (as staging recorded them, bound after every fate of the reload started) are
  live or failed for a reason other than another host's version skew, bounded by the reload drain bound
  `reloadDrainTimeout` (default 5 s, at most `closeTimeout`); only then the successor's factory runs, so no new
  declaration meets old work. (4) **New work** waits at the gate and runs on new code. (5) A same-host consumer whose
  version the open old attempt binds sees the object live meanwhile (its new code may read the provider's old state
  for up to the drain). (6) A wait of old work that its own open old attempt blocks through parked dependencies or an
  opener's gate waits fails at once, `unavailable/reload_cycle`, naming the chain. What remains (waits that leave
  Chord: roots opened without the method's `ctx`, Durable tasks, an app's locks) ends at the reload drain bound. The
  bound cuts any method still running then (`released`): long work belongs in jobs (in-memory runs end `aborted
  { reload }`, persisted ones resume per `resume`). A restart whose successor finds a failed request is reported
  `parked { cause }`. Built as one change with the restart-only removal of the swap.
- **A call's answer follows its state (owner, 2026-11-05: "seems doable without any big downsides"; Petr's report
  that p2's UI is not optimistic):** before a host sends a `result` (or forwards one as a relay), it sends the page's
  pending `state` for that origin, past the window if the window is full (bounded by the calls in flight). So when a
  call resolves on the page, every change the answering host (and a relaying host) committed before answering is
  applied there. Pages show optimistic values with React's `useOptimistic` (a helper for `TuiScope`), dropped when the
  call settles; Chord changes no replicated state. Not covered: changes committed later (a method that returns before
  its effect) or on another host that does not relay the answer. The guide's rule: a method that should feel instant
  awaits its own changes and keeps them on the host that answers.
- **App authoring rules confirmed by the p2 audit (owner, 2026-11-05):** state that lives outside Chord (a native's
  store, a Durable document) is shown through `self.follow` of its synchronous observer, never copied into a Chord
  document by a routine; long work is a job, never a method or a root a method awaits; a root opened inside a method
  takes the method's `ctx` (without its cancellation); a session's worker owns its data and pushes what the server's
  index shows (title, branches, working state) to the server inside the method that changed it, never pulling from
  the server. p2 is rewritten by these rules (audit `/tmp/p2-optimistic-audit.md`).
- **Files v2 (owner, 2026-11-05; p2's per-host stores brief):** the kit's `Files` is replaced (`chord.app.files`
  version 2; the version 1 index, one document holding the whole map, is not migrated: nothing outside tests and
  examples used it). One object per host, bytes in the host's `files/blobs/`, index in four tables of the host's
  store (`files`: one row per version; `folders`; `blobs` with a reference count; `paths`, high-water marks) plus two persisted documents
  (`summary` per space, `usage`). Spaces and paths, folders as index entries, moves in the index only, immutable
  blobs with versions, `copy` sharing a blob, chunked writes as before, idempotency keys, fixed indexed metadata and
  free `meta`, a summary per space, `copyFiles` and `filesFacet` exported. Decided in the build: (1) a version's id
  is the id plugins keep (`FileInfo.id`); paths and version numbers are found through the index. (2) A version
  number is never used twice for a path (owner's review, 2026-11-05: transcripts and links name an artifact by name
  and version, so a reused number would show an old card new bytes): a `paths` table keeps each path's highest version
  ever, through removals of versions, the path and its space; a new version is one past it. A move carries its
  versions' numbers: the path left keeps its mark, the path moved to takes the higher of the two. (3) Changes of one `Files` object take turns (an in-memory queue
  per attempt): a version number, a key's uniqueness per space and a blob's count are decided by reads before the
  one transaction, never by a unique index (`key` is `""` when absent, and index columns cannot be `opt`). (4) A
  folder listing shows the folder's folders first, then its files' newest versions, each by path; its cursor names
  the part it continues. (5) Live listings are a second local type, `FilesFolder({ space, folder })`, following
  (`self.follow`) what `Files` hands it: `self.query` is fixed per attempt and only for the declaring object, and
  folders are dynamic. `Files` reads every watched folder of a changed space once, inside the changing method (one
  read per watched folder and change). (6) The summary keeps the newest 20 versions by `created` (ties by id),
  changed in the same commit as the change (the newest after a removal read before the commit, excluding what it
  removes). (7) The total cap counts the blobs on disk (the `usage` document), so a copy costs nothing. (8) Blob
  files a crash left without their commit are swept when the object goes live (one index read per blob file, under
  the change queue). (9) `copyFiles` imports the part of the source store's export that is `Files`' own into a new
  store and hard-links each blob (a copy where links are refused) while the export holds the source's commit queue,
  so no removal can delete a blob the copied index names; it refuses an existing target. (10) `meta: null` is stored
  as absent; space names are `[a-z0-9][a-z0-9._-]{0,63}`, paths at most 1,024 characters without empty, `.` or `..`
  segments. (11) `cancel(upload)` drops an upload a writer gave up (a server route whose client went away), so it
  holds neither a slot of the cap nor bytes for the hour until it expires. (12) `@earendil-works/chord/app/files`
  exports `Files`, `FilesFolder`, `filesFacet`, `copyFiles` and the kit's private directories and stores without the
  rest of the kit, for an app's worker process that must load neither esbuild nor the server's components (p2's). (13) A
  write takes an optional `created` for imports (owner, 2026-11-05, after p2's migration dry run: every migrated file
  had the migration's time, so newest-first orders meant nothing): the version keeps the time it was made elsewhere;
  the summary's newest versions are kept in `created` order, not write order.
- **Workers start from the base code the server booted with (owner, 2026-11-04: "let's do this for armin"; Armin's
  incident report, Radius artifact 01m6m3xek8fveayqgstayg8w92):** the problem: a worker loads its entry module and the
  base code it imports from disk when it is forked, while the server keeps what it loaded at boot. An edit of the
  app's own source while it runs (an agent half way through a change) makes every later fork run other base code than
  the server: a crash while loading modules fails the start before `started` (and R2 keeps the address failed after
  the edit is finished), or the two sides run skewed code silently (`PROTOCOL_VERSION` stays 1 until p3). Design §21
  says base code applies only through a restart of the server; nothing enforced it for workers. Rule: the workers
  component builds its worker entry once when it is created, as the surfaces build their base bundles at start (one
  esbuild bundle for Node), and forks every worker of its kind from that snapshot; a change of base code reaches
  workers only through a server restart, which the kit's `base` mark flags. Plugins are unaffected (workers get the
  server's built scripts). What the bundle keeps external (Node builtins, packages that cannot be bundled, such as
  native addons) is settled by the build. p2 adopts it through its own `createWorkers`.
- **The kit's owner is a principal the app chooses (owner, 2026-11-06: "ok"; p3's principals are `user`, `guest`,
  `worker`, `server`, with no `owner` kind):** the kit hardwired the owner as `{ kind: "owner" }` (the owner link,
  the owner token file and device pairing issue sessions for it; pairing's confirm and approve, invites and a
  pairing's starter check `kind === "owner"`; `AppOptions` required the variant in the app's principal type). Rule:
  `startServer`'s `principal` option takes `owner: P` beside `server` and `worker`; every place above issues sessions
  for that principal and recognizes it by canonical JSON (compared once per principal object, as the principal key);
  the type requirement and the kit's `OWNER`/`OwnerPrincipal` exports go; `principal.worker` is required only with
  worker kinds (a type error otherwise; added in the build for p3's first step, which has none). The owner is strict
  JSON and never the server's principal (refused at start); the kit serves it as start data (`AppInfo.owner`), so
  invites read it there. Changing `owner` between starts replaces the owner token file and revokes its old session;
  other sessions issued for the old value stay what they were (the app revokes them if it wants). The kit stays
  (owner: keep it and change it where it does not fit, rather than wiring p3 from the components: the kit keeps p3's
  base code, which only a restart changes, small).
- **A reloaded UI part shows its loading state (owner, 2026-11-06: "not worth it imo. a short loading state is
  absolutely fine. this just adds more bugs and footguns"; p3 step 0a, rejected proposal `apps/p3/docs/step-0a/`
  version 2, reviews `/tmp/p3-step0a-astra.md`, `/tmp/p3-step0a-sol.md`):** after a web or terminal plugin's reload
  its components remount and make new references, which show `loading` (no values) for one round trip until bound;
  the rest of the page, and every reference of a server or worker reload, stay live (design §21). Rejected: a
  per-host table sharing references between UI components (`useHold`, `useRegistry`, `TuiScope`), released when no
  component and no call uses them. It covered only a same-update replacement of facet-contributed components; it
  needed the host address in its key, a lease state machine for ended references, counting of parked and queued
  calls, a borrowed reference type without `release`, and changed presence counts (one entry for several components;
  a never-settling call keeping it). The three bug fixes of step 0a stay (stylesheets loaded before the plugin reloads,
  base bundles built with the server's resolution conditions, the restart mark by content).
- **A restarting page object's old UI may show unstyled (owner, 2026-11-06: "A"; step 0a):** a page applies a plugin's
  new stylesheet when its new code is adopted and retires the old one a drawn frame after the reload. UI a plugin's
  facet contributes is replaced in that update and always styled. UI contributed by an object in the page stays on its
  old version until the restarted object's successor is live (design §21); classes the edit renamed or removed are
  unstyled until then. Accepted and documented; apps contribute UI from facets and let objects supply data. Rejected
  for now: a kernel signal "this plugin's restarts on this host finished" to retire old sheets later.
- **The kit serves the reload control (owner, 2026-11-11: "approve of AppChanges"; p3 step 0, decision 1):** the kit's
  plugin marks (`app.plugins.state`) and `app.applyChanges` were reachable only from the start script, so applying a
  change from a page, a terminal or an agent tool would need base code (a signal handler or a route in the start
  script), against p3's "Reloads first". The kit serves `AppChanges` (`chord.app.changes`, remote, on the server,
  params `{}`) to the app's owner only (any other principal: `forbidden`): state `marks` (the plugins component's state
  as it is) and `apply()`, which runs `applyChanges` and answers `{ steps: { name, failed: string[] }[] }`. The app
  re-exports the token through its server API. Rejected: applying on a signal or a start-script route.
- **Call windows only for untrusted links (owner, 2026-11-11: "make the limit ten thousand"; from the Pong netcode
  discussion):** the call window N (design §3) bounds how many calls one caller runs at once on a provider; calls past
  it wait in the caller's own queue, so a client that fires too many only slows itself. No saturation by calls was
  ever observed, and the app's own hosts are assumed to behave: a link a host accepts as trusted (`trusted: true`)
  has no call window (`hello` announces 0). An untrusted link (pages, guests, view frames running agent-written code)
  keeps one, a host option `callWindow`, default 10,000 (was a fixed 256 in `remote/host-link.ts`): many people may
  have much in flight, and a misbehaving page still cannot start unbounded handlers. To be built with the events
  change if that is decided, otherwise on its own. Built with it (2026-11-11, spec `events/spec.md` §3): `hello.calls`
  is optional, absent on a trusted link (the binary codec writes 0, which no window is; "no hello yet" stays a state of
  its own in the code); relays honour each upstream window (relayed calls of an origin wait in a FIFO per upstream link
  and origin, following the relay's own queued calls' lifecycle, rejected `unavailable` before a new `bound`'s `ack`
  passes upstream), which closed slice 4a's carry-over "one N on every host".
- **Events: fire-and-forget members (owner, 2026-11-11; spec `events/spec.md`, third draft after two rounds of reviews by
  Astra and Sol; the Pong netcode discussion):** a contract member is state, a method, or an **event**: a JSON value an
  object emits, delivered once to each reference bound to the object before the emit and still bound when it is sent,
  never folded, never kept, never sent to a later holder, dropped for a holder that cannot keep up. State folds and keeps
  the newest value, right for what a joiner needs and wrong for motion (a paddle sample is worthless a moment later and
  interpolation needs the samples between). (1) Contracts: `events` in a remote variant, the local marker `event(schema)`;
  one kind per name across the history; JSON only; the fingerprint lists events under their own kind (contracts without
  events keep theirs); edits `addEvent`, `removeEvent`, `event`; `accepts.events` maps a changed event per variant (or
  refuses its version's binding), a removed or added one needs nothing (an older consumer receives none of it), a no-op
  edit needs an identity mapping. (2) Types: `EventMember<T>` (`on(listener, ctx)`, references expose only it),
  `EventSource<T>` (adds `emit`, `self.events<T>()`), `EventSubscription` (`stop`); an implementation is the attempt's
  own source or a reference's member (re-exposed, value and `at` unchanged), anything else fails `broken`. (3)
  `self.events` is a declaration (inert in staging, owned by the attempt: `emit` after its seal throws `released`); an
  emit is immediate, no transaction work; `at` is the emitting host's `Date.now()`. (4) Delivery, one rule: emits wait for
  the event flush, a microtask the first queues, which sends after every state message published before it; each binding
  records the host's emit counter when it is made (a hold at its `bound`, a reference at its binding to the instance; an
  arrival takes the receiving host's next value) and gets only later entries while it stays that binding; one `event`
  message per link and origin, then the same-host listeners outside the reentrancy fence, entry then subscription order;
  a throwing listener ends its subscription (`listener_error`). (5) Wire: `event { origin?, events: [{ hold, member, at,
  value }] }`, `ack.events` (messages consumed: parsed, inflated, delivered or deliberately dropped; one per origin per
  inbound turn; never combined with a state ack), an event window per link and origin at the emitting host (host option
  `eventWindow`, default 32: a full window drops that flush's entries, counted, nothing queues), event tickets naming
  each message's sender (relays forward at once, filter entries as for state, never acknowledge themselves: an early ack
  of a filtered message would credit an earlier sender's message still unconsumed downstream). (6) Versions: one mapping
  per emit per bound older version, kept while a reference of it is bound; a throwing mapping drops that emit for that
  version, reported once per failure episode (`event_mapping_failed`). (7) `useEvents` in `chord/react`, `TuiScope.on`.
  (8) Metrics `chord.events.emitted`, `sent`, `dropped { reason }`, `encodes`. Outside Chord: a clock (an app's `now()`
  method), consumer-to-provider events (calls through the client's latest-only outbox), netcode policy, unreliable
  transports (WebTransport later). Rejected: a stream type (design §31: events have no backpressure, replay or restart
  rules), a subscription message per member (every bound hold gets its variant's events; a consumer without listeners
  drops them on arrival). Settled by the build's code reviews (Astra and Sol, 2026-11-11; the strict rule by the
  owner): (9) a relay forwards a hold's `release` upstream before it frees its forwarded calls' slots (else a call of
  another hold could reach an honest finite-window upstream before the release that ends them there, one call too
  many); an `abort` is forwarded, then frees its slot. (10) The strict failure rule holds over links too: a hold whose
  object no longer shows it live untaps its events at once, while its state follows the admitted commits; an emit its
  object failed after in the same turn reaches no holder anywhere. (11) The event window is checked per entry before
  any encode (it cannot change during a flush), and a consumer drops a value nothing listens to before any inflate or
  parse. (12) Contracts without event members cost nothing per binding (no event records, nodes or taps; shared empty
  name lists), measured against the commit before events (`benchmarks.md`). (13) `useEvents` updates its listener in
  a layout effect (an event between a commit and its passive effects reaches that render's listener).
- **Documents and table rows can belong to a host (owner, 2026-11-09: "it looks like we have a plan"; p3 session data,
  backups and exports):** data needed while a host is not running lives on another host (p3: facts about a session the
  server needs while its worker is off) but must travel with that host on export, import and delete. (1) `defineState`'s
  `keyed` takes `true` (string keys, as today) or a **host kind**: keys are then addresses of that kind
  (`bindings.change(Session({ id }), fn, ctx)`, typed `KeyOf<K>`), stored with the address key in `key` and in a new
  indexed `host` column of `chord_documents` (NULL for string keys, so a string can never pose as an address); store
  schema migration to version 3. (2) Tables get a column type `host(Kind)` (at most one per table): the value is an
  address (written and read as `Address`, stored as its key, indexed automatically); the table catalog records it. (3)
  Two store operations: export the records and rows belonging to one address (a filtered archive in the existing format:
  manifest, `document.create`/`document.revision` parts of records with that `host`, per table with a host column its
  definition and `put` parts of its rows, `end`), and import such an archive into a store that already has data (fresh
  ids and seqs; an existing record or row for the same address refuses unless the import is an explicit replace; a copy
  under a new address rewrites only the host columns and keys). Delete retires those records and rows. (4) The kit's
  per-address export, import and delete (`exportData`, `importData`, archive) include the server's records and rows
  belonging to that address, next to the host's own store. Migration of imported content happens when the owning
  object loads it, as for every document. Plugins must not put addresses inside JSON values they expect to be rewritten.
  To be specified, reviewed and built (p3 status 2026-11-09). Built 2026-11-09 (spec `host-keyed/spec.md`, reviewed by
  gpt-6-astra and gpt-6.1-sol). Owner decisions in review: (5) no checks a forged archive could defeat anyway and no
  guards against plugin mistakes: no fingerprint or metadata comparison of archive tables (the store's own host column
  and a per-row target check are enough), no re-validation of decoded address keys, no refusal of dropping the
  automatic host index, no host-data guards after `host.close()`; (6) the kit has no recovery journal: import unpacks
  into staging, moves the old directory aside, renames staging into place and commits the server's part last (definite
  failures undo the renames; an unknown outcome keeps everything and is reported); delete commits the server's part
  first, then removes the directory; the remaining crash windows are documented (re-run the import with replace; a
  repeated delete removes an orphan directory). Host-keyed keyed members (`keyed(schema, Kind)`) and migration of older
  archive tables through the owner's `evolveTable` history are part of the build.
- **A plugin's npm dependencies are bundled; external only by opt-in (owner, 2026-10-29: "explicit opt in + (a)"):**
  a plugin's `dependencies` are installed into its own `node_modules` (`npm install --ignore-scripts`) and bundled into
  each facet that imports them (host packages, its `peerDependencies`, stay external and are passed in). On Node a
  plugin may keep named packages external with an explicit list in its `package.json` (`"chord": { "external": [...] }`):
  server and worker facets then load them from the plugin's `node_modules` (`createRequire`, as pi 1.0 loads extension
  dependencies), native addons included; they stay in Node's module cache until the process ends, so a new version
  takes effect after a restart. A browser or TUI facet importing an external package fails to build. Slice 7b
  (the loader).
- **The dependency model is decided (owner, 2026-10-29: "just build this"):** `packages/chord/docs/dependencies/model.md`
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
  address alone (dependency model, `packages/chord/docs/dependencies/`). Tests and examples get `placement: () =>
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
  and the underlying implementation fast and correct, we're ok". v2 (`src/next`) is about 13.2k lines without blank lines
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
  `test/bench/store.ts` measures the store without outbox against Durable's `SqliteStorage` per commit on (a) a
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
- **Slice 4a approved (owner, 2026-10-24):** `packages/chord/docs/slice-4a.md` as revised after the reviews. Build
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
- **Slice 4a spec decisions (owner, 2026-10-23; `packages/chord/docs/slice-4a.md`):** a heartbeat on every link
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

## Simplification audit (2026-10-30)

The owner asked, after slice 7b's seven fix rounds, how many other mechanisms serve a rare case at a high cost. Audits
by Opus and Sol (`/tmp/audit-{opus,sol}.md`) and this session; each item decided by the owner with its code and case.

- **A1, `installing` is cut (owner, 2026-10-30: "cut"):** model §1's state for a hold or request that does not fit the
  running code while a reload stages: staging is synchronous (`stagePlugins`, `recordFactory`), so no message or caller
  can arrive while it runs (the only test reached it from a factory calling back into the host). The `Serving` kind, the
  host's map, `Hold.start`'s branch and the test go. During the app's bundling before `host.reload` the old code
  answers a mismatch `failed { waiting }` until the commit wakes the request (model §5's accepted gap). Supersedes
  model §1's `installing` row and design §21's installing sentences.

- **A2, static registry cycle edges are cut (owner, 2026-10-30: "yeah cut"):** the edges a contribution of another
  registry's value recorded (`RegistryEdge`, `#reads` counts, `assertNoCycle`, `#reaches`, an attempt's pending edges,
  staging's edges) go; the runtime guard stays (a registry read while it composes throws `invalid/cycle`; the
  contribution that read it is left out and reported `contribution_failed`). A ring of registries is caught at its first
  composition instead of at `self.contribute`: the contributing object goes live, the rest of the registry works.
  Supersedes slice 8's "a cycle of registries reading each other refused when the second one serves or contributes".

- **A3, routine calls keep their ops (owner, 2026-10-30: "keep"):** `self.on` handlers keep `{ value, ops, retired }`
  with the routine's own folding (`PendingOps`, the basis after a throw).

- **A4, cross-host activation chains stay (owner, 2026-10-30: "yep keep"):** they catch the common, sequential form of a
  cross-host dependency ring (one request whose activation creates the other side) with an immediate `invalid/cycle`
  naming the path; `parked_long` stays the slow net for the rare simultaneous race.

- **A5, retry propagation by a hop budget (owner, 2026-10-30: "b if correct"):** `ref.retry()` still passes on from a
  parked object to its failed dependencies (model §3.7), but its dedupe is simpler: on one host one retry's walk keeps a
  visited set (a diamond retries a shared dependency once); across links the `retry` message carries a hop budget (an
  integer, 16 from the first host, one less per host, dropped at 0) instead of the operation id (uuidv7), the objects'
  last-8 remembered ids and the `through` list. Bounded effects, both harmless: a diamond across hosts may send a shared
  dependency two retries (the second meets it activating and is ignored, or starts one more attempt if the first
  already failed); a waiting ring across hosts (the undetected simultaneous cycle) passes the retry round until the budget
  runs out, starting no attempt (parked objects only pass it on). Instance ids stay (activation chains, A4).

- **A6, staging factories against a recording `self` stay (owner, 2026-10-30: "keep"):** a throwing new factory keeps
  rejecting the whole reload (the host stays on its old code), and each object's fate is decided from its recorded
  declarations before the commit.

- **A7, registry last-good with provenance stays (owner, 2026-10-30: "a").**

- **A8, deferred job-state persistence keeps its held ops (owner, 2026-10-30: "keep").**

- **A9, a pure swap sends holds a fresh `bound` (owner, 2026-10-30: "simplify"):** a hold over a link whose object
  swaps in place gets a fresh `bound` (one snapshot of its members), the path a restart, a variant change and a version
  change already take, instead of a re-subscription with `[["r", value]]` per changed member (`Hold.#rebound`, its
  constant-to-source and failed-member cases, `currentOf`). A tab's watchers may get one frame for an unchanged member;
  nothing is lost or stale. Supersedes design §21/§22's per-member `r` rule for holds after a swap.

- **A10, one rule after a live failure (owner, 2026-10-30: "simplify"):** every member of a failed live instance keeps
  being followed (references and holds) until the commits it admitted published (`documents.settled()`), then all stop:
  the restarts' rule. The "own" against "foreign" split (`#follows === "own"`, `Attempt.owns` and its mapping-derive
  case, `Hold.#stopForeign`) goes; a re-exposed member of another object may show one more change in that window.
  Refines 6a's build-review rule "members following another object's sources freeze at once".

- **A11, `parked_long` widened (owner, 2026-10-30: "widen"):** reported once per parking episode when an attempt has been
  parked longer than its `readyTimeout`, whatever its blocker (the first in declaration order named, with its state);
  the remote-loading condition, `heldOnLink` and the clock restart at a link go. Also covers a cross-host ring one of
  whose members waits on a failed dependency. Supersedes decision 6's narrow condition.
- **A12, the routine fence token folds into the seal (owner, 2026-10-30: "fold"):** one seal token per attempt; after a
  swap the old routine calls get `closeTimeout` to finish, then the whole old attempt is sealed (its method calls had
  the same bound). `RoutineContext.fence` and the token choice per transaction go. Supersedes slice 7b decision 4's
  separate token.
- **A13, the table version fence stays (owner, 2026-10-30: "keep"):** an old call stuck past a restart's drain never
  issues SQL against a migrated table (which would stop the store and close the host).
- **A14, key pins keep their hand-over between instances (owner, 2026-10-30: "keep").**

- **A15, keyed members across objects stay, with their versioning (owner, 2026-10-30: "keep essential"):** they fill
  the gap P3 creates (a view with params following one entry of a persisted store live); the alternatives (a singleton
  map, a method) are weaker.

Summary: cut A1 (`installing`), A2 (static registry cycle edges); simplified A5 (retry hop budget), A9 (a fresh `bound`
after a swap), A10 (one rule after a live failure), A11 (`parked_long` widened), A12 (one seal token); kept A3, A4, A6,
A7, A8, A13, A14, A15.

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
- ~~**Rollback is all-or-nothing per host:**~~ (**superseded** by "Per plugin at startup and reload", 2026-10-30) any load or staging error leaves the host entirely on its previous code.
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
- **HTTP is an optional Chord component** (**superseded in part** by "Slice 10's points": `html` instead of `page`, request bodies through `json`/`body`, authentication one app hook, plugin sockets instead of a channel component until a second user) (`@earendil-works/chord/http`): a route gets a plain request summary
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

Everything else from earlier lists is decided (see the entries above and `packages/chord/docs/design.md` §26).

- **Future goal: deploy Chord apps to Cloudflare Durable Objects and similar platforms.** Hot reload there is not
  needed; composition through plugins is (plugin set fixed at deploy). Research in `research/chord-on-durable-objects.md`.
- Deferred until a concrete case: jobs as objects and where a flow lives (when login is ported); project plugins.
- **Chord from code mode scripts** (owner, 2026-10-30: "something we want"; p3): the agent's code mode scripts get a
  Chord call scope (`host.root`) to call objects and change things: `chord.get("notes.store", {})` by name, every
  argument checked by the provider's closed schema. Needs, to design with p3: a principal for the agent (acting as who
  runs the session, so views apply their authority; never the owner's powers in a guest's session), a by-name `get`
  and a list of served contracts with their members and schemas (the agent's declarations), values crossing the
  sandbox boundary as plain data, the scope sealed when the script ends.
- **Every object may contribute** (owner, 2026-10-29: "note it down as something to consider for the future; can be
  changed later without a need for migrations"): lift R21 so objects with params and `remote` objects contribute too;
  the entry lives while the object is live, its identity is the object's (type, params, principal key); `contribute`
  on every `self`. Not decided; R21 stands.
- p3 domain points (decided per domain when p3 is designed): `SessionFiles {session}` (proposed), session delete,
  connection pools, config files with a single writer, file formats as versioned interfaces, the terminal host
  process as a revision artifact.
