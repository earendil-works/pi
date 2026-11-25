# Slice 13: the app kit (spec)

Status: **approved** (owner, 2026-11-01: decisions "The app kit, point 1" to "point 5", then "go ahead, just do all
the things"). Builds on slices 10 (`http`, `workers`) and 12 (the plugin model). `chord/app` in
`src/node/app/`: an opinionated layer so an app is its API, its built-in plugins and a start script.

Read in full before writing code: this spec; `decisions.md` entries of 2026-10-31 and 2026-11-01 (the app kit, the
plugin model, "The app kit is opinionated", "Settings are arguments, extensions are registries", "The HTTP
component's security baseline"); `design.md` §3, §4, §10, §21, §23 (all of it, "The app kit" included); `slices.md`
(carry-over "Slice 13"); `slice-10.md`, `slice-12.md`; the READMEs of `node/http`, `workers`, `plugins`; p2's
`src/runtime/server.ts`, `src/hosts/server.ts`, `src/hosts/worker.ts`, `src/runtime/loopback-cookie.ts`,
`src/hosts/principals.ts`, `plugins/devices/`, `plugins/sharing/`, `plugins/files/` for what exists.

## 1. `startApp` and `startWorker`

```ts
// start.ts (the app's start script)
const app = await startApp<P>({
	name: "acme",                                   // the default data directory: ~/.acme
	dataDir: process.argv[2],                       // optional; no environment variables
	listen: { host: "127.0.0.1", port: 8788 },
	api: { name: "@acme/app", versions: ["v3"], modules: { "@acme/app/v3": apiV3, "@acme/app/v3/server": apiV3Server } },
	kinds: { server: { platform: "node" }, worker: { platform: "node" }, web: { platform: "browser", packages: { react, "react/jsx-runtime": jsx } } },
	principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", key: address.key }) },
	workers: [{
		kind: Project,                              // a host kind the app defines, any params
		entry: "./worker.ts",
		start: (address, ctx) => ({ id: address.params.id }),
		authorize: (principal, address) => mayReach(principal, address),
		idleMs: () => 5 * 60_000,
	}],
	onError: (error) => log(error),
}, ctx);
// app.host, app.http, app.workers, app.plugins, app.applyChanges(ctx), app.exportAddress(address, ctx),
// app.importAddress(archive, address, ctx), app.ownerLink(), app.close(ctx)
```

```ts
// worker.ts
await startWorker<P>({ api, kinds, onError });   // reads the start message, opens the worker's store, loads plugins
```

- `startApp` creates the data directory layout (§4), opens the server store, creates the host (address `Server()`,
  the server principal), `createHttp` (settings as arguments), `createWorkers` per worker kind (`kind` named after the
  host kind; the worker's facet kind is `worker` unless the entry says otherwise), `createPlugins` with the roots of §5
  and the app's API (slice 12), loads the server's plugins with the kit's own facets (§2, §3, §4) as core, and resolves
  once loaded. `close` closes in the right order (http, workers, host, store).
- `startWorker` is `workerMain` plus: the worker's directory and store under its kind and address, the host with the
  principal from the start message, `connect` first, plugins loaded with the kit's worker facets, `busy` from the app
  if given.
- The start-data facet: the kit serves `AppInfo` (data directory, app name, version) on the server and `WorkerInfo`
  (address, start data) on workers as core objects plugins `get`.
- Zero worker kinds: no workers component.

## 2. Principals and sign-ins

- The app's principal type `P`; the kit needs only `principal.server` and `principal.worker(address)`. The kit adds
  one variant for its owner: `{ kind: "owner" }` must be assignable to `P` (a type check). (Superseded: decision "The
  kit's owner is a principal the app chooses".)
- **Sign-ins** (`SignIns`, `app/sign-ins.ts`; named `Sessions` until 2026-11-13, decision "Sign-ins, not sessions"; a kit object on the server, persisted in the server store): `issue(principal,
  { label, kind: "browser" | "device" }, ctx)` returns a token; tokens stored hashed; `revoke(id)`; `list` (watchable:
  label, kind, created, last used). The kit's authenticator (contributed to `Authenticators`) reads the sign-in cookie
  (signed, `HttpOnly`, `SameSite=Strict`) or an `Authorization: Bearer` header, and gives its principal.
- **Owner link:** at start the kit issues a one-time token (random, single use, valid 10 minutes, replaced at each
  start) and `app.ownerLink()` returns `http://127.0.0.1:8788/_chord/owner#<token>`; the start script prints it. The
  route `GET /_chord/owner` serves a page that posts the token (from the fragment, never sent in a URL to logs) to
  `POST /_chord/owner`, which consumes it and sets a browser sign-in cookie for the owner. No owner by loopback alone.
- **Owner token file:** `<dataDir>/owner-token` (mode 0600, created at first start, a device sign-in of the owner) for
  command-line clients on the same machine.
- **Device pairing** (for remote command-line and TUI clients): `POST /_chord/pair` (public) returns `{ code, poll }`;
  the owner approves the code in a browser (`GET /_chord/pair/<code>`, owner only, a confirm page); the client polls
  and receives a device token. Codes expire after 10 minutes.
- **Deny by default** (an HTTP component change): a route or socket without a principal is refused (401) before plugin
  code, unless its contribution marks it `public: true` (routes: `{ handler, public: true }`; sockets likewise). The
  `/chord` links endpoint requires a principal. Foreign requests stay anonymous as before, so they reach only public
  routes. Slice 10's examples and tests mark their anonymous routes public.

## 3. Optional kit plugins

Shipped as plugins (in `packages/chord/plugins/` or exported facets the app adds to its root; choose one and say
why): `users` (accounts keyed by id, a profile schema the app passes in, `self.get(Users, {})` with `get`, `update`,
`list`), `invite` (invite links issuing a session for a principal the owner chooses), `ephemeral-login` (a public
route taking a name, issuing a session for `{ kind: "user", id: <fresh>, name }` that ends with the connection; the
app's `P` must allow it). Each contributes to `Authenticators` or issues sign-ins through §2.

## 4. Storage, files, export

- Layout: `<dataDir>/server/store.sqlite`, `<dataDir>/workers/<kind>/<encoded address key>/store.sqlite` plus that
  worker's files, `<dataDir>/plugins/` (the user's root), `<dataDir>/logs/`, `<dataDir>/owner-token`.
- **Files** (a kit facet on workers, and on the server for server-scoped files): `Files` (`local`, params `{}`, one per
  host) with `put({ name, mime, bytes })` for small files, `begin`/`append`/`finish` for large ones (design §23 chunked
  transfers), `read({ id, offset, length })`, `remove`, `list` (watchable index: id, name, mime, size, created), caps
  per host (an option). Stored under the host's directory (`files/`), the index in the store.
- **Export / import per address:** `app.exportAddress(address, ctx)` stops the worker (as `workers.stop`), writes one
  archive: the store's export archive (slice 6a) plus the worker's directory (files), and returns a readable stream or
  writes to a path; `importAddress(archive, address, ctx)` refuses an existing address, unpacks, and the next hold
  starts the worker. Format: a tar of `store.archive` and `files/`, with a small manifest (app name, API version,
  kit format version).

## 5. Plugins

- Roots: the app's `plugins/` (required, slice 12) and `<dataDir>/plugins/`. Installs (`app.plugins.install(source,
  ctx)`, slice 12's `installPlugin`) go to the user's root.
- `app.applyChanges(ctx)`: build the dirty plugins and roll out (server step, then the workers step); returns the
  rollout result; `app.plugins.state` for the app's button. Never applied by itself.

## 6. Not in slice 13

Web and TUI clients (slice 11, which builds on this kit: `startApp` gains the web surface there); telemetry (9);
project plugins (§26 #14).

## 7. Tests, examples, docs

- One test file per source file: start and close order; a server without workers; two worker kinds; the owner link
  (single use, expiry, the fragment), sign-ins (issue, revoke, list, hashed storage), the token file mode, device
  pairing, deny by default (a route without principal 401, a public route served, `/chord` refused anonymous), Files
  (small and chunked, caps, list, remove), export and import (a worker with documents, tables and files round-trips;
  importing over an existing address refused), `applyChanges`, required root failure stopping `startApp`.
- Examples: `53-app` (a small app: start script, API, two plugins, a worker kind, the owner link), `54-app-sign-ins`
  (pairing a command-line client), `55-app-export` (export and import a worker's address).
- `src/node/app/README.md`; the guide "Hosts and Plugins" gets a closing chapter on the app kit.
