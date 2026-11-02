# Slice 10: HTTP and workers (spec)

Status: **built** (2026-10-31; build reviews by Fable, Opus, Astra and Sol, security audits by Fable, Opus and Astra, four fix rounds with rechecks; the shape after the fix rounds is in §2, §3 and design §23). Approved by the owner (2026-10-30: "just build it"; D1-D12, D10b, round 1's R1-R6 and round 2's Q1-Q6 in the
decision "Slice 10's points"; spec reviews round 1 by Fable and Opus, `/tmp/s10-spec-review-{fable,opus}.md`, round 2
by Fable, Opus, Astra and Sol, `/tmp/s10-spec-review2-*.md`, folded in).
Slice 10 builds two Node components of the app kit (decision "Slice 7b's open points" (6)): `chord/next/http` (the
server's HTTP and WebSocket entry, routes contributed by plugins through a registry, responses as descriptions) and
`chord/next/workers` (a worker process per host address, started on demand, stopped when idle, its plugins shipped from
the server). Both live in `packages/chord/src/next-node/` (Node-only); the kernel stays portable. The web page host and
the TUI are slice 11, telemetry slice 9.

Read in full before writing code: this spec; `decisions.md`; `design.md` (§3 hosts, routes, `host.activity`, §17,
§18, §21 "Loading plugins and the reload loop", §23 in full); `slices.md`; `slice-7c.md` and
`src/next-node/plugins/README.md`; the 7b brief `slice-7b/book.md` (chapters "Assets and Files", "HTTP", "A Mini p2
from Chord"); p2's `src/hosts/server.ts`, `src/runtime/server.ts`, `src/hosts/worker.ts`, `src/hosts/socket-limits.ts`,
`src/hosts/principals.ts`, `plugins/files/server.ts`, `plugins/terminals/server.ts`, `plugins/radius/server.ts`; Chord
v1's `src/manager.ts` (`processLock`, `forkDriver`, `createHostManager`, `childControl`).

## 1. What p2 has, and what moves into Chord

p2's server host (`src/hosts/server.ts`, 742 lines; `src/runtime/server.ts`, 720) does, besides p2's own policy:

| p2 today | Moves to |
| --- | --- |
| a Node `http` server on loopback, requests parked until `load` resolved, upgrades captured before listening | `http` |
| `Routes` (`"METHOD /path"`, `/prefix/*`), handlers writing Node's `ServerResponse` themselves (ranges, download headers, `HEAD` by hand in `files`) | `http`: routes returning descriptions |
| `Upgrades` (a WebSocket by path for terminals and voice), `/chord` (`acceptWebSockets` with per-socket limits) | `http` |
| `Authenticators`, `RequestResolvers` (cookies, devices, the Radius relay), Fetch Metadata, CSP and the loopback cookie | the app (p3's base code), through `http`'s `authenticate` and `headers` (D3) |
| loopback and allowed hosts, the `Origin` check on upgrades | `http` (R4), allowed hosts contributable by plugins |
| `SessionHosts`: a worker per session, `createHostManager` + `forkDriver`, a kernel lock per session, idle stop from reported counts, crash notices, sticky failed starts, ready timeout | `workers` (failures stay until Retry or a rollout, R2) |
| relocation and pause of a worker, the catalog, `WorkerInitValues` | the app (built on `workers`' `stop` and start data) |
| `hosts/worker.ts`: the child's control channel, lock, start data, connect, load, report counts, shutdown | `workers`' child side |
| the dev reload across server and workers, worker plugin lists | `plugins` (7c) plus `workers`' rollout step (§4) |

Every option that is not bootstrap is changeable by plugins (decision "The app kit is malleable by plugins"): either a
contribution to `Http` or a function the component calls per use, which the app backs with its own registries;
nothing is copied out of a contribution or an option at startup. Bootstrap (changed by a restart): the listen address
and port, the links path, the worker entry with its `execArgv` and `env`, the host kind workers serve.

## 2. `chord/next/http`

As built after the fix rounds (decisions "The HTTP core is a fetch handler", "The HTTP server is a native object",
"Settings are arguments, extensions are registries", "The HTTP component's security baseline", "allowed hosts only
through contributions", "A CSP nonce per response", "three small points", "a route's overhead accepted"); design §23
states every rule, `src/next-node/http/README.md` the API.

```ts
const http = createHttp(server, {
	listen: { host: "127.0.0.1", port: 8788 },                        // settings: arguments, a restart to change
	links: { path: "/chord", options: (request, principal) => ({ limits: linkLimits(principal), maxPayload: 64 * MiB }) },
	closeTimeout: 30_000,
	onError: (error) => log(error),                                   // `HttpError`, below
}, ctx);
const app = defineFacet((_host, self) => {
	self.contribute(Authenticators, (request, ctx) => principalFromCookie(readCookie(request, "session", secret)));
	self.contribute(Http, { hosts: ["notes.example.com"], relays: [radiusRelay] });
});
await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }, { name: "@app/core", facet: app }], modules }, ctx);
…
await http.close(ctx);   // first: no new requests, sockets closed, running requests waited for up to `closeTimeout`
await workers.close(ctx);
await server.close(ctx);
```

- **The core** is `http.fetch(request, { localAddress?, localPort?, remoteAddress? })`, a Web `Request` to a Web
  `Response`; `http.upgrade` is Node's upgrade adapter; `nodeRequest(message, res)` converts a Node request with the
  listener's checks (`{ kind: "request", request, connection } | { kind: "refused", status }`, never a throw) for apps
  mounting on their own Node server. Chord's own listener (with `listen`) is a host-lifetime object of `chord.http`
  whose native is a Node server, on a fast path that skips the Web `Request` unless a route or authenticator reads
  it.
- **Registries:** `Http` (`"chord.http"`, version 1: `routes`, `wraps`, `sockets`, `maxPayload`, `hosts`, `framers`,
  `relays`, `csp`; a value or a writable) and `Authenticators` (in contributor order, the first principal wins).
  Requests before the publication wait for it (503 past `readyTimeout`).
- **Admission, foreign requests, origins, default headers, cookies, downloads:** the security baseline (design §23).
  Refusals before any plugin code: a non-loopback socket without an allowed host, forwarded headers without a
  verified relay, duplicate or missing `Host`, userinfo in `Host`, absolute-form targets (403), unparsable targets
  (400), `TRACE`/`TRACK`/`CONNECT` (501; a route for them refused at compose).
- **A request's scope, `HttpRequest`, patterns, wraps, responses, `fileResponse`, sockets, links, revocation,
  `close`:** design §23. The spec's earlier text (an `httpServer` that listens first, `allowedHosts`, one
  `authenticate` and a `headers` option, 64 KiB reads) is superseded by those decisions.
- **Errors** (`onError`, `HttpError`): `route_failed { pattern, plugin, error }`, `wrap_failed { name, plugin, error }`,
  `socket_failed { pattern, plugin, error }`, `response_failed { pattern, error }`, `hook_failed { hook, plugin?,
  error }` (`authenticate`, `relay`, `links.options`).
- `ws` is an optional peer dependency (D7), imported only here.

## 3. `chord/next/workers`

```ts
// server.ts
const workers = createWorkers(server, Session, {
	kind: "worker",                                                                   // the facet kind it ships
	entry: "./worker.ts", execArgv: ["--import", resolver], env: { … },              // bootstrap
	authorize: (principal, address) => app.mayReach(principal, address),              // the route's `authorize` (synchronous)
	principal: (address) => ({ kind: "worker", session: address.params.id }),
	start: (address, ctx) => app.startData(address, ctx),                             // JSON, before each start
	lock: (address) => `app:${realpath(dataDir)}:worker:${address.key}`,              // one live worker per address
	idleMs: () => app.idleMs(),
	plugins,                                                                          // the plugins component
	onOutput: (address, stream, chunk) => logs.append(address.key, stream, chunk),
	onError: (error) => log(error),                                                   // `WorkersError`, below
}, ctx);
workers.state                              // JSON watchable (R5)
await workers.stop(Session({ id }), ctx);  // archive: suspended while held (Q3), then stopped
await workers.retry(Session({ id }), ctx); // the Retry button: a failed or suspended address resolves again
await workers.close(ctx);                  // no new starts, every child stopped
```

```ts
// worker.ts
await workerMain(async ({ address, start, parent, plugins, onClose }, ctx) => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(start.dir, "session.sqlite"))), ctx);
	onClose((ctx) => store.close(ctx));                                               // closers run in reverse order
	const worker = createHost<P>({ address, principal: { kind: "worker", session: start.id }, store, onError });
	onClose((ctx) => worker.close(ctx));
	worker.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);   // `started` goes out now: connect
	                                                                                  // before anything slow (a store opens in ms)
	await plugins.load(worker, { kind: "worker", core: [{ name: "@app/core", facet: coreWorker(start) }] }, ctx);
	return { busy: harness.activeTasks };                                             // extra keep-alive counts
}, {
	hostPackages: { "@earendil-works/chord/next": chordNext, "@app/core": appCore },  // the child's own instances
	redact: (error) => ({ message: redactSecrets(String(error)), ...codeOf(error) }), // what crosses as `fatal`
	onError: (error) => log(error),
});
```

- **The route:** `createWorkers` calls `host.route(Kind, { authorize, resolve }, ctx)` itself and keeps the
  `RouteHandle` (`retry`, `suspend`: D10b, R1). `authorize` is synchronous (the kernel's): a plugin backing it keeps an
  index.
- **Per address, events and operations:** a child's events (its exit, its link's close, `started`, `ready`, `fatal`)
  are observed as they happen and recorded at once on that child (a late event of an old child never changes a new
  one); the operations (start, stop) run in one queue per address: a start waits for the previous child's exit, a
  stop during a start waits for it then stops, and a start queued behind an exit checks the address's state after it
  (a crash recorded meanwhile makes it reject with that failure). Stops record their intent before `shutdown`, so the
  exit they cause is no crash.
- **A start** (`resolve(address)`): calls `start(address, ctx)` (abortable; a throw rejects the start), checks that the
  component is not closing, forks `entry` (`serialization: "advanced"`, a detached process group, stdout and stderr
  piped: the stderr tail kept, mirrored to the server's when there is no `onOutput`), makes `ipcLink(child)` at once
  (so the child's `hello` and early holds are queued, never lost), and sends the start message `{ address, start,
  scripts, lock }` (`scripts`: the worker kind's complete current set, read when the message is sent). The child takes
  the lock (when an old worker still holds it, it waits by connecting to the lock's socket and trying again when that
  connection closes: no polling), and sends `started` when the app's host sets its listener on `parent` (`parent` is
  a thin wrapper of the IPC link, so `connect` is the signal: the app connects before anything slow). `resolve` then
  returns `{ link, principal: principal(address), trusted: true }`, and the handshake and the worker's server traffic
  run during its `load`. The start timer (60 s from the fork) covers fork, lock and connect only (Q4): past it the tree is
  killed and the start fails. `ready` (after the app's function returned, carrying the idle state and its load report) sets `state` to
  `running` and lets idle stops begin; a `load` that never ends shows `starting` until `stop`.
- **Workers never restart by themselves** (R2): a crash (an exit nobody asked for), a `fatal`, a link lost while its
  child lives, or a failed start (`start` threw, the start timer, a lock not taken in time) leaves the address `failed`
  with its error (`worker_failed` reported once). A link lost while its child lives (the heartbeat after a blocked
  event loop, a protocol error) starts the stop: the grace (5 s), then the tree is killed; its exit is the crash ("link
  lost"). `resolve` of a failed address rejects at once with that error; its holders and new holds see `failed {
  waiting }` with it as cause (Q1) and stay on the address's path, nothing forks. `workers.retry(address)`
  (`RouteHandle.retry`) or a rollout reaching workers clears it (Q2, §4). An idle stop is no failure: the next hold
  starts the worker on demand.
- **Keep-alive** (D9, R3, Q5): the child's idle state is all of `host.activity`'s `references`, `jobs` and `lingering`
  and the app's `busy` (a JSON watchable of numbers) at zero, not `calls` (a remote call runs on a hold; local calls
  come from routines, jobs and tasks counted elsewhere). `ready { idle }` carries the first state, then `{ idle }` on
  each flip; a rollout applying in the child counts as busy. The server stops a worker idle since `idleMs()` (5 min by
  default; checked every second), never before `ready`. A stop (idle, `stop`, `close`): `shutdown`; the child aborts its
  `ctx`, runs the closers registered with `onClose` in reverse order and exits, forcing its own exit after 3 s; the
  server kills the tree after 5 s.
- **`state`** (R5, decision "worker errors in public"): per address key `{ status: "starting" | "running" |
  "stopping", pid, startedAt }` or `{ status: "failed", error: { message, code?, reason? }, at }` with a public error
  (a fixed message, or the child's redacted `fatal`); no entry when stopped or never started. The full error and the
  stderr tail go only to `onError` (`worker_failed`); every app hook of a start (`start`, `principal`, `lock`, the
  fork) is inside that boundary.
- **`stop(address, ctx)`** (R1, Q3): `RouteHandle.suspend(address)`, then the stop. The suspension lasts while the
  address has holders (they see `failed { waiting }`, "suspended"); with the last holder it goes, and a later hold
  starts the worker on demand; `retry(address)` lifts it at once. Whether an archived session may be opened is the
  app's (`authorize`, its views).
- **`close(ctx)`:** cancels active and queued starts first (a `start(address)` waiting on the app's barrier is
  aborted; nothing forks after it), then stops every child (grace, then kill), clears the timers; new starts reject
  `released/closed`; the caller's cancellation ends only its own wait. `createWorkers`'s `ctx` aborting (the host
  closing aborts the route's context) closes it too, and from then on every exit is a stop, never a crash (no
  `worker_failed` at shutdown).
- **The child** (`workerMain(fn, { hostPackages, redact, onError })`): reads the start message, takes the lock, makes
  `ipcLink(process)` and its wrapper `parent`, creates its plugin runtime with `hostPackages` (the child's own module
  instances; functions cannot cross IPC), calls `fn({ address, start, parent, plugins, onClose }, ctx)`. `shutdown`,
  the parent's disconnect, `SIGTERM` and `SIGINT` alike abort `ctx` and run the closers registered so far, also while
  `fn` still runs (its startup is cancelled through `ctx`). An uncaught error, or `fn` throwing, sends `fatal` with
  `redact(error)` (never the original message) and exits; after `started` that is a crash like any other.
- **Control messages** (JSON beside the link's `Uint8Array` frames; the IPC link skips them): parent to child `start`,
  `shutdown`, `reload { scripts }`; child to parent `started`, `ready { idle }`, `idle { idle }`, `fatal { error }`,
  `reloaded { report } | { error }`. One `reload` is outstanding per child at a time: a reload whose caller aborted
  keeps the child's slot until its `reloaded` or the child's exit, and the next waits for it. Errors cross as `{
  message, code?, reason? }`.
- **Errors** (`onError`, `WorkersError`, which includes `BatchError` for a `state` watch listener that throws): `worker_failed { address, error, stderrTail? }` (private),
  `authorize_failed { address, error }` (a throwing `authorize`: the hold is refused `forbidden`), `worker_exited {
  address, code, signal }` (only for an exit nobody asked for: not after a stop or a start the component failed).

### Plugins in workers (D11)

Workers never build. The plugins component (7c) gets `scripts(kind, ctx)`: the complete current set of one kind (every
discovered plugin's facet of it, built on first use, then updated by every rollout that ships that kind), each with its
plugin record (`name`, `dir`, `chord.external`). The component's per-host loading (its loaded map, `#prepare`, `adopt`,
the queue per host) moves into a file without esbuild or the watcher, `createPluginRuntime()`
with `load(host, { kind, core, scripts, modules }, ctx)` (`modules`: the host packages' module objects of this process) and `reload(host, scripts, ctx)` (a complete set: removed = loaded −
shipped; same digests unchanged); `createPlugins` uses it, and the child's `plugins` is a `WorkerPlugins` over one
(`load(host, { kind, core })` loads the start message's scripts; `reload` messages wait until `fn` returned); `import`
of `chord/next/plugins/runtime` loads no esbuild. Each kind is defined once in `createPlugins({ kinds: { <kind>: {
platform, hostPackages } } })` (decision "Slice 11's points", Kinds).

## 4. The rollout across server and workers

```ts
const built = await plugins.build(plugins.state.value.dirty, ctx);
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);
// result.steps: [{ name: "server", hosts: [{ host: "server", report }] },
//                { name: "workers", hosts: [{ host: "session|S1", report }, { host: "session|S2", stopped: true },
//                                           { host: "session|S3", error }] }]
```

`RolloutStep.reload(built, ctx)` returns `{ hosts: readonly ({ host; report } | { host; stopped: true } | { host; error
})[] }` (D12; 7c's in-process step returns a list of one, its `host` the name given to `step`). `workers.step(name)`:

1. replaces the workers' current set (`plugins.scripts(kind)` updated from `built`);
2. clears the failures recorded before this rollout and calls `RouteHandle.retry` for those addresses that have holders
   (Q2): they start with the new set and are listed; an unheld one starts at its next hold;
3. ships the complete set to every running or starting worker whose start message or last reload carried an older one
   (a child queues a reload that arrives before its `ready` until its load is done); workers reload in parallel.

A worker's entry settles on its `reloaded` or on its exit or link loss, whichever comes first. A worker stopped cleanly
during the step (idle, `stop`) is listed `stopped` and dirties nothing (its next start gets the current set); one that
crashed or failed to apply is listed with its error and does not stop the rollout, and every plugin of its kind in the
build counts as failed there (stays dirty); a worker failing during this rollout stays failed. A plugin's dirty mark
clears only when it applied on every host of every step, and a kind built in the rollout that no step shipped keeps its
plugins dirty.

## 5. Not in slice 10

The web page host, the browser's evaluation of scripts and serving them (slice 11); the TUI (slice 11); relocation and
pause of workers (the app's: `start(address)` is where the app awaits its own barrier); request resolvers and
authenticators as registries (the app's); chunked transfers as a Chord helper (an owner pattern, design §23); the
channel component (D6); telemetry spans for requests (slice 9).

## 6. Kernel changes

- `host.route(Kind, options, ctx)` returns a `RouteHandle { retry(address), suspend(address) }` (D10b, R1, Q3).
- A route has no backoff timer (R2): a rejected `resolve`, or a link that closes before its handshake completed, fails
  the route's holders `failed { waiting }` with its error (they stay on the address's path, Q1) and resolves nothing
  more; the route resolves again only for a new hold, on `retry`, or once after a link that had completed its handshake
  dropped while holds exist; a suspended address resolves nothing while it has holders and forgets the suspension with
  the last one.
- `host.root(fn, ctx, { principal: undefined })` runs anonymous (`ctx.principal` undefined); only an omitted
  `principal` takes the host's (a public-API change of `RootOptions`: `"principal" in options`).
- Origins only from relays (decision, 2026-10-31, security audit): `origin` is read only on parent and route links;
  on a child link it is a protocol error; a per-origin record goes once it has no holds, calls or messages in flight.
- An anonymous `host.root` scope gets no remote object served on its host (`forbidden`).
- Design §3: the paragraph on a `resolve` waiting for the worker's `load` is updated (done), and "Chord never closes a
  route link itself except at `host.close`" becomes "except at `host.close`, the heartbeat and protocol errors".

## 7. Tests, examples, cost

- One test file per source file. HTTP: listening before the publication (a request waits, then is served; 503 past
  `readyTimeout`); the router resolved once; `Host` (loopback forms, allowed from the option and from a writable
  contribution changing at runtime) and `Origin` checks; anonymous requests (`ctx.principal` undefined on a server with
  a principal); authentication per request and upgrade; throwing hooks; patterns, decoding, precedence, `HEAD`, 404;
  conflicts reported; wraps (phases, order, scopes, a missing route, a throwing wrap); every response kind (ranges
  206/416, multi-range, `HEAD`, download names, chunked without `size`, a short `read`, a disconnect stopping `read`,
  header merging); `json`/`body` limits and their statuses, an unread body; a throwing route; the links endpoint
  (`host.accept`, options per socket, a refused socket, the output cap); plugin sockets (an oversized frame closes only
  that socket; a reload removing the contribution closes its sockets 1012); a removed allowed host closing its
  connections; a reload swapping a route while a request runs on the old router; `fileResponse` closing its handle on
  every path; `close` (refusals, waiting, then sealing). Workers: a start on the first hold; the link made at the fork
  (a load longer than the heartbeat's 30 s binds); `started` on `connect`; the start timer covering only the start (a
  slow `load` is not killed); the lock (an old worker's lock waited for without polling); `start` throwing; a crash,
  a `fatal`, a link lost with a live child (killed after the grace), and a failed start each staying failed (no fork for
  a new hold; holders `failed { waiting }`), `retry` and a rollout clearing them and rebinding the holders; idle stop,
  a worker idle from its start, a hold keeping it; `busy`; 1,000 sequential local calls sending no message;
  `stop` with holders (suspended, then forgotten with the last holder); stop during start and start during stop; a
  crash while a resolve is queued; `close` (cancelling a start waiting in `start(address)`, no `worker_failed` at
  shutdown); the rollout step (complete sets, a worker starting during it, a clean stop listed `stopped`, a crash during
  it, an aborted reload's late reply, a kind no step shipped staying dirty); the child's shutdown during its startup,
  disconnect and signals; `redact` (a secret in the original message reaches neither `fatal` nor `state`). Kernel:
  `RouteHandle.retry` and `suspend`; a link closing before its handshake (no re-resolve loop); no re-resolve without a
  hold, a retry or one drop of a healthy link; `host.root` with an explicit `undefined` principal.
- GC: requests (their scopes, bodies, file handles) and stopped workers' state collected; no listener left on a closed
  socket; 1,000 addresses started and stopped leave no `state` entries, no per-address queue records and no
  suspensions.
- Examples (each a folder, as 7c's): `40-http` (routes, a wrap, a download with ranges, a socket, an allowed host
  added at runtime), `41-workers` (a server routing a session kind to forked workers, idle stop, a crash staying failed
  until Retry, a rollout reaching the workers and restarting a held failed one).
- Benchmark: a route's overhead per request against a plain Node handler (bar: within 10% of a keep-alive round
  trip; Opus measured 2.5 µs of 54 µs); `bytes` throughput for a 100 MiB file against `pipeline`; a worker's cold start
  (fork to `started` and to `ready`) with shipped scripts; memory per idle worker on the server.
