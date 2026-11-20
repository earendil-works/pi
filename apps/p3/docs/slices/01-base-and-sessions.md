# Slice 1: base and sessions

**Goal.** A p3 server with a worker per session, headless: the owner creates, lists, renames, archives and restores
sessions; each session's worker runs and follows its own row from the server. The kit is p3's own base code. The test
tiers exist from here on, and so do the numbers.

State: **redo on Chord's slice 14** (owner, 2026-11-15), detailed and built 2026-11-15; reviews next. The first build
(committed `0db9861ec`, reviewed twice) is replaced: its facts document, its list of the newest 200 and its use of
Chord's app kit go. Not committed. The owner decided the redo's open points on 2026-11-15 ("Decisions"); review
round 1 (Opus, Sol, Astra, Fable) is fixed ("Review round 1", at the end). Slice 26 (the release build,
`26-release.md`) changed three things of this slice afterwards: the start script moved from `server.ts` to the command
`bin.ts`, `src/install.ts` names p3's own paths, and `bench/slice-1.ts` launches the server as a process (its newer
numbers are in slice 26's brief; the ones below are this slice's, measured in process). The walkthrough in `01-base-and-sessions/walkthrough/` is of the first build; a new one
follows the reviews (`workflow.md`, step 7).

## What the redo changes

1. **The kit is p3's.** The parts of Chord's app kit (`packages/chord/src/node/app/`) p3 needs now are copied into
   `apps/p3/src/kit/` and cut down to what this slice uses (decision "Slice 0 changes Chord first; the kit moves into
   p3"). Chord's kit stays untouched for p2. p3 keeps Chord's general components: `createHttp` (`chord/http`),
   `createWorkers` (`chord/workers`), `createPlugins` (`chord/plugins`).
2. **Two helpers in the kit:** `forward` (a view's members from a store's reference) and `contribute` (an object that
   only contributes). No stale-worker helper (decision "Stale workers are Chord's problem").
3. **The sessions plugin on named queries** (Chord slice 14): state and last touch are columns of the row; the store
   offers the queries `active`, `archived` and `one`; the owner's list is a `self.list` with `more`; a worker follows its
   row with `self.liveQuery`; the session route has an admission that reads the table.

## p2's features in this area

From p2's `plugins/sessions/` (contract, server, worker) and `apps/p2/docs/p3-functions/sessions-access.md` (domains 1
and 2 of the map):

| p2 feature | p3 |
| --- | --- |
| create a session (local or remote, directory check, create-dir, model and thinking defaults) | built: create with a title; location: slice 8; model defaults: slice 7 |
| the caller may choose the new session's id (a page navigates before the answer) | not built: the server makes the id (decision 3 of the first plan); revisit with the UI (slice 16) |
| a live list that never starts a worker: pinned first, then recent | built: a list per app, active or archived, newest touched first, paged with `more`, no cap; pins: slice 18 |
| browse archived sessions separately | built: the `archived` list; search: slice 20 |
| rename (1 to 120 characters, whitespace collapsed; an explicit title is never auto-replaced) | built: rename by the owner, at most 200 characters; automatic and agent-set titles (`renameSelf`), the edited flag: slice 18 |
| updated-at from message activity, never moving back | the column `lastTouch` is built, set at create; who touches it (runs): slice 3 |
| per session: running, error, busy (the status plugin) | the column `state` is built (`working`, `waiting`, `settled`, `failed`), `settled` at create; who writes transitions: slice 3; hot details: slice 20 |
| archive, restore | built as a mark; stopping the worker, the `SessionArchived` cleanup registry, ending people's access and forwards: slice 18 |
| worker start refused for an archived session (`ArchivedStarts` for an index rebuild) | slice 18 (with archive stopping the worker) |
| pin, relocate, clone, fork, the lifecycle operations (`running`, `failed`, dismiss), `SessionCopied`, delete, unread marks | slice 18 |
| model and thinking level on the row (`configureSelf`) | slice 7 |
| `/tree` branches and the main conversation on the row | slice 3 |
| session locks (`SessionLocks`, `SessionLock`) | slice 6 |
| sidebar settings (order, window, collapsed), the list grouped by machine and directory | slice 15 |
| the worker's view of its own row (`Sessions` worker variant, `SessionIndex`) | built: `SessionFacts`, one live read by id per worker |
| start a worker on demand, one per store | built (Chord's workers component) |
| a hold for a session that does not exist | built: refused by the route's admission, no worker starts (p2 refuses in `start`) |
| idle stop, a failed start kept until retried, crash reports, shutdown | Chord's workers component; checked by slice 18 |
| generation fence on worker reports | not needed: Chord's workers component guarantees it |
| owner sign-in: the one-time link, the device token file, signed cookies | built (the kit: `owner.ts`, `sign-ins.ts`); devices, pairing, people: slice 5 |

## Files

```text
apps/p3/
  server.ts                   startP3: the kit's startServer with the plugins root and the session worker's entry
  bin.ts                      the command (slice 26 moved the start script here from server.ts): ~/.pi/p3 on port
                              8789, prints the owner link, closes on a signal
  src/install.ts              where p3's files are, in a checkout or in the built package (slice 26)
  worker.ts                   a session worker: the kit's startWorker
  src/principals.ts           owner | person { id, name } | worker { session } | server
  src/principals.ts           (above) as a schema, `P3Principal`, and its type
  src/app.ts                  NAME, API, KINDS, PRINCIPALS
  src/session-route.ts        who reaches a session's worker: mayReachSession, sessionExists (the route's admission)
  src/api/v1/index.ts         Chord's root re-exported, defineFacet bound to the principal, Server, Session,
                              forward, contribute
  src/api/v1/server.ts        AppInfo, Http (Chord's registry of routes), SessionRoute (the contract the session
                              route's admission reads)
  src/api/v1/worker.ts        WorkerInfo
  src/kit/
    start-server.ts           startServer: its options, the order of a start, what it opens on disk
    app.ts                    the running app: what it reports, the owner link, the workers, close
    session-workers.ts        the session workers: their workers component, what the server sends a worker at its start
    worker.ts                 startWorker
    layout.ts                 the data directory's layout, private directories and stores, a worker's directory
    owner.ts                  the owner link and the owner token file
    sign-ins.ts               SignIns: issue, verify, revoke; the authenticator; the rolling cookie
    secrets.ts                tokens, hashes, secret files
    info.ts                   AppInfo, WorkerInfo and their facets
    forward.ts                forward
    contribute.ts             contribute
  plugins/sessions/
    contract.server.ts        SessionsStore: the store's contract with its named queries (server facets only)
    contract.ts               Title, CODING, Creator, SessionState, SessionRow; Sessions and SessionsList (the owner's,
                              server), SessionFacts (a worker's own session, server), SessionWorker (the owner's, on
                              the session's worker)
    server.ts                 the table `sessions.rows`, SessionsStore with its named queries, the views, SessionRoute
    worker.ts                 SessionWorker: forwards SessionFacts
    sessions.test.ts          plugin tier
  test/kit/*.test.ts          the kit's tests, ported (one file per kit file)
  test/kit/support.ts         a kit server on a temporary data directory and plugins root; requests to it
  test/topology.ts            the test topology
  test/until.ts, client.ts    waiting for a value; an owner client over WebSocket
  test/sessions.test.ts       topology tier
  test/plans.test.ts          the plans of the store's named queries, as SQLite runs them
  test/app.test.ts            end-to-end tier (its case is test/end-to-end.ts, shared with slice 26's launched and
                              release tests)
  bench/slice-1.ts            the numbers
```

Two Chord changes, each with its test, README line and CHANGELOG entry: `memberNames(contract, variant)` is exported
from `packages/chord/src/contracts/` (decision F), and the HTTP component's `links.opened(request, principal, close)`
gets a third argument that terminates that link (`src/node/http/`; review round 1: a revoked sign-in closes its
links). The first build's kit change (`appInfoFacet` and `workerInfoFacet` exported from `chord/app`) stays in Chord,
unused by p3.

## The kit

Copied from `packages/chord/src/node/app/`: `app.ts`, `worker.ts`, `layout.ts`, `owner.ts`, `sign-ins.ts`,
`secrets.ts`, `info.ts`: 1,726 lines there (about 2,600 with what they import of the kit), 926 in p3, plus 77 for the
two helpers.

**Kept:** the data directory by its real path with its lock (one server per directory), the private layout, the cookie
secret, the server's store, the server host, `createHttp` with the links endpoint `/chord`, `createPlugins` over p3's
required root, one `createWorkers` for sessions (the kit knows `Session`: no list of worker kinds), the core facets (`chord.http`, `p3.info`, `p3.sign-ins`,
`p3.owner`), the owner token file, the owner link, the worker base built right after the listen (a failure reported
`base_build`), close in order (HTTP, workers, host, store, plugins, lock). In a worker: its directory and store, its
host connected to the server first, its plugins loaded with `p3.worker-info`.

**Dropped** (a later slice adds back what it needs):

| Dropped | Comes back with |
| --- | --- |
| web and terminal surfaces, themes, translations, the locale choice | slice 16 |
| the telemetry store, ingest, `principalAttributes` | slice 20 (startup spans: slice 2) |
| users, invites, device pairing, ephemeral sign-ins (`kind: "ephemeral"`, the links hook, `limits`) | slice 5 |
| `exportData`, `importData`, `deleteData`, `HostData`, the archive and tar code | slice 18 |
| `Files` on every host, `files` caps | slice 12 |
| the user's plugins root, `plugins.install`, `applyChanges`, the `base` mark (the scan of the server's code, `base`, `basesBuilt`, `baseWatched`) | slice 2 |
| `timeouts`, a list of worker kinds (one kind, sessions), a worker's `env`, `facet`, `idleMs` and start data (`start`, `WorkerInfo.start`), a worker's `busy`, the `logs/` directory | when used (`busy`: slice 3) |
| the generic principal `P`, `checkOwner`, `AppInfo.owner` | see decision A |

**Added:**

- the session route's admission, given to `createWorkers` (`WorkersOptions.admit`,
  `packages/chord/src/node/workers/workers.ts`) with its `authorize`: both are `src/session-route.ts`'s;
- a sign-in that ends closes its open links, and only its own: the kit notes which sign-in authenticated each
  request, hears each link the HTTP component accepts for it (`links.opened`), keeps what closes it by the sign-in's
  id, and calls it when the sign-in is revoked or expires; a link whose sign-in ended before it was heard of is closed
  at once.
  `host.revoke` is not used: it ends objects by their principal, and the owner's objects are shared by all the owner's
  devices;
- `SignIns` is typed with p3's principal schema (`src/principals.ts`): `issue` refuses a value that is no principal.

**Renamed**, because the code is p3's now and a browser shares cookies between ports of one host: the contracts
`p3.info`, `p3.worker-info`, `p3.sign-ins` (and its document), the cookie `p3-sign-in`, the owner link's path
`/_p3/owner`.

`app.ts` is split by concept: `start-server.ts` (the options, the order of a start and what it opens on disk),
`session-workers.ts` (the session workers' component and what a worker is sent), `app.ts` (the running app). The API's server
module exports Chord's `Http` registry, which a plugin needs for a route (the kit's tests use one to see who a request
runs as).

### `forward` (`src/kit/forward.ts`, exported by `@earendil-works/p3/v1`)

40 of p2's 48 remote factories own nothing: they get a `local` store and declare every member a second time. `forward`
writes that once.

```ts
/** `variant` of `Remote`, its members taken from the same-named members of `store` (a reference), but those in `own`. */
forward(store, Remote, variant, own?)   // => { variant, members }

host.serve(Sessions, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const store = self.get(SessionsStore, {});
	return forward(store, Sessions, "owner", {
		create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),
	});
});
```

- A member is the reference's own, handed on as it is: a state member follows the store live, a method is called with
  the caller's `ctx`.
- The contract stays explicit: `Remote` lists the members of its audience, and the types require `store` to have every
  member `own` does not give, with a fitting type. A member neither has is a type error, and Chord's member check at
  activation fails the object `broken` naming it.
- `own` is for members that need the caller (`create` records its creator). It is the fourth argument the task's
  `forward(store, Remote, variant)` did not have (decision B).
- `forward` reads the names of the variant's members from the contract with Chord's `memberNames(Remote, variant)`
  (decision F): Chord refuses an implementation with a member too many, so the store's other members must stay out.

### `contribute` (`src/kit/contribute.ts`, exported by `@earendil-works/p3/v1`)

p2's helper (`apps/p2/src/runtime/contribute.ts`): `contribute(host, name, register)` serves a host-lifetime `local`
object named `name` with no members whose factory only calls `register(self)`, so contributions that need a reference
or a registry come and go with it. Not used by this slice's plugin; tested alone.

## Contracts and objects

Every API below is Chord's (`packages/chord/src/host/README.md`, "Named queries", "Lists", "Admission";
`plugin-authoring.md`), re-exported by `@earendil-works/p3/v1`.

```ts
// plugins/sessions/contract.ts
export const Creator = union([obj({ kind: lit("owner") }), obj({ kind: lit("person"), id: str() })]);
export const SessionState = oneOf("working", "waiting", "settled", "failed");
/** A session as lists and its worker see it. `archivedAt` is `null` while it is not archived. */
export const Title = str({ max: 200 });
export const CODING = "coding";                 // every session's app until apps exist (slice 5)
export const SessionRow = obj({ id: str(), title: Title, app: str(), creator: Creator, createdAt: num(),
	state: SessionState, lastTouch: num(), archivedAt: union([num(), nul()]) });

/** What the owner does with sessions. */
export const Sessions = remote("sessions.sessions", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { owner: { methods: { create: method(obj({ title: opt(Title) }), str()),
		rename: method(obj({ id: str(), title: Title })), archive: method(obj({ id: str() })),
		restore: method(obj({ id: str() })) } } } });
/** One screen's list of an app's sessions, active or archived: `view` is the screen's own id. */
export const SessionsList = remote("sessions.list", { version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() }, hostAddress: () => Server(),
	variants: { owner: { state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) }, methods: { more: method() } } } });
/** A session's row for its own worker, which holds it as itself; `null` for a session the server does not know. */
export const SessionFacts = remote("sessions.facts", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { state: { session: union([SessionRow, nul()]) } } } });
/** A session's worker as the owner sees it: the row it follows. */
export const SessionWorker = remote("sessions.worker", { version: 1, params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { session: union([SessionRow, nul()]) } } } });

// src/api/v1/server.ts: owned by the API, because the route (base code, never reloaded) reads it
export const SessionRoute = local("p3.session-route", { version: 1, params: { session: str() },
	members: { exists: bool() } });
```

One audience per contract: `Sessions` and `SessionsList` are the owner's, `SessionFacts` a worker's, `SessionWorker`
the owner's on a worker; each has one variant, named after its audience. A person's variants come with slice 5.

```ts
// plugins/sessions/server.ts
const Rows = defineTable("sessions.rows", { version: 1,
	columns: { id: host(Session), title: str(), app: str(), creator: json(Creator, { version: 1 }), createdAt: int(),
		state: str(), lastTouch: int(), archivedAt: int() },                   // 0: not archived
	key: ["id"], indexes: { active: ["app", "archivedAt", "lastTouch"], archived: ["app", "archivedAt"] } });

// plugins/sessions/contract.server.ts
export const SessionsStore = local("sessions.store", { version: 1, params: {}, members: {
	sessions: queries(SessionRow, { active: obj({ app: str() }), archived: obj({ app: str() }), one: obj({ id: str() }) }),
	create: method(obj({ title: str(), creator: Creator }), str()), rename: …, archive: …, restore: … } });

host.serve(SessionsStore, (_params, self) => {
	const rows = self.table(Rows);
	const sessions = self.queries(rows, { map: shown }, {
		// index active: app and archivedAt fixed, ordered by lastTouch, then the key
		active: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), eq(s.archivedAt, 0))).orderBy((s) => s.lastTouch, "desc"),
		// index archived: app fixed, a range of archivedAt in its order, then the key
		archived: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), gt(s.archivedAt, 0))).orderBy((s) => s.archivedAt, "desc"),
		// the key
		one: ({ id }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
	});
	return { sessions, create: …tx.put…, rename: …tx.update(rows, key, { title })…, archive: …{ archivedAt: now }…, restore: …{ archivedAt: 0 }… };
});
host.serve(Sessions, …forward(store, Sessions, "owner", { create }));                          // above
host.serve(SessionsList, ({ app, set }, principal, self) => {                                  // the owner's
	const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: 50 });
	return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
});
host.serve(SessionFacts, (_params, principal, self) => {                                       // a worker's
	const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: principal.session }, { first: 1 });
	return { variant: "worker", members: { session: self.derive([found], ([f]) => f.rows[0] ?? null) } };
});
host.serve(SessionRoute, ({ session }, self) => {                                              // local, per session
	const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: session }, { first: 1 });
	return { exists: self.derive([found], ([f]) => f.rows.length === 1) };
});

// plugins/sessions/worker.ts
host.serve(SessionWorker, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	return forward(self.get(SessionFacts, {}), SessionWorker, "owner");
});

// src/session-route.ts: the session route's admission (the kit gives it to `createWorkers`, the test topology to
// `host.route`)
export function sessionExists(_principal: P3Principal, address: Address<typeof Session>, self: AdmitSelf) {
	const route = self.get(SessionRoute, { session: address.params.id });
	return self.derive([route.exists], ([exists]) => (exists ? allow(null) : deny("no such session")));
}
```

## How it works

- **The row is the session.** One table row per session, keyed by its address (a `host(Session)` column, so a later
  export, import or delete of a session carries it). No facts document: nothing is written twice.
- **`archivedAt` is 0 while a session is not archived.** Key, index and order columns are non-`opt` `str` or `int`
  (`packages/chord/src/store/table.ts`), and both lists need `archivedAt` in the index: `active` fixes it at 0 and
  walks `lastTouch`, `archived` walks it. Each list has its own index, because Chord ends every order with the key
  and a list's whole order must be its index's: `active (app, archivedAt, lastTouch)` and `archived (app,
  archivedAt)`, each followed by the key. With one index for both, SQLite sorted every archived page (review round 1,
  Sol). `one` runs on the key. `test/plans.test.ts` reads each statement's plan from SQLite. Rows shown to others
  carry `null`.
- **Writes name what they change.** `create` is a `put`; rename, archive and restore are `tx.update` of the columns
  they change (after a `tx.get` that refuses an unknown id `invalid`). So a rename runs only the reads that show that
  session, and a read of another session skips without a probe (slice 14 §3.3).
- **The owner's list** is one `SessionsList` object per screen (`view`: a fresh id is a fresh list): the first 50 rows
  of its query, live; `more` adds a page; pages tile the order between bookmarks, so a row that moves leaves no gap and
  no duplicate, and nothing is capped. A session created while a list is open enters its first page, so an open list
  grows with what is created (up to four pages' rows before `more` is needed again). An archived session leaves the active list and enters the archived one in the
  commit that archives it. A reload of the sessions plugin opens the pages the list had and gives one frame.
- **A worker follows its row.** `SessionFacts` has no params: the session is the caller's principal, which the worker's
  link stamps (design §4, "upward is a boundary"). Reads are not shared between readers yet (Chord's `slices.md`,
  carry-over): a session with a running worker has two reads of its row, `SessionFacts`' and `SessionRoute`'s, and a
  write of that session runs both. A write of another session runs and probes neither.
- **No worker for a session that does not exist.** The route's `authorize` (`mayReachSession`: the owner and the server)
  runs first, synchronously. Then its admission asks `SessionRoute { session }.exists`, once per principal and address
  with holds: while it is false the holds show `failed { denied }` ("no such session") and nothing is resolved; a
  session created later is allowed in the commit that creates it. The admission applies to every principal, the
  server's included. Archived sessions are admitted (archive only marks: slice 18).
- **Who is refused.** A person: by `authorize` at the route and by the factories of `Sessions` and `SessionsList`
  (`forbidden`). A worker: by those factories; it cannot name another session to `SessionFacts`.
- **State and last touch** are set at create (`settled`, the creation time). Nothing changes them yet: the harness
  reports runs in slice 3, through a contract of the worker's audience.

**Could a third-party plugin provide this, or an alternative, the same way?** Yes: the plugin uses only the API. An
alternative sessions plugin serves the same contracts (`SessionRoute` is the API's; the others it imports). Other
plugins will read the store's named queries (groupings, people): `SessionsStore` is in the plugin's
`contract.server.ts` for them (the bench reads its pages through it).

## Tests

Three tiers plus the kit's own tests, all `node:test`, in the default run: 65 tests, `npm test` about 3 s (the kit's
tests start real servers; one waits a second for a held lock). Mutation check (`chord-practices.md`): 48 rules undone
one at a time in a copy under `/tmp`: the owner, worker and route checks; each query's condition (its app among
them), order and index; `update` against `put`; the page size; `forward`'s members and its types (checked by `tsc`);
the kit giving the route its `authorize` and admission, and each worker its own directory; a revoke closing its
sign-in's links and only those, and a link of an ended sign-in closed when it registers; the
principal schema of `issue`; the owner link's single use and its address; a sign-in's revoke and expiry; the default
data directory. A test, or the type check, fails for each.

**Kit** (`test/kit/`, ported from `packages/chord/test/node/app/`; the cases of dropped parts are not ported; test
plugins are written into a temporary root and import p3's API as any plugin):

- `secrets.test.ts`: distinct base64url tokens of the asked size that match only their own hash; a secret file is
  created with mode 0600, never overwritten on create, replaced whole, no temporary file left; a secret file keeps its
  first value; mode 0600 under a permissive umask.
- `layout.test.ts`: the layout's directories with mode 0700; an address key as one directory name under its kind; keys
  differing only in case stay apart; a long key is named by its hash.
- `info.test.ts`: `AppInfo` on the server (data directory, name, newest API version); `WorkerInfo` on a worker (its
  address).
- `sign-ins.test.ts`: a sign-in's token authenticates as a bearer and as the cookie, is listed without its hash, is
  revoked; a wrong secret, an unknown id and a forged cookie are refused; only the token's hash is in the store; the
  cookie is renewed once older than a day, with a fresh signed expiry; a revoked sign-in's is not; a sign-in unused for
  400 days ends at its next use; a malformed token or a prototype key as id is a plain 401, nothing reported; `issue`
  refuses a value that is no principal (new); a revoked sign-in's open links are closed at once and what it calls
  then creates nothing, while the owner's other device keeps its link, its `Sessions` and its list (new, review
  round 1: with the real sessions plugin, two owner devices over WebSocket, one with its token and one with its
  cookie); a link whose sign-in was revoked, or outlived its 400 days, between its authentication and its
  registration is closed at once, with a bearer token and with a cookie, the other device untouched (new, review
  round 2, Sol's and Astra's reproductions: the test wraps the kit's authenticator to force that order); the kit
  keeps no request it authenticated (a GC test of the note of each request's sign-in).
- `owner.test.ts`: the owner link's page reads the fragment, signs the owner in once and refuses the token a second
  time; an expired, a wrong and the previous start's token are refused; each start gives a new link; the owner token
  file is written with mode 0600, signs in as the owner and is kept across starts; it is replaced when its secret no
  longer matches and once its sign-in was revoked.
- `start-server.test.ts`: lays out the data directory, serves `AppInfo` and the root's plugins, closes everything (a
  second close is the same close); refuses a second server on the same data directory, also through a symbolic link;
  makes the data directory private at every start; refuses the home directory, a file system's root and another
  user's directory, also through a link; names the address listened on in the owner link (an IPv6 address in
  brackets, loopback for a wildcard); rejects when a plugin of the root fails, with everything closed.
- `session-workers.test.ts`: a worker per session with its own directory and store (two sessions, two directories),
  kept across its process's restarts, its `WorkerInfo` naming it; a worker that fails its start fails the test at
  once, not after a minute; the route's admission is asked before a worker starts (new: a session
  `SessionRoute` does not know starts no worker and gets no directory) and its `authorize` before that (a person
  reaches no worker); a worker base that does not build is reported `base_build` and workers fail their start, the
  server running on.
- `forward.test.ts` (new): a view has the store's state members and methods and not the store's other members; a
  method without arguments; a forwarded state member follows the store; `own` members are the view's; what the types
  refuse, as `@ts-expect-error` lines `npm run check` verifies: a member neither the store nor `own` gives, a store
  member or an own member of another type, and without `own` (the worker's call shape) a missing or wrongly typed
  member.
- `contribute.test.ts` (new): a contribution that follows another object's state is in its registry.

Not ported, with their parts: an owner the app chooses, ephemeral sign-ins, two worker kinds side by side, a server
without worker kinds as a type error (the kit has one kind), `applyChanges`, the base marks, installs, export and import, files, pairing,
invites, users.

**Plugin tier** (`plugins/sessions/sessions.test.ts`, `testPlugin` on the server facet, built as production builds it):

1. The owner creates, renames, archives and restores; the active list shows each step (`state: "settled"`,
   `lastTouch` the creation time, `app: "coding"`, the owner as creator, `archivedAt: null`).
2. An archived session leaves the active list and is in the archived one, the last archived first; restored, it is
   back.
3. A person and a worker get `forbidden` on `Sessions` and on `SessionsList`; the owner and a person on
   `SessionFacts`.
3a. Another app's lists are empty, `moreAfter` false (review round 1).
4. `SessionFacts` gives a worker its own session's row and an unknown session `null`.
5. `SessionRoute` says whether a session exists.

**Topology tier** (`test/sessions.test.ts`), each test its own topology; the first build's nine cases (8 changed), then
the new:

1. The owner creates a session; the list shows it; `SessionWorker { session }` goes live on that session's worker (one
   worker made) and shows the list's row.
2. A rename on the server reaches the worker's row.
3. Two sessions: two workers, each sees only its own row.
4. A person's hold of `SessionWorker` is refused by the route (`forbidden`, no worker); a person's `Sessions` and
   `SessionsList` are refused.
5. A worker cannot read another session's row (`SessionFacts` is keyed by its principal); the server, which the route
   lets through, is refused `SessionWorker` by its factory.
6. Archive and restore reach both lists and the worker's row.
7. Server restart on the same store: the list is back; a new `SessionWorker` hold starts a new worker that sees its row.
8. **No cap** (was: the newest 200): of 201 sessions a list shows the first 50 with `moreAfter`, and `more` until
   `moreAfter` is false gives all 201 once, the last touched first.
9. Renaming a session that does not exist is refused (`invalid`), writing nothing.
10. **`more`** keeps the loaded rows (the same objects in the client's replica: only the new page crossed the link) and
    adds one page; a session created afterwards appears at the top, the loaded rows kept.
11. **The worker's facts by id:** with two workers following, a rename of one session runs three reads (the list's
    page, that session's two) and asks no probe (`chord.query.runs`, `chord.query.probes` through the in-memory
    telemetry adapter): the other session's reads are not run.
12. **An unknown id starts no worker:** the owner's hold of `SessionWorker` for an id never created shows
    `failed { denied }` and `get` rejects `forbidden`; a session that exists is reached beside it, and one worker was
    made.
13. **A reload under an open list:** with three pages loaded (120 rows) and a worker following, the sessions plugin is
    reloaded (`host.reload` with a new facet of the same code): no frame shows fewer rows than were loaded, a session
    created after the reload appears at the top of the same rows, and a rename after it reaches the list and the
    worker.

14. **A row moving between loaded pages** (review round 1, Astra's reproduction): of 51 archived sessions in two
    loaded pages the last is archived again and is first in the next frame; the list and the owner's link stay live
    (Chord sent the list's member twice in one state message; fixed in Chord).
15. **A reload of the worker's facet:** the owner holds `SessionWorker`, the sessions plugin is reloaded on that
    worker, and a rename after it still arrives; no second worker.

**Plans** (`test/plans.test.ts`): the store on a SQLite database of the test's own; the test records the statements
Chord runs over the sessions table while `active` and `archived` read their first page and the page after a bookmark
and `one` reads, and asks SQLite's `EXPLAIN QUERY PLAN` for each: every step is a search of the query's own index
(`active`, `archived`, the key), none sorts.

Every topology test checks that nothing failed in the background but the refusals it asked for. Not testable in p3: a
hold made before its session's create being admitted by the create (the server makes ids); Chord's tests cover a
denial followed by an allow.

**End-to-end tier** (`test/app.test.ts`, the case in `test/end-to-end.ts`): `startP3` on a temporary data directory, a client over WebSocket with the
owner token file's bearer token; it creates a session, holds `SessionWorker` (a forked worker answers with its row),
asks for one of an unknown id (`forbidden`, and the workers' state has only the first), closes and starts again on the
same directory: the session is listed.

## Numbers

`bench/slice-1.ts` (about 12 s), on slayer (Linux x64, Node 24.4.1), 2026-11-15, three runs each.

**Start and memory**, beside the first build measured the same day on the same Chord:

| | First build (Chord's kit) | Redo (p3's kit) |
| --- | --- | --- |
| server listening after `startP3` began | 47 to 49 ms | 41 to 53 ms (42 typical) |
| server process `RssAnon` (server and the bench's client) | 115 to 118 MiB | 105 to 110 MiB |
| worker start, cold (with the worker base's build) | 268 to 336 ms | 198 to 219 ms |
| worker start, warm (median of 10) | 102 to 104 ms | 91 to 92 ms |
| an idle worker's `RssAnon` (median of 10) | 37.4 to 37.9 MiB | 34.4 to 34.5 MiB |

The kit's dropped parts are not loaded any more (files, surfaces, translations, telemetry ingest, archives). The first
build's own numbers (2026-11-14, an older Chord): 45 ms, 111.3 MiB, 292 ms, 99 ms, 29.5 MiB; the idle worker's memory
rose with Chord since, not with p3. The phone and p2's numbers follow once the code is on main.

**What a worker really needs.** USS is `Private_Clean + Private_Dirty` of `/proc/<pid>/smaps_rollup`: the memory no
other process shares, so what one more worker costs. PSS adds each shared page divided by the processes sharing it.

| | Redo |
| --- | --- |
| an idle worker's USS (median of 10) | 35.1 MiB |
| ten idle workers at once (eleven run), USS in all | 343 to 351 MiB (35 each) |
| ten idle workers at once, PSS in all | 383 to 391 MiB (38 to 39 each) |

The cost per worker holds: ten cost ten times one. USS is a little above `RssAnon` (private pages of files a worker
alone has mapped); PSS adds about 4 MiB a worker for its share of what it shares with the server and the other
workers (Node's binary and libraries). So 100 idle session workers need about 3.5 GiB.

**The owner's list**: one screen opening `SessionsList` (50 rows) and one `more` (50 rows), medians of 30, a fresh
list object each run.

| | 1,000 sessions | 10,000 | 100,000 |
| --- | --- | --- | --- |
| over the WebSocket: open | 1.0 to 1.3 ms | 0.74 ms | 0.71 to 0.73 ms |
| over the WebSocket: `more` | 0.75 ms | 0.51 ms | 0.48 ms |
| over the WebSocket: holding a trivial object, a trivial call | 0.21, 0.12 ms | 0.17, 0.09 ms | 0.16, 0.09 ms |
| on the server's host, no link: open, `more` | 0.43, 0.25 ms | 0.40, 0.23 ms | 0.40, 0.23 ms |
| on the server's host: holding a trivial object, a trivial call | 0.04, 0.01 ms | 0.04, 0.01 ms | 0.03, 0.01 ms |
| the store's page of 51 rows alone: the first, the one after its bookmark | 0.16, 0.19 ms | 0.14, 0.16 ms | 0.15, 0.17 ms |

- **The number of sessions does not matter:** both reads run on their index. The 1,000 column is slower only
  because it runs first, while the code is still being compiled.
- **The 2.3 ms and 2.6 ms measured before were the first open and `more` after the start** (one run, cold code:
  2.4 to 3.5 ms and 2.8 ms now). Warm, an open takes 0.7 ms and a `more` 0.5 ms.
- **Where one open's 0.72 ms goes** (100,000 sessions, by subtraction): about 0.12 ms is the round trip alone (a
  trivial object held over the link takes 0.16 ms, 0.04 ms of it its activation); 0.40 ms is the server's work
  without a link: the page's read 0.15 ms (SQLite, row decoding, mapping 51 rows), activating an object 0.04 ms, and
  about 0.2 ms for the list's object (its reference to the store, its page registered with the store's reads and its
  keys kept for the skip test, the route and factory checks); the remaining 0.2 ms is encoding 50 rows on the server
  and decoding them into the client's replica.
- **Where one `more`'s 0.48 ms goes:** the round trip of a trivial call 0.09 ms; the page after the bookmark 0.17 ms;
  adopting it into the list 0.06 ms; encoding and decoding the 50 new rows 0.16 ms.
- **The boundary search** is the index seek to the bookmark: the page after a bookmark takes 0.02 ms more than the
  first page, at every size.
- **By CPU time** (a profile of 200 opens and `more`s over the WebSocket at 100,000 sessions; server and client share
  the process; 1.25 to 1.32 ms for an open and a `more` together): the link (encoding, decoding, Delta, replicas) 0.35
  to 0.40 ms; SQLite's statements 0.21 ms; the store around them (reads, row decoding) 0.20 ms; the WebSocket and
  socket I/O 0.21 ms; objects (activation, references, admission) 0.12 ms; the list's pages and bookmarks 0.06 ms;
  the plugin's mapping 0.03 ms; garbage collection 0.05 ms.
- **Is it reasonable?** Yes. The bare round trip on this link is 0.1 to 0.2 ms; an open is four to five times that
  for reading, encoding and decoding 50 rows of eight columns, and a third of it is the two ends of the link. Nothing
  dominates: reading (SQLite and the store, 0.4 ms of CPU for both pages) and the link (0.4 ms) are about equal, and
  socket I/O is half of either. No budget is missed and nothing here asks for work.

## Read first, in full

`names.md`, `decisions.md` (all; the entries of 2026-11-14 and 2026-11-15 above all), `workflow.md`;
`packages/chord/docs/slice-14.md`, `design.md` (all) and `plugin-authoring.md`; `packages/chord/src/host/README.md`,
`src/store/README.md`, `src/node/workers/README.md`, `src/node/plugins/README.md`, `src/node/app/README.md`; the kit
`packages/chord/src/node/app/*.ts` and its tests `packages/chord/test/node/app/` (`support.ts`, `app`, `owner`,
`sign-ins`, `secrets`, `layout`, `info`, `worker`); examples `69-admission.ts`, `70-named-queries.ts`, `71-lists.ts`,
`72-exists-and-joins.ts`, `76-worker-reports/`; `apps/p2/src/runtime/contribute.ts`; p2's `plugins/sessions/contract.ts`
and `apps/p2/docs/p3-functions/sessions-access.md` (Sessions); the root `AGENTS.md`, "Chord v2 Code Style". Private, on
slayer: `/home/badlogic/chord-notes/research/chord-critique-fable.md` (points 3 and 4: store and view pairs, one
audience per contract).

## Decisions

**Decided by the owner, 2026-11-15** (`decisions.md`, "Slice 1's redo"):

- **A. The kit is typed to p3:** no principal parameter `P` anywhere; the kit imports `NAME`, `API`, `KINDS` and
  `PRINCIPALS` from `src/app.ts`; `startServer` takes only what `server.ts` decides (`dataDir`, `root`, `listen`,
  `workers`, `onError`); `checkOwner`, `AppInfo.owner` and the tests of "an owner the app chooses" go (p3's owner is
  `{ kind: "owner" }`); what a worker is sent at its start is its directory only.
- **B. `forward` takes a fourth argument `own`**, the members a view implements itself (`Sessions.create` needs its
  caller).
- **C. State and last touch have no writer in this slice:** the columns, the index and the order are built and set at
  create; the harness reports transitions in slice 3. So "a row moves to the top" is tested here only by creates.
- **D. Names are p3's:** `p3.info`, `p3.worker-info`, `p3.sign-ins`, the cookie `p3-sign-in`, `/_p3/owner`.
- **E. The default data directory is `~/.pi/p3`** (not `~/.p3`). What the first build left in `~/.p3` does not matter.
- **F. `forward` learns a contract's members from Chord:** Chord exports `memberNames(contract, variant)`, the current
  version's `{ state, methods, events }` name lists. No wrapper of `remote` in p3's API.

Carried from the first plan (accepted 2026-11-14): port 8789; the server makes session ids; a new
session's title is empty (each view shows its own "New session"); API v1 re-exports all of Chord's root; not in this
slice: the always-`unmanaged` gate (slice 17), compression on kit hosts and startup spans (slice 2), session delete,
export, import, fork (slice 18).

## Carried (not in this slice)

Who writes `state` and `lastTouch` (slice 3); plan tests of the three named queries (the guide asks one per named
query; Chord gives an app no way to read a statement's plan, so the bench measures the list instead: with the next
Chord change); one read per session instead of two once Chord shares reads between readers; archive stopping the worker
and refusing its start (slice 18); `linger`
on `SessionsList` for a reconnect within it (slice 16, with the page); the session service's further shape (`create`
idempotent by a key, `open: false`, fork, remove: `archive/base-inventory/explainer/book.md` 194-256); a lifecycle
registry so delete reaches every plugin's data (`archive/model-stress/report.md` 887-901); Chord's "p3 domain points";
acceptance tests of `archive/base-inventory/merged.md` §5 (restore, export, import).

## Review round 1 (2026-11-15: Opus, Sol, Astra, Fable)

Reports: `/tmp/p3-s1-v2-r1-{opus,sol,astra,fable}.md` on slayer. Fixed:

| Finding | Fix |
| --- | --- |
| a row moving between two loaded pages closed the owner's link (Astra; Chord) | fixed in Chord (`36c709e72`, `f6600b58f`); topology case 14 |
| `forward` without `own` checked nothing (Fable, Astra, Sol) | the names of `own`'s members are a type parameter that defaults to none; `@ts-expect-error` cases |
| a revoked sign-in kept its open links (Astra) | the kit closes them, and only them (Chord: `links.opened`'s `close`); the two-device test |
| the archived list sorted every page (Sol) | an index per list; `test/plans.test.ts` |
| the lists' app filter was untested (Opus) | plugin case 3a |
| the kit took a list of worker kinds (Fable, Opus) | one kind, `Session`: `session-workers.ts`, `App.workers` one typed component |
| `src/app.ts` held the route's policy (Fable) | `src/session-route.ts` |
| `SignIns` treated the principal as unknown (Fable) | a principal schema in `src/principals.ts`; the three casts are gone |
| the worker's facet was never reloaded in a test | topology case 15 |
| nits | `Title` and `CODING` once in `contract.ts`; the owner link's wildcard and IPv6 hosts tested; `authenticate` outside the factory; `App`'s link `undefined` until the start; the topology file's order; this brief's stale lines |

Left as they are: `contribute` has no user in this slice (its first comes with slice 2 or later); `startServer` is one
sequence of 50 lines.

## Review round 2 (2026-11-15)

Opus and Fable: ready. Sol and Astra: one should-fix, fixed.

| Finding | Fix |
| --- | --- |
| a sign-in revoked after the authenticator's answer and before the kit heard of the link kept that link (Sol, Astra) | `SignInLinks.opened` asks whether the sign-in is live (it exists and has not expired) in the same synchronous step that registers the link, and closes the link at once when it is not; the race test, for a revoke and for an expiry |
| in that race a cookie that expired meanwhile named no sign-in, so the link was neither checked nor registered (Astra's final re-check) | the kit notes the sign-in when it authenticates a request (by the request, weakly) and `opened` uses that, never reading the request's token again; the race test runs with a bearer token and with a cookie |
| `KitSignIns.opened` ignores its `principal` (Fable) | its comment says the signature is Chord's |
| workers sharing one directory were caught only by a 60 s timeout (Opus) | the kit's worker test fails at once when a worker fails its start, and checks two sessions have two directories; the end-to-end client waits 5 s at most |
