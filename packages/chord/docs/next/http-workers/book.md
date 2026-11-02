---
title: Serving and Spawning: HTTP and workers in Chord v2
cover: Serving / and Spawning
kicker: An explainer · Chord v2 slice 10 · 2026-10-31
subtitle: How a request reaches a plugin's route, who it acts as, and how a worker process per session starts, stops and fails
stats:
  - 1 | registry plugins contribute routes, wraps, sockets and hosts to
  - 0 | automatic worker restarts
  - 5 min | idle before a worker stops (default)
  - 6 | security rules on by default
note: |
  Written by the redesign session from `slice-10.md`, the decision entries "Slice 10's points", "Origins only from
  relays", "The HTTP component's security baseline" and their neighbours in `decisions.md`, design §3 and §23, and the
  build after its four fix rounds (security baseline, `fetch` core, error boundaries).
colophon: Serving and Spawning · first edition · 2026-10-31 · Chord v2 slice 10
---

# Before we begin {.preface}

Mario runs a small chat app on his laptop. Each conversation is a **session**, and each session runs in its own
process, a **worker**, so a session that crashes or eats memory takes nothing else down. A browser tab talks to the
server; the server talks to the workers. Plugins add features: one adds a chat panel, one adds file downloads, one
adds a terminal. Mario edits plugins while the app runs, and sometimes an agent edits them for him.

Three things have to work for him without thought. A plugin adds an HTTP route, and it is served safely: no other
website open in his browser can read his data or act as him through it. A session's worker exists exactly while
someone uses it. And when a worker crashes, nothing restarts it in a loop: he sees why it failed and decides.

Slice 10 builds two components for this: `chord/next/http` (the server's HTTP and WebSocket entry) and
`chord/next/workers` (a worker process per session). Both are Node code on top of Chord's kernel; the kernel itself
stays portable.

## Eight things to know

:::findings
1. **Plugins contribute routes, Chord serves them.** The HTTP component defines one registry, `Http`; plugins
   contribute routes, wraps (middleware), WebSocket handlers and allowed hosts to it, and every reload swaps them.
2. **A route returns a description.** JSON, HTML, bytes, a redirect or an error; the component writes it, with ranges,
   `HEAD`, download headers and backpressure done once for every plugin.
3. **Security is built in.** Where a request came from, whether another website sent it, and which headers every
   response carries are decided by the component before any plugin code runs. The app only says who someone is.
4. **A worker starts on the first use of its session** and stops after five idle minutes. The server forks it; the
   worker connects back and loads its plugins.
5. **A worker never restarts by itself.** A crash or a failed start leaves the session failed with its error until a
   person presses Retry or rolls out new code.
6. **Workers never build plugins.** The server builds every plugin once; a worker evaluates the scripts it is sent.
7. **A rollout reaches every host.** The server reloads first, then every running worker, each reporting its result.
8. **Everything but the bootstrap is changeable by plugins.** Routes, hosts, start data, idle times: contributions or
   functions read at each use.
:::

## Words used throughout

A **route** is a function a plugin contributes for a method and path pattern. A **wrap** runs around routes. A
**socket** is a WebSocket a plugin handles with its own protocol; a **link** is Chord's own WebSocket at `/chord`,
over which tabs hold objects. **Admission** is what the component checks before any plugin code. **Provenance** is
where a request came from (local, an allowed host, a relay). A request is **foreign** when a browser sent it for
another website. A **worker** is a process serving one **address** (`Session({ id })`). A worker's **start message**
carries its start data and its plugins' **scripts**. A **rollout** applies a build to the server and then the workers.

# The App We Build {#app lede="A server, workers, two plugins: the files a reader needs to follow the rest."}

The whole app is four files of its own plus its plugins. The server creates its host, the HTTP component and the
workers component, then loads its plugins:

```ts
// server.ts
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError });
const plugins = createPlugins({
	roots: ["./plugins"],
	kinds: {
		server: { platform: "node", hostPackages: ["@earendil-works/chord/next", "@app/core"] },
		worker: { platform: "node", hostPackages: ["@earendil-works/chord/next", "@app/core"] },
	},
	onError,
}, ctx);
const http = createHttp(server, { listen: { host: "127.0.0.1", port: 8788 }, onError }, ctx);   // settings are arguments
const workers = createWorkers(server, Session, {
	kind: "worker", entry: "./worker.ts", plugins, principal: (a) => ({ kind: "worker", session: a.params.id }),
	start: (address, ctx) => ({ id: address.params.id, dir: sessionDir(address) }),
	lock: (address) => `chat:${dataDir}:${address.key}`, authorize: mayReach, onError,
}, ctx);
await plugins.load(server, { kind: "server", core: [core, { name: "chord.http", facet: http.facet }], modules }, ctx);
// `core` contributes the app's authenticator: self.contribute(Authenticators, authenticate)
```

```ts
// worker.ts: one per session
await workerMain(async ({ address, start, parent, plugins, onClose }, ctx) => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(start.dir, "session.sqlite"))), ctx);
	onClose((ctx) => store.close(ctx));
	const worker = createHost<P>({ address, principal: { kind: "worker", session: start.id }, store, onError });
	onClose((ctx) => worker.close(ctx));
	worker.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);
	await plugins.load(worker, { kind: "worker", core: [workerCore(start)] }, ctx);
	return { busy: { tasks: 0 } };
}, { hostPackages: modules, redact: (error) => ({ message: "worker failed" }), onError });
```

A plugin is a directory with a `package.json` and one file per kind it needs. The chat plugin keeps its messages in a
worker (each session has its own) and contributes one route on the server for exporting them:

```ts
// plugins/chat/server.ts
export default defineFacet((host, self) => {
	self.contribute(Http, {
		routes: {
			"GET /s/:session/export": async (request, ctx) => {
				if (!(await mayView(ctx.principal, request.params.session, ctx))) return { kind: "error", status: 403 };
				const chat = await ctx.get(Chat, { session: request.params.session });   // reaches the session's worker
				return { kind: "json", value: await chat.export(ctx) };
			},
		},
	});
});
```

`ctx.get(Chat, { session })` is the one line that connects the two halves: `Chat`'s host address is the session's
worker, the server's route for `Session` finds (or starts) that worker, and the call goes over its link.

# A Request, Start to End {#request lede="What happens between a TCP connection and the route's response, in order."}

Every request takes the same path. The order matters: nothing a plugin wrote runs before the component decided that
the request may run at all, and as whom.

:::flow wide animate | One request through the HTTP component. Everything left of `authenticate` is the component's own; plugins start at the router.
row "Admission" accent
box prov "Provenance" "local, allowed host or relay; else 403"
box foreign "Foreign?" "another website's browser request"
box origin "Origin" "foreign Origin 403; unsafe methods need ours"
row "Who" blue
box auth "authenticate" "the app: cookies, devices"
box anon "anonymous" "foreign or no credential" muted
row "Plugins"
box router "Router" "pattern → route, as of now"
box wraps "Wraps" "observe, headers, transform"
box route "Route" "returns a description"
row "Answer" muted
box write "Write" "headers, ranges, chunks, backpressure"
arrow prov -> foreign
arrow foreign -> origin
arrow origin -> auth
arrow origin -> anon "foreign"
arrow auth -> router
arrow router -> wraps
arrow wraps -> route
arrow route -> write
:::

**Provenance** answers "where from". A request is local only if three things hold: the socket arrived on a loopback
address, the `Host` header names loopback with the port, and no proxy header (`Forwarded`, `X-Forwarded-*`) is present.
Anything else must name a host the app allowed (a tunnel's public name) and is then treated as remote https. Anything
else is refused before a single plugin line runs. The security audit found that checking the `Host` header alone let
anyone reaching the port claim to be local: the socket address is the part a remote client cannot fake.

**Foreign** answers "did another website make the browser send this". Browsers say so in `Sec-Fetch-Site`. A foreign
request never reaches `authenticate`: it runs anonymous, whatever cookies it carries. That one rule stops a page on
another site from reading Mario's data through an `<img>` or `<script src>`, from driving his session through a hidden
form or `fetch`, and from opening his WebSocket. The single exception is a top-level navigation (Mario clicks a link
to the app from his mail) to a route marked `page: true`.

**Origin** closes what is left: a request whose `Origin` header names another site is refused, and a state-changing
request from a browser must name the app's own origin. A webhook that other sites must reach opts out
(`crossSite: true`) and then always runs anonymous, checking its own signature.

Then the app's `authenticate` says who the request is. The **router** picks the most specific route for the method
and path, from the router as it was when the request started. **Wraps** run around it, and the route returns a
description that the component writes.

# What a Route Returns {#responses lede="Five kinds of response, and why routes never touch Node's response object."}

In p2 every plugin wrote Node's `ServerResponse` itself, so each one implemented ranges, download headers and `HEAD`
by hand, or forgot to. In Chord a route returns data:

```ts
type HttpResponse = { readonly headers?: Readonly<Record<string, string>> } & (
	| { kind: "json"; value: JsonValue; status?: number }
	| { kind: "html"; body: string; status?: number }
	| { kind: "bytes"; mime: string; size?: number; read(offset: number, length: number, ctx: Ctx): Promise<Uint8Array>;
	    download?: string; ranges?: boolean }
	| { kind: "redirect"; to: string; status?: 302 | 303 | 307 }
	| { kind: "error"; status: number; message?: string });
```

The component turns a `bytes` response with a `size` into `Content-Length`, a range request into 206 (or 416 when it
cannot be satisfied), `HEAD` into headers only, and `download` into a safe `Content-Disposition`. It reads in 64 KiB
pieces and waits whenever the client is slower, so a large file never piles up in memory, and it stops reading the
moment the client disconnects. Without a `size` it sends the body chunked until `read` returns an empty piece: a zip
built on the fly, or an export paged from a worker one call per piece.

`fileResponse(path, options)` is a `bytes` response over a file: it opens the file only when the first byte is
needed and closes it when the request ends, so a `HEAD` or a disconnect leaves no open handle behind. Request bodies
work the same way in reverse: `await request.json()` reads at most 1 MiB and parses it; `request.body(limit)` yields
chunks for an upload streamed to disk. A body past its limit gets 413; nothing is read until a route asks.

A route that throws is a 500 without its message: error text often holds paths or tokens, so it goes to the server's
`onError`, never to the client.

# Who Is Asking {#who lede="The app's one security function, and everything the component does so the app does not have to."}

The app writes one function about identity and contributes it to the registry `Authenticators` (plugins may add
more, a device pairing for instance; the first principal wins):

```ts
const authenticate: Authenticator = async (request, ctx) => {
	const device = readCookie(request, "device", secret);       // signature and expiry checked
	if (device) return { kind: "owner", access: "device", device };
	const guest = readCookie(request, "guest", secret);
	if (guest) return { kind: "guest", grant: guest };
	if (request.provenance.kind === "local") return { kind: "owner", access: "local" };
	return undefined;                                             // anonymous
};
self.contribute(Authenticators, authenticate);                    // in the app's core facet
```

It never parses `Host`, never checks `Origin` and never sees a foreign request: the component already did all of it.
It may read `request.provenance` (`local`, `remote` with the host, or `relayed` through a verified relay such as
Radius). Cookies are written with `cookie(name, value, { secret, request, maxAge })`, which sets `HttpOnly`,
`SameSite`, `Secure` on a remote origin, and signs the value with its expiry.

Every response, the component's own 404s and 403s included, carries the same headers: no caching, no MIME sniffing, no
referrer, no framing (`X-Frame-Options: DENY` and `frame-ancestors 'none'`, except for framers the app allowed), and a
Content Security Policy with a fresh script nonce per response (`request.nonce`), so an injected `<script>` does not run.

| Attack | What stops it |
| --- | --- |
| a website points its domain at 127.0.0.1 (DNS rebinding) | provenance: `Host` must be loopback or allowed |
| a request from the LAN or a proxy claims to be local | provenance: the socket's own address, no proxy headers |
| another site reads private data through `<img>`, `<script src>`, `fetch` | foreign requests run anonymous |
| another site posts a form or opens the WebSocket as Mario | foreign `Origin` refused; anonymous anyway |
| another site frames the app to trick clicks | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| a path like `/files/..%2F..%2Fsecret` | decoded `/`, `.`, `..`, `\` in a path segment are 400 |
| a crafted request target crashes the server | the target is parsed by the component, a failure is 400 |

The core is a Web `fetch` handler, so an app with its own server (Hono, Express, plain Node with `nodeRequest`) mounts
it and gets the same checks; without the socket's addresses a mounted request is never local.

# Sockets and Links {#sockets lede="Chord's own WebSocket for tabs, a plugin's own WebSocket for its protocol, and what closes them."}

A tab holds objects over `/chord`, a **link**: the component authenticates the upgrade and calls `host.accept` with
the principal. A link has Chord's heartbeat: silent for 30 seconds, it closes.

A plugin with its own protocol, a terminal for instance, contributes a **socket**:

```ts
self.contribute(Http, { sockets: { "/terminal": (socket, request, ctx) => terminals.attach(socket, ctx) } });
```

The component upgrades after admission and `authenticate` (no principal: refused before the plugin sees it) and hands
the plugin a ready WebSocket. It pings it after 15 seconds of silence and terminates it after 30, so a phone that
vanished does not hold a terminal open for hours.

What was removed is closed at once. When a reload changes or removes the plugin that handed out a socket, the socket
is terminated: old code does not keep serving it. When an allowed host is removed, every link and socket that came
through it is terminated. "Terminated" means immediately, not a polite close a hostile client could ignore.

# A Worker's Life {#worker lede="Started by the first use, connected before it loads, stopped when nobody needs it."}

Nothing starts a worker but a use of its session. A tab opens session S1 and holds `Chat { session: S1 }`:

:::sequence animate | The first hold of a session starts its worker. The link exists before the worker loads, so it serves while loading.
actor tab "tab"
actor server "server"
actor worker "worker S1" "forked" accent
tab -> server: hold Chat { session: S1 }
server -> server: route Session(S1): resolve
server => worker: fork, start message (start data, scripts)
worker -> worker: take the lock for S1
worker --> server: started (connected)
server -> worker: hold Chat (relayed for the tab)
worker -> worker: load plugins
worker --> server: bound (Chat's state)
server --> tab: bound
worker --> server: ready { idle: false }
:::

`started` comes as soon as the worker connected; the server then talks to it while it loads. The 60-second start
timer covers only fork, lock and connect: a session with a long migration loads as long as it needs, its objects
`loading` meanwhile. `ready` comes after the load and lets idle stops begin.

The **lock** makes sure one live worker serves an address, even across a server restart while an old worker still
closes its store: the new one waits for the old one to let go.

**Idle** means nothing uses the worker: no holds arriving over its link, no jobs, no lingering objects, and none of the
app's own busy counts (its running agent tasks). Local calls inside the worker do not count; they come from work that
is counted elsewhere. The worker reports only when that flips between idle and busy. After five idle minutes the
server sends `shutdown`; the worker closes its host and store in reverse order of opening and exits.

`workers.stop(address)` is the archive button: it stops the worker and keeps it stopped while a tab still holds the
session (the tab sees "suspended"). With the last holder gone, the next use starts it again.

# When a Worker Fails {#failure lede="No automatic restarts: why, and how a failure is shown and cleared."}

A worker crashes: an out-of-memory kill, a bug in a native addon. The obvious design restarts it. Mario rejected that
on 2026-10-30: a crash usually has a reason, and the same code on the same data crashes again, while the agent task
that caused it is resumed by the restart and runs into it again. A timer only makes the loop slower.

:::steps | A crash and its recovery
+++ The crash
Worker S1 exits unasked. The server records the session as failed with the error, and reports the full error and the
end of the worker's stderr to its own `onError`, for Mario's logs.
+++ Holders see it
Every tab holding S1's objects sees `failed { waiting }` with a fixed message ("worker exited (SIGSEGV)"), never the
raw error: it may hold paths or secrets, and guests see it too. A new tab opening S1 sees the same and forks nothing.
+++ Retry
Mario presses Retry (`workers.retry(Session({ id: "S1" }))`). The server starts the worker; the tabs' references bind
to it without reloading the page.
+++ Or a fix
Mario fixes the plugin and rolls out. The rollout clears the failures from before it and starts the failed sessions
that tabs still hold, once, with the new code. A session that fails again stays failed.
:::

Every way a worker can fail ends the same: a crash, a `fatal` from the worker, a start that throws or times out, and a
link lost while the process lives (the heartbeat after a blocked event loop), which the server ends by killing the
process after five seconds.

# Shipping Plugins to Workers {#ship lede="One build on the server, scripts sent to every worker, a result per host."}

Building a plugin takes esbuild a few milliseconds per facet, but a cold build of twenty plugins takes a quarter of a
second. Doing that in every worker that starts would slow every session's start and let workers see different
code. So the server builds every plugin, once, and a worker only evaluates.

A worker's start message carries the complete current set of worker scripts. When Mario edits a plugin and rolls out,
the rollout runs its steps in order:

```ts
const built = await plugins.build(plugins.state.value.dirty, ctx);
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);
// result.steps[1].hosts: [{ host: "session|S1", report }, { host: "session|S2", stopped: true }, { host: "session|S3", error }]
```

The workers step sends the complete new set to every running worker in parallel; each reloads per plugin (a broken
plugin keeps its old code, as on the server) and answers with its report. A worker stopped cleanly during the step
is listed `stopped` and gets the new set at its next start. A plugin's "dirty" mark clears only when it was applied
on every host of every step, so a plugin that failed anywhere stays marked for the next try.

# Changing It at Runtime {#runtime lede="What plugins can change while the app runs, and what needs a restart."}

The app is meant to modify itself, so every option that is not needed to start the process is changeable by plugins.
Routes, wraps, sockets, allowed hosts and trusted framers are contributions to `Http`; a contribution that changes is a
writable, and the router recomposes on each change:

```ts
const hosts = self.writable({ hosts: [] as string[] });
self.contribute(Http, hosts);
self.on(tunnel.publicHost, ({ value }) => hosts.set({ hosts: value ? [value] : [] }));
```

Authenticators, framers and extra CSP sources are contributions too; functions the workers component calls at each
use (a worker's start data, its idle time) can read the app's own registries, which plugins contribute to. What needs a restart is only the
bootstrap: the port, the `/chord` path, the worker's entry file and its Node flags.

# What's Next {.epilogue lede="What the reviews found, and what comes after this slice."}

Four build reviews, three security audits and three rounds of rechecks shaped the slice. They found a malformed request
crashing the server, `Host`-only provenance, origins invented by a tab (a kernel hole since slice 4a, now refused on tab
links), secrets reaching guests through worker errors, close and shutdown races, and leaks of request scopes; each is
fixed with a regression test. A route costs about 20 µs more than a plain Node handler (12 µs warmed), accepted for
what it buys: a scope per request, admission and the baseline headers.

Next comes the app kit (`chord/next/app`), which wires these components with Chord's conventions so an app writes
`startApp` and `startWorker`, then slice 11: the browser page and the terminal UI as hosts.

# API in Brief {.appendix}

| Call | What it does |
| --- | --- |
| `createHttp(host, { listen?, links?, closeTimeout?, onError }, ctx)` | the component: `facet`, `fetch`, `upgrade`, `close` |
| `Authenticators` contribution | `(request, ctx) => P \| undefined`: who a request is |
| `nodeRequest(message, res)` | a Node request as a Web `Request`, with the listener's checks |
| `http.facet` | the facet serving `Http`; load it with the plugins (in `core`) |
| `Http` contribution | `{ routes?, wraps?, sockets?, maxPayload?, hosts?, framers?, relays?, csp? }` |
| route | `(request, ctx) => Promise<HttpResponse>`, or `{ handler, page?, crossSite? }` |
| `fileResponse(path, options)`, `cookie(name, value, options)` | a file as bytes; a safe cookie |
| `createWorkers(host, Kind, { kind, entry, start, lock, principal, authorize, plugins, idleMs?, onError }, ctx)` | a worker per address |
| `workers.state`, `stop`, `retry`, `close`, `step(name)` | status per address; archive; Retry; shutdown; a rollout step |
| `workerMain(fn, { hostPackages, redact, onError })` | the worker process's side |
| `RouteHandle.retry(address)`, `suspend(address)` | the kernel's route, as `host.route` returns it |
