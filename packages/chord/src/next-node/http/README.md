# http

The HTTP component (slice 10 §2, design §23; decisions "The HTTP core is a fetch handler", "The HTTP server is a native
object", "The HTTP component's security baseline", "Slice 10 fix round, allowed hosts only through contributions",
"Settings are arguments, extensions are registries", "A CSP nonce per response"): the server's HTTP and WebSocket
entry. Plugins contribute routes, wraps, sockets, allowed hosts, framers, relays and
CSP sources to the registry `Http`; routes return response descriptions. The core is one Web-standard handler,
`fetch(Request) → Response`; Chord's own Node server (the listener) is the easy path, an app with a server of its own
mounts the handler. Node-only; `ws` is an optional peer dependency of `@earendil-works/chord`, imported only here.
Exported as `@earendil-works/chord/next/http` once v2 has its entry point.

## For apps (`index.ts`)

```ts
// the app's settings are arguments, fixed for the component's life (changing one is a restart)
const http = createHttp(server, {
	listen: { host: "127.0.0.1", port: 8788 },     // Chord's own listener; port 0 picks one; none: no listener
	links: { path: "/chord", options: (request, principal) => ({ limits, maxPayload }) },   // or a value
	closeTimeout: 30_000,
	onError: (error) => log(error),                 // HttpError
}, ctx);
// the app's core facet: who someone is (a registry: plugins may add authenticators too)
const app = defineFacet((_host, self) => {
	self.contribute(Authenticators, (request, ctx) => principalFromCookie(readCookie(request, "session", secret)));
});
const core = [{ name: "chord.http", facet: http.facet }, { name: "@app/core", facet: app }];
await plugins.load(server, { kind: "server", core, modules }, ctx);
const { port } = await http.listening(ctx);
…
await http.close(ctx);     // first: drains running requests (host.close would seal their scopes at once)
await server.close(ctx);
```

```ts
// a plugin's server facet
self.contribute(Http, {
	routes: {
		"GET /notes/:id": async (request, ctx) => ({ kind: "json", value: … }),
		"GET /": { page: true, handler: async (request) => ({ kind: "html", body: `<script nonce="${request.nonce}">…` }) },
		"POST /hooks/ci": { crossSite: true, handler: async (request) => … },        // always anonymous
	},
	wraps: [{ name: "audit", phase: "observe", scope: "all", wrap: async (request, next, ctx) => next(request) }],
	sockets: { "/terminal/:id": (socket, request, ctx) => attach(socket, ctx) },
	maxPayload: 1024 * 1024,                     // its sockets' largest frame
	hosts: ["notes.example.com"],                // a writable (`self.writable`) to change it
	framers: ["https://shell.example.com"],      // who may frame the app's pages
	relays: [{ name: "radius", verify: (request) => verified(request) }],   // { origin, framer? } | undefined
	csp: { "img-src": ["https://cdn.example.com"] },
});
```

```ts
// an app's own server instead of the listener (no `listen`)
hono.all("/*", (c) => http.fetch(c.req.raw, { localAddress, localPort, remoteAddress }));
// plain Node: `nodeRequest` converts with the listener's checks, never throwing (refused as the listener answers:
// absolute-form 403, a target that does not parse 400, a `Host` with userinfo 403, TRACE/TRACK/CONNECT 501, any other
// failure 400), raw headers with their duplicates, the signal aborted when the client goes
nodeServer.on("request", async (message, res) => {
	// { kind: "request", request, connection } | { kind: "refused", status }
	const converted = nodeRequest(message, res);
	…
});
nodeServer.on("upgrade", http.upgrade);
await http.close(ctx);   // before host.close
```

- **Order:** `http.facet` (plugin `chord.http`) serves `Http` (`compose`: the router), `Authenticators` (every
  contribution in order) and, with `listen`, the listener, a host-lifetime object whose native is Chord's Node server:
  it opens right after the publication. The facet is the same object at every reload, so a reload never closes it.
  `fetch` resolves the registries once; requests before the publication wait (503 past the host's `readyTimeout`; a
  `close` meanwhile: 503).
- **Admission** (every request and upgrade, first): local only when the connection's local address is loopback, `Host`
  is a loopback name with the listening port (`127.0.0.1`, `localhost`, `[::1]`; without it on port 80) and no
  `Forwarded`/`X-Forwarded-*` header; a forwarded request on loopback only when a contributed relay verifies it
  (`provenance: { kind: "relayed", relay, origin }`, its framer allowed; an `origin` or `framer` that is not exactly an
  origin refuses the request, reported `hook_failed`); otherwise only an allowed host (a
  contribution's `hosts`, compared as the client sends it: `notes.example.com:443` is another name), as https; else 403.
  Two `Host`s, none, an absolute-form target and a `Host` with userinfo are 403; `TRACE`, `TRACK` and `CONNECT` (which a
  Web `Request` cannot carry) are 501, served for no resource, and a route contributed for one is refused at compose,
  reported as a conflict. A mounted handler passes what it knows of the connection:
  without `localAddress` and `localPort` no request is local. `request.origin` and `request.provenance` come only from
  here.
- **Foreign requests** (Fetch Metadata: `Sec-Fetch-Site` neither `same-origin` nor `none`, or a frame not from this
  origin) are never authenticated, except a top-level navigation (`GET`, `navigate`) to a `page: true` route. A foreign
  `Origin` is 403 on every request and upgrade, and an unsafe method from a browser needs the app's own `Origin`; a
  `crossSite: true` route opts out and always runs anonymous. A request without the headers (a script, the TUI) is not
  a browser's.
- **Who:** the authenticators in contributor order (plugin name: an order that means nothing, so an app needing
  precedence between credentials contributes one authenticator that decides); the first principal wins, a throwing one
  is reported `hook_failed` and skipped; none: anonymous; once the request is gone or sealed no further one starts.
  `cookie(name, value, { secret, request, sameSite?, maxAge? })` makes a signed `HttpOnly`, `Path=/`, `SameSite=Strict`
  (or `Lax`) cookie, `Secure` on a remote origin, its expiry (`maxAge`) signed with it; `readCookie(request, name,
  secret)` reads it back, its signature and expiry checked. A cookie without `maxAge` holds until the secret changes.
  Authenticators run raced against the request's signal: a client gone or `close`'s seal answers 503 (or refuses the
  upgrade) without waiting for them.
- **A request's scope:** one `host.root` scope with its principal (an explicit `undefined`: anonymous) spans matching,
  wraps, the route and its response until the body is written (Chord's listener: flushed) or abandoned; its signal
  aborts when the client disconnects. An anonymous scope gets no remote object served here (`forbidden`: a `forbidden`
  escaping a route answers 403, unreported), but a local
  object it calls acts as its handler is written: a local helper calling remote types runs them as the host. A socket
  handler's scope lasts until its socket closes.
- **`HttpRequest`:** `method`, `path` (dot segments resolved), `params`, `query`, `headers` (Web `Headers`), `origin`,
  `provenance`, `nonce` (fresh for every response), `json(limit?)` (1 MiB; malformed 400, too large 413),
  `body(limit?)` (chunks, 413 past the limit; a body cut short, by a disconnect or a broken stream, is a 400: a prefix
  never parses as the whole). An `HttpFailure` escaping a route answers its status. Chord's listener drains a body
  nobody read after the response up to 64 KiB, else closes the connection.
- **Patterns:** exact segments, `:name` (one non-empty segment, decoded), a trailing `/*` (the rest, possibly empty:
  `/files/*` matches `/files`); a `:name` or rest segment decoding to one with `/`, `\` or NUL, or to `.` or `..`, is a
  400; the most specific match wins segment by segment from the left (exact, `:name`, `*`); each route names its params
  by its own pattern; one pattern from two contributions is a reported conflict (`registry_conflict`), the first by
  plugin name wins; `HEAD` falls back to the `GET` route of the same path; no route: 404.
- **Wraps:** phases `observe`, `headers`, `transform` (outermost first), within a phase in contributor order; around
  the contributing plugin's routes (`scope: "own"`, default) or every route (`"all"`); `route` narrows to one (a route
  nobody contributes: a reported conflict). A throwing route or wrap is a 500 without its message (`route_failed`,
  `wrap_failed` naming the plugin).
- **Responses:** `json`, `html`, `redirect`, `error` (204, 205 and 304 without a body), `bytes` (`read(offset, length,
  ctx)` in 256 KiB pieces as the consumer pulls; once the request's scope is sealed, by a disconnect or `close`, no read
  starts and the stream errors, which ends the request even if its consumer never reads again; with `size`:
  `Content-Length`, `ranges` (one range 206, unsatisfiable 416, several 200); without: until an empty read). A `bytes`
  read that throws or comes back short is reported `response_failed` and destroys the connection. `bytes` refuse a
  foreign request (403), are an attachment unless `inline` (then with a `sandbox` CSP), and a `download` name drops
  control and bidirectional formatting characters. `fileResponse(path, { download?, inline?, ranges?, mime?, root? })`
  stats at once (a missing file is 404, with `root` a real path outside it is 403), opens its handle at the first read
  and closes it when the request's scope seals; its type comes from a small table (text, images, audio, video), never
  HTML or SVG unless named.
- **Default headers** on every answer, the component's own 403, 404 and 503 included: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (without framers), a CSP
  (`default-src 'none'`, scripts `'self'` and the response's own nonce, `connect-src` self and its WebSocket, `base-uri
  'none'`, `form-action 'self'`, `frame-ancestors` the framers or `'none'`, plus contributed sources). A response's own
  headers replace same-named ones (a list sends one line per value: several `Set-Cookie`); a header with a CR, LF or
  NUL, or a value that is no JSON, is a 500 reported `response_failed`.
- **Sockets:** after admission, the origin checks and the authenticators (no principal: 403 before plugin code), a
  `ws` WebSocket (its own server per upgrade, no compression) with an `error` listener attached (an oversized frame
  closes it, 1009); a throwing handler is reported `socket_failed` and closes it (1011). Pinged after 15 s of silence,
  terminated 15 s later without an answer. A client gone while its upgrade authenticates aborts that work.
- **Links:** `links.path` upgrades to `host.accept(webSocketLink(socket), { principal, limits })` with what
  `links.options` gives that socket (`maxPayload`: 1 MiB by default); a client that stops reading is cut off once more
  than 4 MiB beyond the frame being sent waits.
- **Revocation:** when a router change removes the host, the relay or the socket handler a link or socket came through,
  it is terminated at once and its scope sealed (no close handshake a peer could ignore). Identity is the handler's: a
  writable contribution changing only its hosts keeps its own sockets. An upgrade is checked again against the current
  router after its authenticators answered.
- **`close(ctx)`:** new requests and upgrades refused (503), sockets and links closed (1001, terminated at
  `closeTimeout`), running requests and upgrades waited for up to `closeTimeout` (30 s; an aborted `ctx`: not at all),
  then sealed. Run it before `host.close`: the host's close seals every request's scope first, so the listener's native
  close (which runs it too, then closes its connections) only seals.
- **Node's own limits** stay Node's defaults on the listener: `headersTimeout` 60 s, `requestTimeout` 300 s, 16 KiB of
  headers (431), keep-alive 5 s.

## Examples

`test/next/examples/`: `40-http` (the listener, a page with the nonce, a JSON route and a download with a range),
`44-http-wraps` (a plugin's own wrap and one around every route), `45-plugin-socket` (a plugin's WebSocket, refused
without a principal), `46-allowed-hosts` (a tunnel plugin allowing its host at runtime), `47-http-own-server` (the
handler mounted in an app's own Node server), `48-http-baseline` (a signed cookie, foreign requests, a page link, a
webhook).

## Inside the directory

`http.ts` (`createHttp`: the facet, `fetch`, the upgrade adapter, `close`), `node.ts` (Chord's Node server: Node
requests as the component reads them, answers written; `nodeRequest` for apps mounting on Node), `incoming.ts` (one
request shape for both), `router.ts` (the registry `Http` and its `compose`), `authenticate.ts` (`Authenticators`),
`admission.ts` (provenance, relays, foreign requests, `Origin`), `headers.ts` (the default headers and the CSP),
`cookies.ts` (`cookie`, `readCookie`), `request.ts` (`HttpRequest`, bodies, `HttpFailure`), `response.ts` (descriptions
as answers: ranges, attachments, pulled bodies), `file.ts` (`fileResponse`), `upgrades.ts` (links and plugin sockets:
kept, revoked, heartbeat, closed).
