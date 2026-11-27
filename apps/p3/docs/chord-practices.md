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
  worker facets when they are first needed (the first worker's start or the first apply, whichever comes first; a
  later apply builds what changed), then ships them to the workers: a broken worker facet shows its error there, in
  the first worker's start and the server's log, not at the server's start. A built-in plugin failing fails the start;
  a plugin of the user's root that fails is reported in the server's log and left out. A plugin imports only `@earendil-works/p3/v1` (and `/v1/server`, `/v1/worker` in those
  facets), its own files, other plugins' contract files by relative path, and its npm dependencies (inlined).
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
  `WorkerRuntime`). Everything else is a plugin: how a session's worker runs (`runner`), who someone is (`sign-in`:
  the sign-ins, the owner link's page and post), the owner's `stop` and `apply` (`control`, as commands over the
  socket; there are no control routes over HTTP), the sessions (`sessions`).
- **The data directory's sockets** (`local-socket.ts`): `server.sock` (the server) and `supervisor.sock` (the
  background server's supervisor) are each a lock and the command's channel: one JSON request and answer. The trust
  boundary is the OS user: the directory is 0700, so only the owner's user can make or reach a socket there, and every
  process of that user may ask (the owner's programs, plugins, an agent's tools); no token travels. The start checks
  the data directory and its immediate parent only (`files.ts`), no ancestor above it (ERNDL-1059). POSIX only: p3
  refuses to start on Windows, where a named pipe is reachable by every local user (ERNDL-1059). A socket file a
  killed holder left is cleared and taken under a kernel-owned guard (Chord's `processLock`,
  `@earendil-works/chord/workers/child`), so two starters after a crash cannot both win; the guard is held for
  milliseconds, and a start that waits 10 s for it fails naming it (on Linux any local user can hold that name). A
  release removes the file only while it is still its own (same inode). Socket paths are short (108 bytes on Linux and Android, 103 on macOS):
  the start refuses a data directory too long for its longest socket, `supervisor.sock`.
- **Failures:** a failure nobody awaits goes to `reportError` (stderr now, telemetry later). A failed server store
  (`storage_failed`: a commit whose outcome is unknown) is not one of those: the server closes and exits non-zero,
  and the supervisor starts it again.
- **Session workers:** the route's `resolve` asks the runner the base uses: the one runner of `WorkerRunners` (the
  `runner` plugin's) with the wraps of `WorkerRunnerWraps` composed over it in plugin order; the status's pids (what
  `p3 stop` kills), the apply's workers step and `testServer`'s `workers` ask the same. To change how workers run
  (run some sessions elsewhere, count or delay starts), contribute a wrap, never a second runner: a second contribution
  to `WorkerRunners` is a misconfiguration, reported as a conflict naming both plugins and not used (the first by plugin
  name is). A wrap that runs sessions elsewhere answers `pids()` for its own workers plus `inner.pids()`, and keeps
  what it runs in its object: the base composes it again when the runner or a wrap changes. The `runner` plugin forks
  one process per session, its directory `<data directory>/workers/<session id>` (ids are the sessions plugin's UUIDs). A worker
  stops itself once it was idle for its idle time (the runner's worker facet: no holds, calls, jobs or lingering
  objects, and every `WorkerBusy` count 0; the harness contributes "a run is active"); its store's commits settle
  first.
  A crashed worker fails its session until `retry` or an apply. After a server restart the sessions plugin's waker
  starts the workers of every `working` session. One worker per session store: a worker takes its session's lock
  (Chord's `processLock`, named `p3-session:<data directory>/workers/<id>` by the runner; the kernel owns it, so a
  killed worker leaves nothing behind) before it opens the store, so a successor (after a server's crash, or a reload
  of the runner) waits until the previous worker exited.

## The API (`@earendil-works/p3/v1`)

| Module | What you get |
| --- | --- |
| `/v1` | everything of Chord's root (`remote`, `local`, `method`, the schema helpers, `defineTable`, `query`, `queries`, `defineState`, `defineRegistry`, `allow`, `deny`, `forbidden`, `invalid`, ...), `BACKGROUND_CONTEXT`, `Context`, `withAbortSignal`, `withCancel`, `JsonValue`, `defineFacet` typed with p3's principals, the host kinds `Server()` and `Session({ id })`, the helpers `forward`, `contribute`, `until(watchable, done, context)` (the first value for which `done` holds; the base, the plugins and the tests wait with it) and `reportError` (a failure nobody awaits: stderr now, telemetry with the telemetry package), `P3Principal`, and the contracts p3 promises to third-party plugins (the things plugin's: `defineThing`, `defineWorkspace`, `Workspace`, `Roots`, `WorkspaceChildren`, `MyAnswer`, ...; the sessions plugin's: `SessionKind`, `SessionObject`, `SessionDefaultsKind`, `SessionFacts`, `SessionWorker`, `SessionStart`, `SessionRow`, `SessionState`, `followSession`) |
| `/v1/server` | the things store (`ThingsStore`, `Gives`) and `serveThing` (a kind's server side), the sessions store (`SessionsStore`), Chord's HTTP surface (`Http`, `Authenticators`, cookies), `ServerRuntime` (the data directory, the machine's OS user and host name, the host, the store, the route to workers, apply, stop), `WorkerRunners` (the one runner) and `WorkerRunnerWraps` (how a plugin changes how session workers run), `LinkOpened` (hooks on accepted links), `ServerCommands` (what `p3` runs over the data directory's socket, for the owner's OS user: `stop`, `apply`, `owner-link`), `SessionRoute`, the worker control messages, the rollout types, Chord's `processLock` and `clearStaleLock` (a session's lock) |
| `/v1/worker` | `WorkerRuntime` (the session, the host, the store, the directory, the idle time, `close`), `WorkerBusy` (counts that keep the worker alive) |
| `/v1/testing` | for a plugin's `test/` folder only. `testPlugin(root, { kind: "server" } or { kind: "worker", session }, context)`: Chord's plugin tier with p3's API, kinds, modules and principals, and the base's own facet as the real host has it (`ServerRuntime` of a server that does not listen, starts no worker and applies nothing; or `WorkerRuntime` and `WorkerBusy`), each test with a temporary directory of its own, removed at `close`. `testServer({ plugins }, context)`: p3's real server on a temporary data directory with the built-in plugins and the plugins under test, workers as real processes, `client(ctx)` signed in as the owner (`testing.md`, tier 3); `ownerClient`, `ownerCookie` |

Principals are identity only: `{ kind: "person", id, name }`, `{ kind: "worker", session }`, `{ kind: "server" }`.
The owner is a person too, the one whose row says so (decision "The owner is a person"). What a person may do, being
the owner among it, is data, read by admissions (the things plugin's one admission of every kind, `followSession` for a session's
objects on its worker, `admitOwner`), never stored in the principal.

A plugin of another root (a third party's, in `<data directory>/plugins`) reaches the built-in plugins' contracts only
through the API (Chord decision "The app kit, point 5"): a relative path out of its root is a build error. The sessions
plugin's `contract.ts` is part of `/v1` through that re-export (v1 stays changeable until p3 is done).

Missing today (ask Mario, `process.md`): `withoutAbortSignal` and `pluginFile` are not exported; there is no `web` or
`terminal` facet kind yet.

## The shape of a p3 plugin (the sessions plugin, `apps/p3/plugins/sessions/`)

```text
package.json         { "name": "@earendil-works/p3-sessions", "private": true, "type": "module" }
contract.ts          contracts every facet imports (one per audience): the kinds, the worker's objects
contract.server.ts   the store's contract, for server facets only
server.ts            the server facet: the store, the kinds (`session.ts`, `defaults.ts`), the waker, the facts
worker.ts            the worker facet: the session's worker object, the holding of what the agent is given
web.tsx              the web facet: the kind's icon and create step on the page
test/session.test.ts the plugin tier test of the session kind (on the things plugin's world); end-to-end cases
                     sit in the tests of the whole (`testServer`)
```

**One audience per contract.** The owner, a session's worker and the server never share a contract; what some callers
of one audience may do and others not is a `grantable(...)` member or a flag their admission grants (Chord slice 15:
`state: { history: grantable(...) }`, `methods: { send: grantable(method(...)) }`, `flags: { export:
messages.message("…") }`, the label a message of the plugin's `messages.ts`, which the contract file may import: Chord's
`plugin-authoring.md`, "What a plugin may import"). A worker reading its own session gets its own contract.

```ts
// kind.ts: the session kind. A session is a session workspace (a kind of the things plugin): its ticks are its rights,
// its row a state member for everyone let in, Manage gives the changes. contract.ts holds what it is as data.
export const SessionKind = defineWorkspace("sessions.session", { version: 2, leaf: true, makers: "anyone",
	state: { row: SessionRow, detail: SessionDetail },
	methods: { archive: method(), restore: method(), setModel: …, moveLocation: … },   // its name: Configure in the parent
	ticks: { read: { label: messages.message("tickRead") }, send: { …, for: "people" }, stop: { …, for: "people" },
		manage: { …, for: "people", gives: ["detail", "archive", "restore", "setModel", "moveLocation"] } },
	defaultGrants: { agents: [MAKE_ANY], everyone: ["read", "send"], guests: ["read"] },
	create: { input: obj({ location: opt(Location) }) } });

// contract.ts: what the plugin's facets and other plugins import (the worker's own facts among them)
export const SessionFacts = remote("sessions.facts", { version: 2, params: {}, hostAddress: () => Server(),
	state: { session: union([SessionRow, nul()]), detail: SessionDetail },
	methods: { report: method(obj({ state: SessionState })), moveLocation: method(ConversationLocation) } });

// contract.server.ts: the store, for server facets only; other objects read its named queries
export const SessionsStore = local("sessions.store", { version: 2, params: {}, members: {
	sessions: queries(SessionRow, { one: obj({ id: str() }) }),
	moved: keyed(SessionDetail, Session),                             // a document per session, read whole
	insert: method(obj({ id: str(), location: opt(Location), model: … })), archive: …, report: …, working: … } });
```

**The store owns the table; every write goes through it; reads are named queries.**

```ts
const RowsV1 = defineTable("sessions.sessions", { version: 1, columns: { id: …, environment: str(), … }, key: ["id"],
	indexes: { working: ["state", "archivedAt"] } });                     // one index per query's order
// A changed definition is a new version: stored rows migrate (p3-base's data survives updates), never edited in place.
const Rows = evolveTable(RowsV1, (t) => t.rename("environment", "machine"));

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
			one: ({ id }) => query(Rows).where((s) => eq(s.id, Session({ id }))),   // the key
		}),
		archive: ({ session }, ctx) => update(session, { archivedAt: Date.now() }, ctx),
		// insert, restore, report, working …
	};
});
```

**A kind is `serveThing`: its object for one caller, its hooks; a worker follows its row with `self.liveQuery`.**

```ts
serveThing(host, SessionKind, {
	implement: ({ thing: session }, _admitted, self) => ({        // the things plugin admitted the caller
		row: self.derive([sessionRow(session, self)], ([row]) => row ?? missing(session)),
		archive: async (ctx) => { await store.archive({ session }, ctx); return null; },   // Manage only: Chord keeps it
		// restore, setModel …                                                          // from the others
	}),
	// Before the workspace's commit: the row, and what the nearest session defaults say of the new workspace.
	create: async ({ thing, input, by, workspace }, ctx) => { … return { defaultGrants, showsPeople, view }; },
	delete: async (session, ctx) => (await ctx.get(SessionsStore, {})).remove({ session }, ctx),
});

host.serve(SessionFacts, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
	return { session: sessionRow(principal.session, self), detail: store.moved.at(Session({ id: principal.session })), report: …,
		moveLocation: … };                                                // live queries of the store; writes through it
});
```

**Helpers in p3's API:** `forward(store, Remote, own?)` fills a view's members from a store by the remote
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
  migration. Chord refuses to open a version recorded with another definition ("a history edited in place").
  Stored data survives updates (decision 125): no data directory is deleted for a new build, and nothing is
  changed in place, however small the change and however short the old shape was on main. Every changed stored
  definition comes with its migration and a test of it: `evolveTable` to a new version for a table
  (`plugins/sessions/store.ts`, `RowsV2`), `migrate(old, from)` for a `json` column (`plugins/sessions/defaults.ts`)
  and for a document (`packages/chord/src/documents/README.md`). A contract whose members change bumps its `version`:
  that is the wire's version, nothing stored migrates with it. The migrations are collapsed once before the first
  release
  ([ERNDL-1192](https://linear.app/earendil/issue/ERNDL-1192)).

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
- Conditions are built by server code; clients send values only.
- Per-person rows (pins, unread marks) are filtered by the person, not only by the access condition.
- Admission values are small (a mode, a role).
- No `self.job` in an admitted type: work for a person lives in a local store, carries the person, asks again on
  every run.
- Workers: never check whether a call comes from a worker that is gone; the runner publishes a worker's exit only
  after its link is closed (nothing it sent is handled later) and the server's store settled the commits its calls
  queued. Data kept across a worker's runs is tagged with `ctx.incarnation`.

**Reload**
- Everything kept across a reload is in the store's tables and documents; writables start over. A list's bookmarks
  survive a reload, not a restart.
- Edit and reload every facet you touch while it is used (a list open, a worker running), in a test: nothing lost, no
  error. One decided exception: a reload of the sign-in plugin closes every `/chord` link its `SignIns` tracked
  (the next object could never close them); their clients sign in again.
- A contribution made by a native's successor comes after the apply returns: a reload of the runner plugin closes the
  old runner (its workers exit) before the new one is contributed, so between the apply's answer and that
  contribution no runner exists (holds wait for it; the route continues with the next runner). A test waits for it
  with `until` on the `WorkerRunners` registry, never on the apply's answer.

**Releases** (p3 runs from the checkout and as an installed release; both must work)
- Plugins ship as source and are built at start; their tests live in their `test/` folder (the release leaves it
  out).
- Node flags go into the worker's `execArgv` (`apps/p3/src/install.ts`), never only into `npm test`.
- A package that changes what the release ships runs `npm run release:p3:local` (`testing.md`).

**Values handed to Chord**
- Never change a value after you handed it to Chord (a state value, an admission's value, params, a method's
  arguments or result, a condition): make a new one. Chord keeps it without a copy and compares by identity first, so
  the same object changed in place reads as "unchanged": no rebuild, no update, nothing reported (Chord decision
  "Values handed to Chord are never changed afterwards", 2026-11-26; `plugin-authoring.md`, "Values you hand to
  Chord"). In-memory indexes that answer admissions (the things plugin's access index) hand out a new answer object
  for every changed answer and keep the old one untouched.

**Kinds** (the whole of it: `kind-pattern.md`)
- A feature people or the agent use is a kind of thing: `defineThing` in `kind.ts`, `serveThing` in `server.ts`, no
  admission of your own, no check of who calls. What is not granted does not exist on the object.
- A kind's harness part is registered with the one plain form `thingHarnessPart(Kind, (things, session) => …)`; no
  helper variants. What it registers replaces what it registered before; a part's tools that follow live state (an
  MCP server's tool list) use `again`, which gives only that kind again (decision 137). Decided (142), being changed
  on main (today the harness gives only kinds that hold something): the harness calls every part on every change of
  what the agent holds, possibly nothing, and the part checks for none itself, first: `if (things.length === 0)
  return { extension: {} };`. An empty extension, never `{}`: it keeps the kind's place in Durable's registry (a kind
  appended again changes the prompt's order and loses the provider's prompt cache). A part that gives tasks gives
  them always (`{ extension: { tasks: TASKS } }` with nothing held).
- A kind's method never checks the caller's access to its own thing again. Only a method that names another thing
  (Files and Terminals name a machine) checks the caller's answer on that thing.
- Nothing a person reads is written outside `messages.ts`: no English in a state value, a view or a key.

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
| The team page joined side rows without checking the session's current app (an app's sessions, before sessions became workspaces) | a view admits by the caller's answer on the thing it shows |
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
| A session lock of p3's own (sockets in a `locks/` directory, a wait for their close) beside Chord's `processLock`, which is that lock | Chord's `processLock`, named per session; check Chord before building a mechanism it may have |
| A test helper read `/proc/<pid>/task/<pid>/children`, which Android's kernel lacks | scan `/proc/*/stat` for the parent |
| A worker thread per code-mode script (p2): 10 to 28 MiB per worker | QuickJS inline, opened on first use |
| Braille glyphs for the working dots: Android's font draws one frame in the wrong column | draw the dots ourselves |
| Two starters after a crash both found the killed server's socket file stale, both removed it and both took the lock: a second look at the inode narrowed the window, never closed it | clear and take a socket under a kernel-owned guard (Chord's `processLock`); a release removes only its own file (same inode) |
| An apply that came while a worker's start still awaited its preparation (the lock directory) shipped nothing to it: the start had read the scripts, the apply saw no worker yet | a rollout reaches every worker of the runner, a start that has not forked yet included |
| Private file modes, the data directory's refusals and the session lock had no test: undoing them left the suite green | the mutation check for every rule (`testing.md`, rule 9), modes and locks included |
| A persisted state with a random `initial` (the cookie's key): an initial value is never stored, so every start made a new key and signed every browser out | an empty initial value, and a generated one written once; a restart test |
| The base's composed `LinkOpened` made each link's disposer inside the function that had the request: V8 keeps one context per scope, so every open link kept its request (headers, cookie) | a closure that outlives its call is made in a function of its own, given only what it needs; a GC test through the composed registry |
| A failed store (`storage_failed`) was only logged: the server answered `running` with a closed host | the server closes and exits non-zero; the supervisor starts it again |
| A second runner contributed to change how workers run (it sorted first, so the route used it): the first runner still ran a held worker, and the status, which named only the second's, hid it from `p3 stop` | one runner; a plugin contributes a wrap (`WorkerRunnerWraps`) over it, and a second runner is reported as a conflict |
| A built-in plugin's page part took a new component token through `/v1/web`: on a running server that is the page's base bundle, built at start, so after an apply the token was `undefined` and the page part threw | built-in plugins import each other's contract files by path; what comes through `/v1` is the base, which changes only with a restart (being changed, decision 139: an apply will rebuild the page base, and every facet will import through `/v1/*`) |
| The login kind's create hook took its maker from `ctx.principal`: the hook runs inside the things store's `create`, whose caller is the server code holding the store, so every login looked made by the server | the things plugin hands the hook its maker (`by`); never read a caller from a `ctx` that passed through another plugin's store |
| A test waited for a worker's state by reading Linux's `/proc/<pid>/stat` (stopped by `SIGSTOP`): on a POSIX system without `/proc` it never saw it | the process says it over IPC (a socket the test listens on) or writes a marker file; the test answers to let it go on |
| A workspace's removal read a table again (`tx.get`) after a `deleteWhere` on it in the same transaction: Chord refuses that | read everything a transaction needs first, then write; the deletes come last |
| A list's names were a `liveQuery` whose arguments derived from a followed source (the access index's rows): Chord refuses a reader whose arguments read a followed source | read what such a list shows inside the followed computation (the index's probe reads the names before each computation; a rename tells the probes) |
| A prefix read with no order (`under` a path): Chord orders by the key, so SQLite sorted every page | order by the indexed column the prefix runs on; a plan test |
| A harness part tested with a stand-in object that imitates a held reference: nothing showed that a withheld tick removes the member | `kindServer.giving` (`plugins/things/test/kind-server.ts`): the part from the built facet, real references held as the session's worker |
| A sleep, or an assertion on elapsed time, as the proof that something happened or did not (50 ms, then "nothing was called") | wait for the effect with `until(member, done, ctx)`; prove an absence by a counted metric, a mocked clock, or a later effect that could only come after it |
| A hand-made follow, join or lease inside a plugin (a registry value followed by hand, a changing set joined in a derive, a refresh lease in a row) | ask for the Chord primitive instead of building it: write it up for Mario (`process.md`); [ERNDL-1191](https://linear.app/earendil/issue/ERNDL-1191) (follow), [ERNDL-1194](https://linear.app/earendil/issue/ERNDL-1194) (a changing set) |
| English text in a state value (a fallback name, "Agent"), or a joined text key (`person:<id>`, `<thing>/<workspace>`) stored, compared or cut apart again | state holds data: `""` and a message in the view; a tagged union (`Caller`) compared by its fields; two columns instead of one joined key |
| A flag parameter that switches what a function or a tool does, the other arguments optional | two functions, or one tagged value whose variants carry the arguments they need (`notes_write`'s `change`) |
| One closure of a store's factory holding every table, queue and helper: hundreds of lines nobody can test or read alone | the factory wires; tables, named queries and writes are files or classes of their own, given only what they need |
| Tests named after review rounds ("round 3", "Astra's repro") | name the case after the rule it pins; the reviewer and round go in a comment beside it |
| A helper copied into the next plugin instead of shared (`useAction` and `failureText` word for word in two views; `person`, `holding`, `refused` in each kind's tests) | move it where both can import it in the change that needs the second copy: `plugins/things/test/kind-server.ts` for tests, `useErrorText` of `plugins/things/contract.web.tsx` for a failure's text |
| A plugin's or a kind's name written out as a string where it is compared (`by.plugin === "@earendil-works/p3-prompt"`, `"sessions.session"` written out in two other plugins beside its owner's `SESSION_KIND`) | import the owner's contract constant (`MACHINE_KIND`), or pass the data instead of asking who called (a `create.input`, a registry entry's `plugin`) |
| A table's definition changed in place (a column added to a version that was already on main): Chord refused to open the stores written by the build before, and a running Pi's update broke | never in place: `evolveTable` to a new version with a migration and its test, in the same commit; a contract whose members change bumps its `version` (decision 125) |
