---
title: p3 slice 1: base and sessions
cover: Slice 1 / Sessions
kicker: A walkthrough · p3 slice 1 · 2026-11-14
subtitle: The base code a restart changes, one plugin that owns sessions, a worker per session that follows its facts, and the tests that run all of it in one process
stats:
  - 9 | source files of p3 (base and plugin), plus tests
  - 15 | tests in about 1 s
  - 99 ms | a session worker's warm start on slayer
  - 29.5 MiB | an idle worker's anonymous memory
note: |
  A walkthrough of the code of slice 1 for the owner's review, in the order to read it. The brief is
  `apps/p3/docs/slices/01-base-and-sessions.md`; the reviews (Sol, Astra, Fable, two rounds) are in `/tmp/p3-s1-r*.md`
  on slayer. Every name here is in the code; nothing is proposed.
colophon: p3 slice 1 walkthrough · 2026-11-14 · apps/p3 and packages/chord/src/node/app
---

# Before we begin {.preface}

Mario opens p3 on his phone and taps "new session". Somewhere a row appears in a list, and somewhere a process starts
that will one day run an agent for that session. Before any agent, transcript or UI exists, three things must already
be right: who is who (the owner, a person, a session's worker, the server), where a session's data lives (and which
process owns it), and how a session's worker learns about its own session without the server pushing it there.

Slice 1 builds exactly that and nothing else: the base code (what a restart changes), one plugin, `sessions`, and the
test setup every later slice runs on. There is no page yet; a client over WebSocket stands in for it.

## Seven things to know

:::findings
1. **The base is small.** A principal type, the API module plugins import, what p3 tells the kit, and two entries:
   `server.ts` and `worker.ts`. Everything else is a plugin.
2. **One plugin owns sessions.** `sessions` keeps every session as one table row and one facts document, written in
   one transaction by one local object, `SessionsStore`.
3. **Views decide who gets what.** The owner gets `Sessions` (list, create, rename, archive, restore); a session's
   worker gets `SessionFacts` (its own session, by its principal). Everyone else is refused in the factory.
4. **A worker follows, the server owns.** The worker holds `SessionFacts` as itself; a rename on the server reaches it
   live. Nothing about a session is written by its worker.
5. **Facts carry no id.** The session's address is the key; a copy under another address rewrites keys, not JSON.
6. **The tests run the real thing in one process.** Server and workers are Chord hosts linked in memory, with real
   SQLite stores; a test takes milliseconds.
7. **One kit change:** `appInfoFacet` and `workerInfoFacet` are exported, so the tests load the same start-data
   objects as production.
:::

## Words used throughout

The **owner** is the person who owns the Pi; a **person** is anyone else (none is let in yet). A **principal** is who
calls, stamped by the link a call arrives on. A **session** is one agent workspace with its own **worker** process and
store; its **address** is `Session({ id })`. A session's **facts** are what is known of it besides its id. A **view**
is a remote object that serves one kind of principal what it may see. The **test topology** is the tests' setup: the
server and workers as hosts in one process.

# Who Is Who {#principals lede="Four kinds of principal, identity only, and who may reach a session's worker."}

Everything starts with `src/principals.ts`. A principal names who someone is, never what they may do: decision "The
principal is identity only".

```ts
export type P3Principal =
	| { readonly kind: "owner" }
	| { readonly kind: "person"; readonly id: string; readonly name: string }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "server" };
```

`src/app.ts` is what p3 tells the kit about itself, shared by the server, the worker entry and the tests: the API
module and its versions, the facet kinds (`server`, `worker`), the principals the kit stamps, and the one access rule
this slice has.

```ts
export const PRINCIPALS = {
	server: { kind: "server" },
	worker: (address) => ({ kind: "worker", session: String(address.params.id) }),
	owner: { kind: "owner" },
};

/** Who may reach a session's worker: the owner and the server (persons come with admission, slice 5). */
export function mayReachSession(principal: P3Principal): boolean {
	return principal.kind === "owner" || principal.kind === "server";
}
```

`mayReachSession` is the route's `authorize`: it runs for every hold that goes to a session's worker, synchronously,
before the worker starts. A person is refused there, so no worker starts for one.

# What Plugins Import {#api lede="The API module: Chord's surface once, the principal bound in, two host kinds."}

Plugins never import Chord. They import `@p3/app/v1`, whose instance each process passes in when it evaluates a
plugin, so a plugin's build never copies Chord. `src/api/v1/index.ts` is three things:

- `export * from "@earendil-works/chord"`: Chord's whole root, so a plugin that needs one more of Chord's exports never
  forces an API change. Whether to keep this or list names is open (decision 2 below).
- `defineFacet`, bound to `P3Principal`, so every factory's `principal` is typed.
- The host kinds `Server` and `Session`. `Server` is defined here as well as in the kit, because this module also
  goes to pages later, which cannot import the Node kit; two `hostKind("server")` make equal addresses.

`server.ts` and `worker.ts` of the API add the kit's start data per kind: `AppInfo` on the server, `WorkerInfo` on a
worker.

# Starting {#starting lede="server.ts gives the kit p3's decisions; worker.ts is one call."}

`server.ts` exports `startP3(context, { dataDir?, root?, port? })`. It passes the kit p3's name (so `~/.p3` by
default), the API and kinds, `PRINCIPALS`, and one worker kind:

```ts
workers: [{
	kind: Session,
	entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
	execArgv: ["--conditions=source", "--disable-warning=ExperimentalWarning"],
	start: () => ({}),
	authorize: mayReachSession,
}],
```

The kit does the rest: the data directory and its lock, the server's store, HTTP with deny by default, the owner's
sign-in (a one-time link, the owner token file), building the plugins, and a workers component that forks one process
per session address on its first hold and stops it when idle. Run as a script, `server.ts` serves `~/.p3` on port
8789 (p2 keeps 8788) and prints the owner link. `worker.ts` is a single `startWorker` call with the same API and kinds.

:::flow animate | The path of one hold: a client asks for a session's worker object; the server's route authorizes it and the kit forks the worker; the worker loads its plugins and asks the server for its facts.
row "client" muted
box c "owner client" "`get(SessionWorker, { session })`" blue
row "server" accent
box r "route `session`" "`mayReachSession`"
box w "workers component" "fork, IPC link"
box s "SessionsStore" "table + facts"
row "worker" accent
box o "SessionWorker" "serves the owner"
box f "SessionFacts hold" "as the worker"
arrow c -> r "hold"
arrow r -> w "authorized"
arrow w -> o "fork, load"
arrow o -> f "self.get"
arrow f -> s "facts.at(Session)"
:::

# One Plugin Owns Sessions {#store lede="A table row and a facts document per session, written together."}

`plugins/sessions/server.ts` is the heart of the slice. Its local object `SessionsStore` (empty params, so one per
server, living as long as the server) owns two kinds of data:

- **The table `sessions.rows`**, one row per session: `id` (a host column, `Session`), `title`, `app` (always
  `coding` for now), `creator` (a JSON column: the owner or a person), `createdAt`, `archivedAt` (absent while not
  archived). An index on `createdAt` serves the list.
- **The facts `sessions.facts-of`**, one document per session keyed by its address (`keyed: Session`): the session's
  info, or `{ session: null }` for an address the server does not know.

Why both? The owner's list is a query, and lists are tables (decision "Tables are first-class"). A worker, and later
an admission, needs one session's facts as a pinned value (`facts.at(Session({ id }))`), which only a keyed member
gives. Both belong to the session's host, so the kit's export, import and delete of a session carry them. They never
disagree, because every change writes both in one transaction:

```ts
const update = (id: string, change: (row: Row) => Row, ctx: Ctx) =>
	self.tx(async (tx) => {
		const old = await tx.get(rows, { id: Session({ id }) });
		if (old === undefined) throw invalid("args", `sessions: no session ${id}`);
		const row = change(old);
		tx.put(rows, row);
		await writeFacts(tx, facts, row);
	}, ctx);
```

`create` makes the id on the server (`crypto.randomUUID()`), so no client picks one. A new session's title is empty:
each view will show "New session" in its viewer's language (decision 1 below). Rename, archive and restore are each
one `update`. The list is a live query, the newest 200 by `createdAt` (ties broken by the key), re-run by Chord in the
commit of every write to the table and mapped with `mapShared`, so an unchanged row stays the same object and a commit
sends only what changed.

## Facts without an id

A session's facts hold `SessionInfo` (title, app, creator, times) and no id; a list row is the id plus that info. All
three reviewers found the first version wrong: the facts repeated the id inside the JSON, and the kit's import as a
copy (and later fork) rewrites host keys and host columns, never JSON, so a copy's facts would have named the old id.

# Views Decide Who Gets What {#views lede="Sessions for the owner, SessionFacts for a worker, refusals in the factory."}

The store is local: no client can reach it. Two remote objects on the server are its views, each a few lines:

```ts
host.serve(Sessions, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const store = self.get(SessionsStore, {});
	return { variant: "owner", members: { list: store.list, create: …, rename: …, archive: …, restore: … } };
});

host.serve(SessionFacts, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
	const store = self.get(SessionsStore, {});
	return { variant: "worker", members: { facts: store.facts.at(Session({ id: principal.session })) } };
});
```

`SessionFacts` has no params: the session is the caller's principal, which the worker's link stamps. A worker cannot
ask for another session's facts, because there is nothing to ask with. This is the shared-store pattern of Chord's
design §6: data once, per-principal views.

# A Worker Follows {#worker lede="SessionWorker on the worker: what it shows comes from the server, live."}

`plugins/sessions/worker.ts` serves `SessionWorker { session }` on the session's worker, for the owner. It is this
slice's proof that a worker runs per session and follows its facts:

```ts
host.serve(SessionWorker, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const facts = self.get(SessionFacts, {});
	return { variant: "owner", members: { facts: facts.facts } };
});
```

The object serves the owner, yet its `self.get(SessionFacts, {})` reaches the server as the worker: a worker's hold
of a server type goes up its parent link, and the server stamps that link's principal (design §4, "upward is a
boundary"). The member `facts` is the server's document re-exposed, so a rename commits on the server, travels to the
worker as one state message, and on to the owner.

:::sequence animate | A rename: the owner's call commits on the server; the worker's replica of the facts updates; the owner's SessionWorker shows it.
actor owner "owner client" "Sessions, SessionWorker" blue
actor server "server" "SessionsStore" accent
actor worker "worker" "SessionWorker"
owner -> server: Sessions.rename({ id, title })
server => server: tx: put row, draft facts
server --> worker: state: facts (one op)
worker --> owner: state: facts (relayed through the server)
server --> owner: result
:::

# The Test Topology {#topology lede="Server and workers as hosts in one process: production's objects, test speed."}

`test/topology.ts` builds what the kit builds, minus processes and HTTP: a server host at `Server()` with a SQLite
store (in memory, or a file when a test restarts), a route for `Session` that makes a worker host per address on its
first hold and links it in memory (connected first, then loaded, as the kit's worker does), and clients connected as
any principal. Plugins are imported as modules, so nothing is built with esbuild in this tier. The kit's start-data
facets are exported now (two lines in `packages/chord/src/node/app/index.ts`), so the topology serves the same
`AppInfo` and `WorkerInfo` as production.

Two guards came from the reviews. A server plugin whose setup fails fails the topology's start and closes what it
opened (as the kit's required root fails a start); a worker's load failure is recorded. And every host waits at most
5 s for an object, so a mistake fails a test in seconds, not after a minute.

# The Tests {#tests lede="Three tiers, fifteen tests, about one second."}

- **Plugin tier** (`plugins/sessions/sessions.test.ts`): the server facet built as production builds it
  (`testPlugin`) and loaded alone: the owner's operations, refusals of persons and workers, a worker's own facts.
- **Topology tier** (`test/sessions.test.ts`), each test its own topology: a created session's worker follows its
  facts; a rename reaches the worker; two sessions, two workers; archive and restore change row and facts together;
  an unknown session's rename is refused; the list keeps the newest 200; persons are refused (no worker starts); a
  worker sees only its own facts; a restart on the same store keeps everything. After every test, nothing may have
  failed in the background but the refusals the test asked for.
- **End-to-end tier** (`test/app.test.ts`): the real `startP3` on a temporary directory, a client over WebSocket
  with the owner token file's bearer token, a forked worker answering, then a restart on the same directory.

`test/until.ts` waits for a value a change elsewhere caused; after a call on the same reference no wait is needed,
because a call's answer follows its state (design §3).

# The Numbers {#numbers lede="Measured on slayer; the phone follows once the code is on main."}

:::stats
45 ms | server listening after `startP3` began
292 ms | first worker (with the worker base's build)
99 ms | a worker's warm start, median of 10
29.5 MiB | an idle worker's `RssAnon`
:::

`bench/slice-1.ts` measures them with the real server and a WebSocket client. `RssAnon` is anonymous resident memory,
what Node does not share between processes. Module loading before `startP3` is not in the first number. The phone's
numbers, and a p2 worker's on the phone (where starts take seconds), follow once the code is on main.

# Open Questions {.epilogue lede="Four decisions from the reviews, and what is carried."}

1. **A new session's title:** empty, each view renders "New session" in its viewer's language (recommended,
   implemented), or English text stored.
2. **API v1 re-exports all of Chord's root:** keep and record that v1 follows Chord's root (recommended), or an
   explicit list.
3. **"app" for p3 itself** (`@p3/app`, `src/app.ts`, the kit's word) against `names.md`'s app: a line in `names.md`
   (recommended), or renaming to `@p3/api`.
4. **Archive only marks the session;** stopping its worker needs a way for plugins to stop a worker: carry it to the
   lifecycle slice with delete (recommended by Astra and Sol).

Carried: a hold for a session id never created still starts a worker (admission or the session service's `open`
decides it later); the list has no paging past the newest 200.

# Files {.appendix}

| File | What |
| --- | --- |
| `apps/p3/src/principals.ts` | `P3Principal` |
| `apps/p3/src/app.ts` | `API`, `KINDS`, `PRINCIPALS`, `mayReachSession` |
| `apps/p3/src/api/v1/index.ts`, `server.ts`, `worker.ts` | the API module plugins import |
| `apps/p3/server.ts`, `worker.ts` | the entries |
| `apps/p3/plugins/sessions/contract.ts` | `Creator`, `SessionInfo`, `SessionRow`, `Facts`, `Sessions`, `SessionFacts`, `SessionWorker` |
| `apps/p3/plugins/sessions/server.ts` | `SessionsStore`, the views |
| `apps/p3/plugins/sessions/worker.ts` | `SessionWorker` |
| `apps/p3/test/topology.ts`, `until.ts`, `client.ts` | the test setup |
| `apps/p3/test/sessions.test.ts`, `app.test.ts`, `plugins/sessions/sessions.test.ts` | the tests |
| `apps/p3/bench/slice-1.ts` | the numbers |
| `packages/chord/src/node/app/index.ts`, `README.md`, `packages/chord/CHANGELOG.md` | the kit change |
