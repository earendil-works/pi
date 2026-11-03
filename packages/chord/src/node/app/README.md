# app

The app kit (slice 13, design §23 "The app kit", decisions "The app kit, point 1" to "point 5"): an opinionated layer
over `http`, `workers` and `plugins` so an app is its API, its built-in plugins and a start script. `startServer` on the
server, `startWorker` in a worker's entry; the kit makes the data directory, the stores, the hosts, HTTP with deny by
default, sessions and the owner's sign-in, device pairing, each host's files, export and import per address, and the
plugin roots with "apply changes". Node-only. Exported as `@earendil-works/chord/app`. Examples 53 (`53-app/`, a whole
small app), 54 (sessions and pairing) and 55 (export and import) run one app.

## For apps (`index.ts`)

```ts
// start.ts (the app's start script)
const app = await startServer<P>({
	name: "acme",                                   // the default data directory: ~/.acme
	dataDir: process.argv[2],                       // optional; no environment variables
	root: "./plugins",                              // the app's built-in plugins (required root); this is the default
	listen: { host: "127.0.0.1", port: 8788 },      // 127.0.0.1 and a free port by default
	api: { name: "@acme/app", versions: ["v3"], modules: { "@acme/app/v3": v3, "@acme/app/v3/server": v3server } },
	kinds: { server: { platform: "node" }, worker: { platform: "node" } },
	principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", key: address.key }) },
	workers: [{
		kind: Project,                              // a host kind of the app, any params
		entry: "./worker.ts", execArgv: [...], env: {...},
		facet: "worker",                            // the facet kind its workers load (default)
		start: (address, ctx) => ({ id: address.params.id }),   // WorkerInfo.start
		authorize: (principal, address) => mayReach(principal, address),
		idleMs: () => 5 * 60_000,
	}],
	files: { maxFile: 256 * 2 ** 20, maxTotal: 4 * 2 ** 30 },  // every host's caps (these are the defaults)
	install: { npmCommand: ["npm"] },               // how installs run npm
	limits: { ephemeralSessions: 1000, pendingPairings: 100, pairingsPerAddress: 10,   // the defaults
		uploads: 64, importBytes: 4 * 2 ** 30, importEntries: 100_000 },
	web: { entry: "./src/web/main.tsx", page: (request, assets) => shell(request.nonce, assets) },   // slice 11
	tui: { entry: "./src/tui/main.ts" },
	onError: (error) => log(error),                 // AppError: { kind: "host" | "http" | "workers" | "plugins", error }
}, ctx);
console.log(`Open ${app.ownerLink()}`);
app.host; app.http; app.workers.get("project"); app.plugins.state; app.dataDir; app.ownerTokenFile;
await app.plugins.install({ git: url, ref: "v1" }, ctx);   // into <dataDir>/plugins/
await app.applyChanges(ctx);                                // build the dirty plugins, roll out: server, then workers
await app.exportData(Project({ id }), "p.tar", ctx);
await app.importData("p.tar", Project({ id: "copy" }), ctx);
await app.close(ctx);                                       // http, workers, host, store, plugins, the lock

// worker.ts
startWorker<P>({ api, kinds, busy, onError });
```

- **The principal type** `P` is the app's; the kit needs `principal.server` and `principal.worker(address)` and adds
  one variant, its owner: `{ kind: "owner" }` must be one of `P` (a type error otherwise, on `AppOptions`).
- **The API's modules** are named by convention: `<api>/<version>` for every kind and `<api>/<version>/<kind>` for a
  kind's own; a kind's `packages` (React for a web kind) are host packages besides. The modules are this process's
  instances; the worker's entry passes the same `api` and `kinds`.
- **`startServer`**, in order: the data directory, by its real path (refused when it is the home directory, a file
  system's root, or another user's: the kit would make it private), its lock (one server per data directory, also
  through a symbolic link: a second is refused after a second's wait), the layout made private (below), the cookie secret, the server's store, the host (address `Server()`,
  `principal.server`), `createHttp` (the links endpoint at `/chord`), the plugins component with the two roots, one
  workers component per worker kind (none without worker kinds), the server's plugins loaded with the kit's core
  facets (`chord.http`, `chord.app.info`, `chord.app.sessions`, `chord.app.owner`, `chord.app.pairing`,
  `chord.app.files`, `chord.themes`, `chord.themes.choice`, `chord.translations`, `chord.locale.choice`), the owner token file, the listening port, the owner link. A plugin of the required root failing
  rejects with the plugins component's `PluginError`, everything closed. `close` is idempotent.
- **`startWorker`** is `workerMain` plus: the worker's directory `workers/<kind>/<key>/` and its store there, the host
  at the address acting as `principal.worker(address)`, connected to the server first (trusted, as the server's
  principal), its plugins loaded with the worker's core facets (`chord.app.worker-info`, `chord.app.files`,
  `chord.translations`), `busy`
  from the app. A worker's errors reach the server as a fixed "worker failed" (the error stays in the worker's
  `onError`).

## Start data

The kit's start-data objects serve process values to plugins: `AppInfo` (`chord.app.info`, on the server: `dataDir`,
`name`, `version`, the newest API version) and `WorkerInfo` (`chord.app.worker-info`, on workers: `address`, `start`,
the start data the app's `start(address)` made). Plugins `self.get(AppInfo, {})` through the app's API, which
re-exports them; nothing else of the process reaches a plugin.

## Base code

An app's base code is its API, the start script and the worker's entry; everything else is a plugin. The pattern
(decision "The plugin model", point 8): the providers of the app's core registries and its harness objects are plugins
of the app's required root, not facets the start script passes, so they reload like any plugin and the API only
declares the registries; process values (paths, the start data, the version) reach them through the start-data
objects, not through closures over the start script. Example 53: the API declares `Sections`, the home plugin serves it
and reads `AppInfo`.

## Sessions and sign-in

- **Deny by default** (`http`): a route or socket without a principal answers 401 before plugin code runs unless its
  contribution says `public: true`; the `/chord` links endpoint needs a principal.
- **Sessions** (`Sessions`, `chord.app.sessions`, local, one per server): `issue({ principal, label, kind: "browser"
  | "device" | "ephemeral", secure? })` returns `{ id, token, cookie }`, `verify(token)` the principal or `null`,
  `revoke(id)`, `list` (browser and device sessions: `id`, `label`, `kind`, `principal`, `created`, `lastUsed`; never a
  token or hash). A token is `<id>.<secret>` (32 random bytes, base64url); only the secret's SHA-256 is kept, compared
  in constant time. The kit's authenticator reads `Authorization: Bearer <token>` or the session cookie
  `chord-session` (signed with `server/cookie-secret`, `HttpOnly`, `SameSite=Strict`, `Secure` for a remote browser,
  400 days, renewed by a response once older than a day, so a browser used within every 400 days stays signed in;
  an ephemeral one only while the browser runs); a malformed token or an id that is no session (a prototype
  key included) is a plain 401. Browser and device sessions persist in the server's store; `lastUsed` is written at
  most once a minute, and a session unused for 400 days ends (checked when it is used, removed then). Ephemeral
  sessions (a public login) live in memory only (`ephemeral-sessions.ts`), never listed: at most
  `limits.ephemeralSessions`, none outliving the server's run, so a login costs the same whatever came before. Past
  the cap the oldest ends: a flood of logins signs out the earliest ephemeral users (the trade for bounded memory). An
  ephemeral session ends with its client's connection (slice 11): once the last Chord link opened with it closed and
  none opened for a minute (a reload, a reconnect), or when none opened within a minute of the login; the links
  endpoint's `opened` hook counts them.
- **The owner link:** each start makes a one-time token (single use, 10 minutes, the previous start's no longer
  valid), `app.ownerLink()` is `http://<the address listened on>:<port>/_chord/owner#<token>` (`127.0.0.1` for
  `0.0.0.0`, `[::1]` for `::`, an IPv6 address in brackets). The page at `GET /_chord/owner` posts
  the fragment's token to `POST /_chord/owner` (public), which consumes it and sets an owner browser session's cookie.
  The token stays in the fragment: browsers never send it, so it never reaches a log. No owner by loopback alone.
- **The owner token file** `<dataDir>/owner-token`: a device session of the owner for command-line clients on the same
  machine, mode 0600, written in one step (a temporary file made exclusively with mode 0600, then linked or renamed into
  place). Kept while its token authenticates as the owner (its session exists, the secret matches, not expired; its
  mode set to 0600 again); replaced at the next start otherwise.
- **Device pairing** for clients elsewhere: `POST /_chord/pair` (public, `{ label? }`) returns `{ code, poll }`; the
  owner opens `/_chord/pair/<code>` signed in (owner only, a confirm page naming the device) and approves; the
  client's `POST /_chord/pair/poll { poll }` answers `{ status: "waiting" }` until then, `{ status: "approved", token }`
  once, then 404. Codes are `XXXX-XXXX` from 31 unambiguous characters (`crypto.randomInt`), single use, 10 minutes;
  the poll secret is kept hashed. Asking is public, so pairings anonymous clients start are bounded:
  `limits.pendingPairings` in all, `limits.pairingsPerAddress` per client address (`HttpRequest.remoteAddress`); past
  them 429. The trade: whoever fills the caps locks anonymous pairing out for up to 10 minutes, and behind a tunnel or
  relay every remote client shares one address (the tunnel's), so ten requests from one party block remote pairing
  for all. A signed-in owner's own `POST /_chord/pair` is not counted: the owner can always start one. Pairings and the owner link live in memory: a restart drops them.

## Optional plugins

`defineUsers(profile)` (accounts by id with the app's profile schema: `Users` with `list`, `get`, `update`,
`remove`), `inviteFacet()` (the owner's `POST /_chord/invites { principal, label }` makes a 7-day single-use link,
whose page signs the invitee in as that principal) and `ephemeralLoginFacet<P>()` (a public `POST /_chord/login {
name }` signing in as `{ kind: "user", id: <fresh>, name }`, a type error unless `P` allows it). They are exported
facets, not plugin directories: each takes the app's settings as arguments (a profile schema, the principal type),
and a plugin directory could not import the kit (plugins import only the app's API). The app re-exports one through
its API and adds a one-line plugin to its root:

```ts
// app/v3/server.ts
export const users = defineUsers(obj({ name: str(), avatar: opt(str()) }));
// plugins/users/server.ts
import { users } from "@acme/app/v3/server";
export default users.facet;
```

## Storage and files

```
<dataDir>/                 mode 0700, like every directory below
  server/store.sqlite      the server's store, mode 0600 (and its journal files)
  server/cookie-secret     mode 0600
  server/files/            the server's files, mode 0600
  workers/<kind>/<key>/    a worker's store.sqlite and files/
  plugins/                 the user's plugins root
  logs/
  owner-token              mode 0600
```

Every start sets these modes again, on the server's part when the server starts and on a worker's when it starts:
a data directory made looser before (or restored with other modes) is tightened, so other local users can neither
read a store (it holds the sessions) nor replace it.

A worker's key is percent-encoded as one directory name (`/`, `\`, `.` and capital letters included, so keys differing
only in case stay apart on a case-insensitive file system), or `sha256-<hex>` past 160 characters.

`Files` (`chord.app.files`, local, one per host: the server's and each worker's) keeps a host's files in its `files/`
and their index (id, name, mime, size, created) in its store: `put({ name, mime, bytes })` (at most 4 MiB),
chunked transfers (design §23): `begin({ name, mime })`, `append({ upload, offset, bytes })` (at most 4 MiB a chunk,
about 1 MiB usual; `offset` must be the bytes stored so far, else `invalid` with the stored `{ offset }`),
`uploaded(upload)` (where a writer resumes after a drop), `finish(upload)`; `read({ id, offset, length })` (at most 4
MiB), `remove(id)`, `list`. Appends may be sent without waiting for the previous one: each is accepted at the offset
the accepted ones reached and written at its position (one file handle per upload); `uploaded`, `finish` and expiry
wait for the writes in flight, and a failed write ends its upload. Each upload under way holds a file handle, so at
most `limits.uploads` (64) are under way per `Files` object: past it `begin` is refused `unavailable` (`busy`) until
one finishes or an idle one expires. Caps per host (`files` option): a file over `maxFile` or a write past `maxTotal` (uploads
under way count) is refused `too_large`. An upload unwritten for an hour expires; uploads end with the object, and
those a previous run left are dropped when the object goes live. `Files` is `local`: a client uploads through the
plugin's own remote methods, which call it.

## Export and import

`exportData(address, path, ctx)` writes the data the worker at `address` created (its store and finished files) to
`path` (mode 0600, staged and renamed), stopping nothing (decision "App kit naming and export"): a running worker packs
its own open store (`HostData`, `data.ts`, a kit object only the server's principal may use; the store's export holds
the commit queue while it reads, so the archive is one consistent point) and its files; with no worker running, the
server takes the worker's process lock (no worker starts meanwhile) and packs the store itself. A file added or removed
while the export runs may be outside that point (the index is the store's): each file is opened when the archive
comes to it (one descriptor at a time), one deleted meanwhile skipped or read from its open handle. `importData` takes the same lock (held: a
worker runs, so the address has data: refused) and changes nothing else. Registering an imported host in the app's own
index is the app's. The archive is a ustar of
`manifest.json` (`{ format: 1, app, api, address }`), `store.archive` (the store's export, JSONL) and `files/…`.
`importData(archive, address, ctx)` refuses an address that has a directory, unpacks beside it and renames into
place: the manifest must come first and name this app and format 1; only regular files and directories under
`manifest.json`, `store.archive` and `files/` are taken; absolute paths, `..`, `.`, empty segments, backslashes, NULs,
links, devices and bad checksums are refused (the kit's own tar reader, `tar.ts`); past `limits.importBytes` unpacked
bytes or `limits.importEntries` entries (counted from the headers before writing) it is refused. A refused or broken
archive leaves nothing. The next hold starts the worker on the imported store and files.

## Plugins

Roots: the app's `root` (required: a plugin of it failing stops `startServer`) and `<dataDir>/plugins/` (the user's:
installs go there). `app.plugins.state` is the plugins component's marks for the app's "apply changes" button;
`applyChanges` builds the dirty plugins (and installed ones) and rolls out to the server, then each worker kind;
nothing is applied by itself.

## Internals

`app.ts` (`startServer`, the `App`), `worker.ts` (`startWorker`), `layout.ts` (the layout, private directories and
stores), `secrets.ts` (tokens, hashes, files of mode 0600), `sessions.ts`, `owner.ts` (owner link and token file),
`pairing.ts`, `files.ts` and `uploads.ts` (chunked uploads), `info.ts` (start-data objects), `archive.ts` and `tar.ts`
(export and import), `ephemeral-sessions.ts`, and the optional plugins `users.ts`, `invite.ts`, `ephemeral.ts`.

## Web and terminal (slice 11)

With `web` the kit builds the page's base bundle from `web.entry`, publishes the `web` kind's plugin scripts and serves
the page through `web.page` at `web.paths` (`["/"]`), signed in unless `web.public` (`webSurface`,
`@earendil-works/chord/surfaces`); with `tui` the terminal's base bundle and the `tui` kind's scripts for launchers
(`tuiSurface`). Plugin assets are served under `/_chord/web/assets/` (the plugins component's `publicPath`).
`applyChanges` rolls out to the server, the workers, then the surfaces (`web`, `tui`: the new set published, clients
not waited for). `app.web` and `app.tui` give the base bundles' hashes. The server also serves the `Themes` registry and
`ThemeChoice` (each principal's dark and light pick, kept in its store). Without `web` and `tui` an app has no client
surface (API only).
