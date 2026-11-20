# Building p3 on Chord

How p3 fits together, what a p3 plugin looks like, the rules, and the mistakes we made with their fixes. Add to the
mistakes table whenever a package teaches something.

## How p3 fits together

```text
pages, terminal clients   not addressable; reach everything through the server (WebSocket /chord, a sign-in)
        │
     server               one per Pi: host at Server(), its store, HTTP, every plugin built here at start
        │                 one link per worker; the server relays clients' holds and calls
session workers           one process per session: host at Session({ id }), its own store, the worker facets
```

- **A host** is one participant; **a link** joins two. A plugin never sees processes: it serves objects on a host
  kind and asks for objects by contract (`ctx.get`, `self.get`); Chord routes and relays.
- **A plugin** is a folder in a plugins root with one file per facet kind: `server.ts`, `worker.ts` (p3's kinds today;
  `web` and `terminal` come with the UI). The server builds its server facets with esbuild at each start, and the
  worker facets when they are first needed (the first worker's start, or an apply), then ships them to the workers: a
  broken worker facet shows its error there, in the first worker's start and the server's log, not at the server's
  start. A plugin imports only `@earendil-works/p3/v1` (and `/v1/server`, `/v1/worker` in
  those facets), its own files, other plugins' contract files by relative path, and its npm dependencies (inlined).
  Never Chord directly; never `import()` (plugins load whole, at start).
- **The store:** the server and every worker have one SQLite store, synchronous (a query blocks the event loop).
  What is needed while no worker runs lives on the server; the session's own data in the worker's store; never one
  fact in both.
- **Admission:** before an object of a remote type is built, its `admit` reads data about the caller and allows (with
  a value for the factory) or denies. The route to session workers has one too: no worker starts for a session that
  does not exist, and no worker reaches another session's worker (`apps/p3/src/server.ts`).
- **Reload:** applying a plugin's new code restarts its live objects on that code; documents and tables stay; running
  calls finish on the old code. Server first, then workers, then clients. Base code (`src/`, the API, Chord) changes
  only with a restart. Everything a plugin keeps across a reload is in its store.
- **The base** (`apps/p3/src/`) is only what must exist before plugins load: per host kind a bootstrap (`server.ts`:
  the data directory's socket, `server.sock`, which is the lock and the command's channel (`local-socket.ts`); the
  store, the host, Chord's HTTP and plugins components, the route to session workers; `worker.ts`: the session's
  lock, store and host, connected to the server), and the registries of process values it serves (`ServerRuntime`,
  `WorkerRuntime`). Everything else is a plugin: how a session's worker runs (`runner`), who someone is (`sign-in`),
  the owner's stop and apply (`control`), the sessions (`sessions`).
- **Session workers:** the route's `resolve` asks the `WorkerRunners` registry; the `runner` plugin forks one process
  per session. A worker stops itself once it was idle for its idle time (the runner's worker facet: no holds, calls,
  jobs, and every `WorkerBusy` count 0; the harness contributes "a run is active"); its store's commits settle first.
  A crashed worker fails its session until `retry` or an apply. After a server restart the sessions plugin's waker
  starts the workers of every `working` session. One worker per session store: a worker takes its session's lock (a
  socket, `<data directory>/locks/<hash>`, named by the runner) before it opens the store, so a successor (after a server's crash, or a reload of the
  runner) waits until the previous worker exited.

## The API (`@earendil-works/p3/v1`)

| Module | What you get |
| --- | --- |
| `/v1` | everything of Chord's root (`remote`, `local`, `method`, the schema helpers, `defineTable`, `query`, `queries`, `defineState`, `defineRegistry`, `allow`, `deny`, `forbidden`, `invalid`, ...), `BACKGROUND_CONTEXT`, `Context`, `JsonValue`, `defineFacet` typed with p3's principals, the host kinds `Server()` and `Session({ id })`, the helpers `forward`, `contribute` and `reportError` (a failure nobody awaits: stderr now, telemetry with the telemetry package), `P3Principal`, and the contracts p3 promises to third-party plugins (the sessions plugin's: `Sessions`, `SessionsList`, `SessionFacts`, `SessionWorker`, `SessionStart`, `SessionRow`, `SessionState`) |
| `/v1/server` | Chord's HTTP surface (`Http`, `Authenticators`, cookies), `ServerRuntime` (the data directory, the host, the store, the route to workers, apply, stop), `WorkerRunners` (how session workers run), `LinkOpened` (hooks on accepted links), `ServerCommands` (what `p3` runs over the data directory's socket, as the owner), `SessionRoute`, `writePrivate` (a private file written in one step), the worker control messages, the rollout types |
| `/v1/worker` | `WorkerRuntime` (the session, the host, the store, the directory, the idle time, `close`), `WorkerBusy` (counts that keep the worker alive) |
| `/v1/testing` | `testPlugin(root, { kind: "server" } or { kind: "worker", session }, context)`: Chord's plugin tier with p3's API, kinds, modules and principals (for a plugin's `test/` folder only) |

Principals are identity only: `{ kind: "owner" }`, `{ kind: "person", id, name }`, `{ kind: "worker", session }`,
`{ kind: "server" }`. What a person may do is data, read by admissions, never stored in the principal.

A plugin of another root (a third party's, in `<data directory>/plugins`) reaches the built-in plugins' contracts only
through the API (Chord decision "The app kit, point 5"): a relative path out of its root is a build error. The sessions
plugin's `contract.ts` is part of `/v1` through that re-export (v1 stays changeable until p3 is done).

Missing today (ask Mario, `process.md`): `withoutAbortSignal` and `pluginFile` are not exported; there is no `web` or
`terminal` facet kind yet.

## The shape of a p3 plugin (the sessions plugin, `apps/p3/plugins/sessions/`)

```text
package.json         { "name": "@earendil-works/p3-sessions", "private": true, "type": "module" }
contract.ts          contracts every kind imports (one per audience)
contract.server.ts   the store's contract, for server facets only
server.ts            the server facet: the table, the store, the views
worker.ts            the worker facet
test/server.test.ts  the plugin tier test of the server facet (`@earendil-works/p3/v1/testing`)
```

**One audience per contract.** The owner, a session's worker and the server never share a contract through variants;
variants are levels of one audience (`viewer`, `participant`). A worker reading its own session gets its own contract.

```ts
// contract.ts: what other plugins and facets import
export const Sessions = remote("sessions.sessions", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { owner: { methods: { create: method(obj({ title: opt(Title) }), str()), rename: …, archive: …, restore: … } } } });
export const SessionsList = remote("sessions.list", { version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() },          // view: the screen's own id
	hostAddress: () => Server(),
	variants: { owner: { state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) }, methods: { more: method() } } } });
export const SessionFacts = remote("sessions.facts", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { state: { session: union([SessionRow, nul()]) } } } });   // the worker's own row: its principal names it

// contract.server.ts: the store, for server facets only; other objects read its named queries
export const SessionsStore = local("sessions.store", { version: 1, params: {}, members: {
	sessions: queries(SessionRow, { active: obj({ app: str() }), archived: obj({ app: str() }), one: obj({ id: str() }) }),
	create: method(obj({ title: str(), creator: Creator }), str()), rename: …, archive: …, restore: … } });
```

**The store owns the table; every write goes through it; reads are named queries.**

```ts
const Rows = defineTable("sessions.rows", { version: 1, columns: ROW, key: ["id"],
	indexes: { active: ["app", "archivedAt", "lastTouch"], archived: ["app", "archivedAt"] } });   // one index per list's order

host.serve(SessionsStore, (_params, self) => {
	const rows = self.table(Rows);
	const update = (id, change, ctx) => self.tx(async (tx) => {
		const key = { id: Session({ id }) };
		if ((await tx.get(rows, key)) === undefined) throw invalid("args", `sessions: no session ${id}`);
		tx.update(rows, key, change);                                // an update names its columns: readers that need none skip
		return null;
	}, ctx);
	return {
		sessions: self.queries(rows, { map: shown }, {
			// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
			active: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), eq(s.archivedAt, 0))).orderBy((s) => s.lastTouch, "desc"),
			archived: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), gt(s.archivedAt, 0))).orderBy((s) => s.archivedAt, "desc"),
			one: ({ id }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
		}),
		rename: ({ id, title }, ctx) => update(id, { title }, ctx),
		archive: ({ id }, ctx) => update(id, { archivedAt: Date.now() }, ctx),
		// create, restore …
	};
});
```

**Views forward; lists are `self.list`; a worker follows its row with `self.liveQuery`.**

```ts
host.serve(Sessions, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const store = self.get(SessionsStore, {});
	return forward(store, Sessions, "owner", {                        // members taken from the store, by the contract's names
		create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),   // one that needs the caller
	});
});

host.serve(SessionsList, ({ app, set }, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: 50 });
	return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
});

host.serve(SessionFacts, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
	const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: principal.session }, { first: 1 });
	return { variant: "worker", members: { session: self.derive([found], ([{ rows }]) => rows[0] ?? null) } };
});
```

**Helpers in p3's API:** `forward(store, Remote, variant, own?)` fills a view's members from a store by the remote
contract's names (never derive a public contract from a store: it would publish whatever internal member is added
next); `contribute(host, name, register)` makes an object that only contributes, when a contribution needs a
reference or a native.

## Rules

**Data**
- One owner per datum, written only through it. **No copies** of a value in a second place: read it with a named
  query, a join or `exists`.
- **No hidden caps.** A list is `self.list` with `more`; a set that decides access is read whole or fails closed when
  it has more rows than it read. Never `{ first: 1000 }` and hope.
- Index and order columns are never optional (store "none" as 0, show `null`). Every named query says in a comment
  which index serves its condition and order, and a plan test proves it (`testing.md`). A list's whole order, the key
  Chord appends included, must be its index's order, or SQLite sorts every page: one index per list's order. An
  `inArray` on one column with an order on another walks the order's index: order by the `inArray` column first.
- A write that changes a few columns is a `tx.update`, never a `put`: readers that depend on none of the columns skip.
- Hot details (tokens streaming, progress, timers) never reach a table a list reads. A session's row holds
  transitions only.
- Counts read every row they pass: `self.count` only where a key or an index bounds it; lists use `more`.
- A table's definition (columns, key, indexes) is part of its version: changing it means a new version and a
  migration. Chord refuses to open a version recorded with another definition ("a history edited in place"); before
  p3's first release a data directory of an older build is deleted instead.

**Lists**
- One remote object per screen, the screen's own id in its params; `self.list` tiles pages between fixed bookmarks,
  so rows that reorder leave no gap and no duplicate, and `more` sends only new rows. Never chain pages, never grow
  "the first n".
- Drive a list from what the person has (their memberships, their shares, what they created); an `exists` is never
  the selective part of a list.
- A screen composed from several plugins (the sidebar) is one server object per person composing small reads.
- A new row enters an open list's first page: a test that wants "the first page, then `more`" opens the list after
  creating the rows.
- Two objects reading the same named query with the same arguments are two reads; when it matters, one local object
  per entity holds the read and the others read it.

**Access**
- A person's data comes from admission, never from params. Params only narrow inside what admission allows.
- App-specific views check the session's **current** app.
- Conditions are built by server code; clients send values only.
- Per-person rows (pins, unread marks) are filtered by the person, not only by the access condition.
- Admission values are small (a mode, a role).
- No `self.job` in an admitted type: work for a person lives in a local store, carries the person, asks again on
  every run.
- Workers: never check whether a call comes from a worker that is gone; Chord settles an exiting worker's calls
  before it publishes the exit. Data kept across a worker's runs is tagged with `ctx.incarnation`.

**Reload**
- Everything kept across a reload is in the store's tables and documents; writables start over. A list's bookmarks
  survive a reload, not a restart.
- Edit and reload every facet you touch while it is used (a list open, a worker running), in a test: nothing lost, no
  error.

**Releases** (p3 runs from the checkout and as an installed release; both must work)
- Plugins ship as source and are built at start; their tests live in their `test/` folder (the release leaves it
  out).
- Node flags go into the worker's `execArgv` (`apps/p3/src/install.ts`), never only into `npm test`.
- A package that changes what the release ships runs `npm run release:p3:local` (`testing.md`).

**Code** (the Chord v2 code style of the root `AGENTS.md`, for plugin code too)
- One concept per file, named after it; the first line says what the file is for; the public entry first, helpers
  below in the order used.
- Every export has a one-line doc comment. Comments explain a non-obvious why, never what the next line does.
- Short functions with one job; no boolean flag parameters; never the same lines twice; context last
  (`fn(args, ctx)`).
- Tagged unions for states and results; casts only where TypeScript cannot express an invariant, with a why; runtime
  checks only at trust boundaries (wire input, schema-checked arguments, files people edit), each named.
- Caches are `WeakMap`s keyed by their owner, with a GC test; no module-level strong caches; no hot-path work nobody
  asked for.
- Names from `names.md`; no `any`; no inline imports; no dev or test modes.

## Mistakes we made (and the fix)

| Mistake | Fix |
| --- | --- |
| The newest 200 as "the list" | `self.list` with `more` |
| A facts document beside each row, written twice | the worker reads its row with `self.liveQuery` by id |
| Two page objects tiled by row number: a row moving to the top fell between them | one list per screen; pages bounded by bookmarks inside `self.list` |
| Growing a window ("first 100, then 150") re-sent every loaded row | `more` on the same object: only new rows travel |
| The team's id taken from the page's params | the team comes from the admission; params only narrow |
| The team page joined side rows without checking the session's current app | every app-specific view checks the current app |
| Pins read by the access condition only: Bob saw Alice's pins | per-person rows filter by the person |
| `{ first: 1000 }` for a person's shares | `exists(Shares, …)` in the condition, or read whole and fail closed |
| An `exists` as the selective part of a person's list: a guest's list walked the whole app | drive the list from the person's own rows |
| `inArray(state)` ordered by `lastTouch` walked all 10,000 rows | order by the `inArray` column first |
| Mirroring last touch into the team's row to make the order cheap | a keyed probe skips reads a write cannot affect; no copy |
| A count behind a hot column | count only what a key or an index bounds |
| A whole store exposed as a remote contract | an explicit contract and `forward` |
| Seven plugins checking a worker's generation by hand | the runner counts a worker's exit once the commits its calls queued settled |
| A test plugin re-declared another plugin's contract (a second root cannot import it): Chord refused the different schema | the API re-exports the contracts p3 promises; a plugin of another root imports them from there |
| `"report" in entry` to tell apart the members of an untagged union | tagged unions (`kind`), a `switch` on the tag; `in` only at a trust boundary on an `unknown` value |
| The worker's bundle imported the server's API module, and with it Chord's HTTP stack (`ws`, `node:http`) | the API modules per process (`SERVER_MODULES` in `server.ts`, `WORKER_MODULES` in `worker.ts`); the release's lean check catches it |
| One index for two lists: the archived list's tie-break was not in its index, so SQLite sorted every page | one index per list's order, and a plan test |
| A revoked device's open socket kept working | a sign-in closes its own links (`links.opened`'s `close`), never `host.revoke` (it ends shared objects for every device) |
| Files of a few lines each (`modules-server.ts`, `worker-core.ts`, `channel.ts`, ...) spread a concept over the tree | a few lines go into the file that uses them; split only a second concept, never for size |
| A secret file linked into place: Android forbids hard links, p3 could not start | write a temporary file, then rename it |
| The command sent the owner token to whatever listened on the port `running.json` named: a lock any local user could hold, a file a crash left | the data directory's socket is the lock and the channel: only the owner's processes reach it, the holder answers what it is, no token travels |
| A crashed server's successor started a session's worker while the previous one still closed the same store | a lock per session, taken before the store opens; the successor waits for it |
| A test helper read `/proc/<pid>/task/<pid>/children`, which Android's kernel lacks | scan `/proc/*/stat` for the parent |
| A worker thread per code-mode script (p2): 10 to 28 MiB per worker | QuickJS inline, opened on first use |
| Braille glyphs for the working dots: Android's font draws one frame in the wrong column | draw the dots ourselves |
