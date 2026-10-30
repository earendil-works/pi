# Slice 10: HTTP and workers (spec)

Status: **points decided** (owner, 2026-10-30: D1-D12 in the decision "Slice 10's points"); next: spec reviews.
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
| `Authenticators`, `RequestResolvers` (cookies, devices, the Radius relay), loopback and allowed hosts, Fetch Metadata, CSP and the loopback cookie | the app (p3's base code), through `http`'s one `authenticate` hook (D3) |
| `SessionHosts`: a worker per session, `createHostManager` + `forkDriver`, a kernel lock per session, idle stop from reported counts, crash notices, ready timeout | `workers` |
| relocation and pause of a worker, the catalog, `WorkerInitValues` | the app (built on `workers`' `stop` and start data) |
| `hosts/worker.ts`: the child's control channel, lock, start data, connect, load, report counts, shutdown | `workers`' child side |
| the dev reload across server and workers, worker plugin lists | `plugins` (7c) plus `workers`' rollout step (§4) |

## 2. `chord/next/http`

```ts
const http = await httpServer(server, {
	listen: { host: "127.0.0.1", port: 8788 },
	authenticate: (request, ctx) => app.principalOf(request, ctx),   // the app's policy: cookies, loopback, relays
	headers: (request) => app.securityHeaders(request),              // every response's headers (CSP, nosniff, framing)
	links: { path: "/chord", limits: { part: 16 * MiB, decoded: 64 * MiB } },   // host.accept for every socket there
}, ctx);
await server.load([{ name: "@app/core", facet: core }, { name: "chord.http", facet: http.facet }, ...plugins], ctx);
…
await http.close(ctx);
```

- **Order:** the server listens first (plugins see the real port; a page reconnecting while plugins load is not lost),
  holds every request and upgrade until `load` resolved, then serves.
- **`Http`**, a registry the component defines and serves through its facet (D1): plugins contribute routes and
  sockets; the composed router is followed, each request uses the router as it was when it started.

```ts
// plugins/notes/server.ts
export default defineFacet((host, self) => {
	self.contribute(Http, {
		routes: {
			"GET /notes/:id/export": async (request, ctx) => {
				if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
				const notes = await ctx.get(NoteStore, {});
				return { kind: "json", value: await notes.export({ id: request.params.id }, ctx) };
			},
			"GET /notes/template.md": async (_request, ctx) => fileResponse(pluginFile("template.md"), { download: "template.md" }),
		},
		sockets: { "/terminal": (socket, request, ctx) => terminals.attach(socket, ctx) },   // D6
	});
});
```

- **A route** is `(request: HttpRequest, ctx: Ctx) => Promise<HttpResponse>`, run in a `host.root` scope with the
  request's principal (`ctx.principal`; `undefined` when `authenticate` found none) and an abort signal that fires when
  the client disconnects. `HttpRequest`: `method`, `path`, `params` (from the pattern), `query`
  (`URLSearchParams`), `headers` (lowercased, read-only), `origin` (scheme, host, port), and the body (D4).
- **Patterns** (D8): `"METHOD /a/b"`, `:name` segments (`params.name`), a trailing `/*` (`params["*"]`, the rest);
  the most specific match wins, segment by segment from the left (exact before `:name` before `*`); two contributions with
  one pattern are a conflict reported through `compose` (`registry_conflict`), the first by plugin name wins. `HEAD`
  falls back to the `GET` route.
- **Responses are descriptions** (D5): the component writes status, headers and body, so every plugin gets ranges,
  `HEAD`, download headers and abort on disconnect from one place:

```ts
type HttpResponse = { readonly headers?: Readonly<Record<string, string>> } & (
	| { readonly kind: "json"; readonly value: JsonValue; readonly status?: number }
	| { readonly kind: "html"; readonly body: string; readonly status?: number }       // its CSP via `headers`
	| { readonly kind: "bytes"; readonly mime: string; readonly size: number;
	    readonly read: (offset: number, length: number, ctx: Ctx) => Promise<Uint8Array>;
	    readonly download?: string;      // Content-Disposition: attachment with this file name, made safe
	    readonly ranges?: boolean }      // 206/416 and Accept-Ranges
	| { readonly kind: "redirect"; readonly to: string; readonly status?: 302 | 303 | 307 }
	| { readonly kind: "error"; readonly status: number; readonly message?: string });
```

  `bytes` is read in chunks (64 KiB) with the socket's backpressure, stopped when the client disconnects; a route
  that throws is a 500 (reported, never its message); one that returns after a disconnect writes nothing.
- **`fileResponse(path, { download?, ranges?, mime? })`**: a `bytes` response over a file (its size from `stat`, `read` through a file
  handle opened once and closed when the response ends), for plugin files and downloads.
- **The links endpoint** (`links.path`): an upgrade there is authenticated, then `host.accept(webSocketLink(ws), {
  principal, limits })`; a socket without a principal is refused (403). Per-socket output cap as p2's
  `limitedSocket` (a client that stops reading is cut off).
- **Wraps** (D2): middleware around routes, below. **Not built:** request resolvers as a registry (D3).

> **Decided D1 (owner, 2026-10-30: "a"):** the component exports the token `Http` (`"chord.http"`) and a facet the
> app loads with its plugins (`http.facet`, plugin name `chord.http`), which serves the registry (`compose`: the
> router); the server reads it with `host.registry(Http, ctx)`.

> **Decided D2 (owner, 2026-10-30: "a"):** wraps are built as designed (§23): `wraps: [{ name, phase, scope?, route?,
> wrap(request, next, ctx) }]` in the component's phases `observe`, `headers`, `transform` (outermost first), within a
> phase in contributor order (plugin name, then type), `scope: "own"` by default (around the contributing plugin's own
> routes), `"all"` explicit, `route` narrowing to one pattern (a missing one is a reported conflict). A wrap adds a
> boundary on top of a route's own checks, never instead of them. A wrap that throws is a 500 (reported, naming its
> plugin). The `headers` option stays for every response, also those no route makes (a 404, a refused request).

> **Decided D3 (owner, 2026-10-30: "a"):** one app function `authenticate(request, ctx) => P | undefined`, called
> once per request and per upgrade; no Chord registry of resolvers: who a request is, and which credential wins, is the
> app's policy (p3 composes it from its own registry).

> **Decided D4 (owner, 2026-10-30: "k"):** `request.json(limit?)` (parsed JSON, at most 1 MiB by default, malformed:
> 400) and `request.body(limit?)` (an async iterable of `Uint8Array` chunks, for uploads streamed to a file); nothing is
> read before the route asks; past its limit the read stops and the request is answered 413; a client that disconnects
> aborts `ctx`, which ends the iteration.

> **Decided D5 (owner, 2026-10-30: "a"):** the five kinds above, `headers` on every kind (cookies, a preview's own
> CSP), `html` a full document instead of the design's `page { title, body }`.

> **Decided D6 (owner, 2026-10-30: "a"):** `sockets: { "/terminal": (socket, request, ctx) => … }`: after the
> origin check and `authenticate` (a socket without a principal is refused, 403, before the plugin sees it), the
> component upgrades and hands the plugin a `ws` WebSocket (its own protocol and flow control, as p2's terminals and
> voice); the plugin authorizes further; patterns as routes; wraps do not apply. The design's channel component waits
> for a second user and would be built on top of this.

> **Decided D7 (owner, 2026-10-30: "a"):** `ws` is an optional peer dependency of Chord (pinned exactly, the version
> its tests use), imported only by `next-node/http`, as esbuild.

> **Decided D8 (owner, 2026-10-30: "a"):** `:name` matches one non-empty segment (percent-decoded), a trailing `/*`
> the rest (possibly empty); the most specific match wins, segment by segment from the left (exact before `:name`
> before `*`).

## 3. `chord/next/workers`

```ts
// server.ts
const workers = createWorkers({
	entry: "./worker.ts",                                      // the child's entry module
	start: (address, ctx) => app.startData(address, ctx),      // the app's start data (JSON), before each start
	plugins,                                                   // the plugins component: the worker kind's scripts
	idleMs: 300_000,
	onOutput: (address, stream, chunk) => logs.append(address.key, stream, chunk),
}, ctx);
const sessions = server.route(Session, { authorize: app.authorizeSession, resolve: workers.resolve }, ctx);
sessions.retry(Session({ id }));    // a Retry button: ends the address's backoff (D10b)
workers.state                       // JSON watchable: { [address key]: { status, pid?, startedAt?, error? } }
await workers.stop(Session({ id }), ctx);   // archive; the next hold starts it again
```

```ts
// worker.ts
await workerMain(async ({ address, start, parent, plugins }, ctx) => {
	const worker = createHost<P>({ address, principal: { kind: "worker", session: start.id }, store, onError });
	worker.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);   // W6: connect, then load
	await plugins.load(worker, { kind: "worker", core: [{ name: "@app/core", facet: coreWorker(start) }] }, ctx);
	return { host: worker, busy: harness.activeTasks };       // extra keep-alive counts (Durable tasks)
});
```

- **`resolve(address, ctx)`** (a route's `resolve`): the address's running worker's link, or starts one: forks `entry`
  (`serialization: "advanced"`, detached process group, killed as a tree), sends the start message (`address`, the
  app's start data, the worker kind's built scripts), waits for `ready` within `readyTimeout` (60 s), and returns
  `{ link: ipcLink(child), principal, trusted: true }`. One start at a time per address; a failed start rejects (the
  route's backoff and `resolve_failed` are the kernel's: D10).
- **One live worker per address** across processes (a server restart while an old worker drains): the child takes a
  kernel lock named after the app's data and the address before it opens its store (v1's `processLock`, ported); a
  second fails its start `unavailable/locked`.
- **Keep-alive** (D9): the child reports `host.activity` (`references`, `calls`, `jobs`, `lingering`) and the app's
  `busy` counts whenever they change; the server stops a worker whose counts were all zero for `idleMs`, and never one
  that is starting. A stop sends `shutdown`, the child closes its host (`host.close`) and exits; after a grace period
  (5 s) the process tree is killed.
- **Exits:** a worker that exits unasked (a crash, an OOM) is reported (`worker_exited { address, code, signal, stderr
  tail }`) and its link closes; its holders go `loading` and the route resolves again while holds exist (the kernel's
  backoff). `state` shows the last error until the next start succeeds.
- **The child** (`workerMain`): reads the start message, takes the lock, makes `ipcLink(process)`, calls the app's
  function, sends `ready` once it returned (after `load`), reports counts, handles `shutdown` and the parent's
  disconnect (close the host, exit), and reports an uncaught error as `fatal` (redacted by the app's `onError`).
- **Plugins in workers** (D11): workers never run esbuild. The start message carries the worker kind's current scripts
  (`Built`, plain data, 7c); the child's `plugins` is the evaluating half of the plugins component (no build, no
  watcher, no esbuild import): `load` evaluates them, `reload` evaluates new ones and calls `host.reload` per plugin,
  as on the server.

## 4. The rollout across server and workers

```ts
const built = await plugins.build(plugins.state.value.dirty, ctx);
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);
```

`workers.step(name)` ships `built` (its worker kind's facets and plugin records) to every running worker over its
control channel; each evaluates and reloads; the step resolves with one report per worker (`RolloutStep.reload`
returns `{ hosts: [{ host, report }] }`, D12). A worker starting during or after it gets the current scripts in its
start message. A worker that fails to apply (closed, aborted) is listed and does not stop the rollout; a plugin kept old
on any worker stays dirty (7c's rule).

> **Decided D9 (owner, 2026-10-30: "a"):** Chord's `host.activity` plus the app's `busy` counts (a JSON watchable of
> numbers, e.g. Durable's active tasks), reported to the server when they change; `idleMs` default 5 min, checked every
> second; never while the worker starts.

> **Decided D10 (owner, 2026-10-30: "a"):** the kernel's route backoff (1 s doubling to 60 s while holds exist,
> `resolve_failed`), no sticky failure; `state` shows the error and when the next try is.
>
> **Decided D10b (owner, 2026-10-30: "b"):** a kernel change: `host.route(Kind, options, ctx)` returns a `RouteHandle`
> with `retry(address)`, which ends that address's backoff so `resolve` runs now if the address has holders (nothing
> without holders); the app wires its Retry button to the handle (`sessions.retry(Session({ id }))`); the workers
> component has no `retry` of its own.

> **Decided D11 (owner, 2026-10-30: "a"):** workers never build; the server discovers and builds every plugin, one set
> for every host; a worker's start message carries its kind's scripts and a reload ships new ones. Plugins are defined
> where the server can read them (owner: "no cwd specific plugins, which might be alright; that way workers can live
> anywhere"). A worker on another machine needs the plugin directories only for `chord.external` packages and
> `pluginFile` (both resolve in the plugin's directory).

> **Decided D12 (owner, 2026-10-30: "a"):** `RolloutStep.reload` returns `{ hosts: [{ host, report }] }` (7c's
> in-process step returns a list of one); workers reload in parallel; one that closed during the step is listed with its
> error and does not stop the rollout.

## 5. Not in slice 10

The web page host, the browser's evaluation of scripts and serving them (slice 11); the TUI (slice 11); relocation and
pause of workers (the app's); request resolvers and authenticators as registries (the app's); chunked
transfers as a Chord helper (an owner pattern, design §23, unchanged); telemetry spans for requests (slice 9).

## 6. Tests, examples, cost

- One test file per source file. HTTP: listen-before-load holding requests and upgrades; authentication per request and
  upgrade; patterns and precedence; conflicts reported; wraps (phases, order, scopes, a missing route, a throwing wrap); every response kind (ranges 206/416, `HEAD`, download names
  made safe, a disconnect stopping `read`); bodies past their limit; a throwing route (500, reported); the links
  endpoint (`host.accept`, a refused socket, the output cap); plugin sockets; a reload swapping a route while a request
  runs on the old router; close. Workers: a start on the first hold, the lock, `ready` timeout, idle stop and a hold
  keeping it, `busy` counts, a crash (reported, re-resolved while held), `stop`, `RouteHandle.retry` (D10b), the rollout step (a worker
  starting during it gets the new scripts), the child's shutdown and disconnect.
- GC: requests (their root scopes and bodies) and stopped workers' state collected; no listener left on a closed socket.
- Examples (each a folder, as 7c's): `40-http` (routes, a download with ranges, a socket), `41-workers` (a server
  routing a session kind to forked workers, idle stop, a crash and recovery, a rollout reaching the workers).
- Benchmark: a route's overhead per request against a plain Node handler; a worker's cold start (fork to `ready`) with
  shipped scripts against building in the child.
