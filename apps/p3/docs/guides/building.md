# Building p3 features

How p3 fits together, what a p3 plugin looks like, the rules, the API, and where to find things. Paths are relative
to the repository root (`/home/badlogic/pi` on slayer) unless they start with `../` (relative to this folder).

Read first: `../chord-practices.md` in full. This guide condenses it and adds the map around it; where the two
differ, `chord-practices.md` and `../decisions.md` win, and this guide gets fixed.

## What you build in, and what you never touch

You build in your package's plugins (`apps/p3/plugins/<name>/`), and their tests. **Never change** these; they belong
to Mario (`../decisions.md`, "Packages: owners, audits, sign-off and browser testing"):

| Code | Paths |
| --- | --- |
| Chord and Durable | `packages/chord/`, `packages/durable/` |
| p3's shared base code | `apps/p3/src/kit/`, `apps/p3/src/api/`, `apps/p3/src/bootstrap/`, `apps/p3/src/install.ts` |
| p3's shared test harnesses | `apps/p3/test/topology.ts`, `apps/p3/test/launched.ts`, `apps/p3/test/commands.ts` |

When your package needs a change there (a Chord fix, an API export, a kit option, the topology loading your plugin):
**stop**, write it up (the problem, a concrete example, the change it needs) and tell your user to take it to Mario
(`process.md`, "Code you never change"). Never work around a missing piece inside your plugin.

## How the parts fit

```text
browser pages, terminal clients        not addressable; reach everything through the server
        │  WebSocket /chord (a sign-in: cookie or bearer token)
     server  (one per Pi)               host at Server(), the server's store, HTTP, plugins built here
        │  a link per worker (IPC), the server relays clients' holds and calls
session workers (one process each)      host at Session({ id }), its own store, plugins' worker facets
```

| Part | What it is | Where |
| --- | --- | --- |
| the `p3` command | `p3`, `p3 server`, `status`, `stop`, `restart`, `list`; plain `p3` starts a background server and prints an owner link | `apps/p3/src/bootstrap/bin.ts`, `src/commands.ts` |
| the supervisor | runs the background server as its child, starts it again after a crash | `apps/p3/src/bootstrap/supervisor.ts` |
| the server | `startP3` gives the kit the data directory, the plugins root, the port, the worker's entry | `apps/p3/src/bootstrap/server.ts` |
| the kit's server start | the data directory's lock and record, the store, Chord's HTTP component, the plugins component, the session workers, the kit's own facets, the owner link | `apps/p3/src/kit/start-server.ts` |
| a session worker | one process per session: its store, its host, connected to the server, loads the worker facets the server shipped | `apps/p3/src/bootstrap/worker.ts`, `src/kit/worker.ts` |
| the route to workers | who reaches a worker (`mayReachSession`) and whether the session exists (`sessionExists`, admission) | `apps/p3/src/session-route.ts`, `src/kit/session-workers.ts` |
| sign-ins | a browser's cookie or a command-line client's bearer token; a sign-in that ends closes its links | `apps/p3/src/kit/sign-ins.ts`, `src/kit/owner.ts` |
| where files are | the plugins root, the process entries, the worker's V8 flags, the version, in both layouts | `apps/p3/src/install.ts` |
| the data directory | `~/.pi/p3`: `pi.json`, `server/store.sqlite`, `workers/<kind>/<address>/store.sqlite`, `cache/`, `logs/`, `owner-token`, `server.json`, `supervisor.json` | `apps/p3/src/kit/layout.ts` |
| the release | base code bundled per process into `dist/`, plugins shipped as source and built at start | `apps/p3/scripts/build-release.ts`, `scripts/release-local.ts` |

**Hosts and links.** A host is one participant (a process, a tab), with an address if others can reach it. A link
joins two hosts. Clients reach workers only through the server, which relays (design §3). A plugin never sees
processes: it serves objects on a host kind, and asks for objects by contract.

**Plugins and facets.** A plugin is a folder in a plugins root (`apps/p3/plugins/` is the built-in root). It has one
file per facet kind it runs on. p3's kinds today: `server` and `worker` (`KINDS` in `apps/p3/src/app.ts`). `web` and
`terminal` are PROPOSED (slices 16 and 27). The server builds every facet with esbuild at start (Chord's plugins
component, `packages/chord/src/node/plugins/`), and ships the worker facets to each worker. Workers never build.

**The kit** (`apps/p3/src/kit/`) is p3's copy of the parts of Chord's app kit it needs, cut down and typed to p3
(`../decisions.md`, "The p3 kit, slice 1 redo"). Chord keeps its general components (HTTP, workers, plugin loading).
The kit is base code: a change restarts the server.

**The store.** The server and each worker have one SQLite store (`node:sqlite`, synchronous: a query blocks the
event loop). A plugin's
data is documents and tables its objects own (design §§9-11). A worker's store holds the session's own data; the
server's store holds what is needed while no worker runs. Never both for one fact (`../decisions.md`, "Session data
on the server as host-keyed documents").

**Admission.** Before an object of a remote type is built, its `admit` reads data about the caller and returns
`allow(value)` or `deny(reason)`; the factory gets the value (design §6, "Admission"; `plugin-authoring.md`, "Who may
do what"). The route to workers has its own admission: no worker starts for a session that does not exist
(`sessionExists`). Persons get admissions with slice 5 (PROPOSED); today every object serves the owner, the server
and workers only.

**Apply and reload.** A reload replaces a plugin's code on a running host: its live objects restart, running calls
finish on the old code, documents and tables stay (design §21; `host.reload` in `packages/chord/src/host/`). The
rollout order is server, then workers, then clients. In p3 today reloads run only in tests (`apps/p3/test/topology.ts`,
`reloadSessions`, `reloadWorker`). Apply from anywhere (the kit's reload control `AppChanges`) is slice 2, PROPOSED.
Base code (the kit, the API, Chord) changes only with a server restart.

**The release.** p3 runs two ways, and both must work (`../chord-practices.md`, "Releases"):

- from the checkout: `node --conditions=source apps/p3/src/bootstrap/bin.ts` (TypeScript, workspace packages from
  their `src/`);
- as the installed release (`npm run release:p3:local -- --out <dir>` from the root): `dist/main.js` (command and
  server), `dist/worker.js`, `dist/supervisor.js`, each a bundle of its own; plugins as source, built at start;
  the API compiled with declarations for third-party plugins (`../slices/26-release.md`, "As built").

## The shape of a p3 plugin

The model is the sessions plugin (`apps/p3/plugins/sessions/`, 300 lines):

```text
apps/p3/plugins/sessions/
  package.json           { "name": "@earendil-works/p3-sessions", "private": true, "type": "module" }
  contract.ts            contracts every kind imports: Sessions, SessionsList, SessionFacts, SessionWorker, SessionRow
  contract.server.ts     the store's contract, for server facets only: SessionsStore with its named queries
  server.ts              the server facet: the table, the store, the owner's views, the worker's row, SessionRoute
  worker.ts              the worker facet: SessionWorker, the session's row as the owner sees it on the worker
  sessions.test.ts       the plugin tier: testPlugin
```

**One audience per contract.** The owner, a session's worker and the server never share a contract through variants.
Variants are levels of one audience (`viewer`, `participant`). A worker reading its own session gets its own contract
(`SessionFacts`).

**The store owns the table; every write goes through it; reads are named queries.**

```ts
// contract.server.ts
export const SessionsStore = local("sessions.store", { version: 1, params: {}, members: {
	sessions: queries(SessionRow, { active: obj({ app: str() }), archived: obj({ app: str() }), one: obj({ id: str() }) }),
	create: method(obj({ title: Title, creator: Creator }), str()), rename: …, archive: …, restore: … } });

// server.ts
const Rows = defineTable("sessions.rows", { version: 1, columns: ROW, key: ["id"],
	indexes: { active: ["app", "archivedAt", "lastTouch"], archived: ["app", "archivedAt"] } });   // one index per list's order
host.serve(SessionsStore, (_params, self) => {
	const rows = self.table(Rows);
	return {
		sessions: self.queries(rows, { map: shown }, {
			// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
			active: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), eq(s.archivedAt, 0))).orderBy((s) => s.lastTouch, "desc"),
			…
		}),
		rename: ({ id, title }, ctx) => update(id, { title }, ctx),    // tx.update names its columns
		…
	};
});
```

**Views forward; lists are `self.list`; a worker follows its row with `self.liveQuery`.**

```ts
host.serve(Sessions, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const store = self.get(SessionsStore, {});
	return forward(store, Sessions, "owner", {                         // members from the store, by the contract's names
		create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),
	});
});
host.serve(SessionsList, ({ app, set }, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: 50 });
	return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
});
```

**A facet only declares** (`host.serve`, `self.contribute`, `host.references`), synchronously. State lives in
documents and tables; standing behaviour in a `local` object with empty params (it lives as long as the host). A
factory is synchronous: no awaits, no side effects (design §6, "The factory principle"; §16).

**Names** are prefixed by the plugin: `sessions.store`, `sessions.rows`. Tools are `<plugin>_<name>`. Use the names
of `../names.md`.

## The API: `@earendil-works/p3/v1`

Plugins import only the API, their own files, and contract files of plugins in the same root (by relative path). Never
Chord: the build refuses it (`plugin-authoring.md`, "What a plugin may import"). The API is `apps/p3/package.json`'s
`exports`:

| Module | File | What it gives |
| --- | --- | --- |
| `@earendil-works/p3/v1` | `apps/p3/src/api/v1/index.ts` | all of Chord's root (`@earendil-works/chord`: contracts, schemas, tables, queries, errors, `allow`/`deny`, `defineMessages`, …), `Context` and `BACKGROUND_CONTEXT`, `defineFacet` typed with `P3Principal`, the host kinds `Server` and `Session`, the helpers `forward` and `contribute`, the type `P3Principal` |
| `@earendil-works/p3/v1/server` | `apps/p3/src/api/v1/server.ts` | `Http` (Chord's HTTP routes registry), `AppInfo` (the data directory, p3's name, the API version), `SessionRoute` (the contract the route's admission reads; the sessions plugin serves it) |
| `@earendil-works/p3/v1/worker` | `apps/p3/src/api/v1/worker.ts` | `WorkerInfo` (the worker's address) |
| `/v1/web`, `/v1/terminal` | none | PROPOSED: slices 16 and 27 |

- A facet imports the shared module and its own kind's module. A server facet importing `/v1/worker` fails its build.
- **The principals** (`apps/p3/src/principals.ts`): `{ kind: "owner" }`, `{ kind: "person", id, name }`,
  `{ kind: "worker", session }`, `{ kind: "server" }`. Identity only; what a person may do is data read by admissions
  (`../decisions.md`, "The principal is identity only").
- **`forward(store, Remote, variant, own?)`** (`apps/p3/src/kit/forward.ts`): a view's members taken from a store by
  the remote contract's member names; `own` gives the members that need the caller. Never derive a public contract
  from a store.
- **`contribute(host, name, register)`** (`apps/p3/src/kit/contribute.ts`): an object that only contributes, for a
  contribution that needs a reference, a registry, a derive or a writable.
- **What the API does not have** (a Chord subpath such as `chord/workers`, a new facet kind, a new start-data object)
  is an API change: base code, Mario's. Write it up and have your user take it to him (above).

## The rules, condensed

From `../chord-practices.md` (the rules with their reasons), `plugin-authoring.md` and design.md.

**Data**
- One owner per datum, written only through it. No copies of a value in a second place: read it with a named query, a
  join or `exists`.
- A write that changes a few columns is `tx.update`, never `put`: readers that depend on none of the columns skip.
- Index and order columns are never optional (store "none" as 0, show `null`).
- Every named query says in a comment which index serves its condition and order, and a plan test proves it
  (`testing.md`). One index per list's order, the key Chord appends included.
- Hot details (tokens streaming, progress, timers) never reach a table a list reads. A row holds transitions only.
- Anything needed while the worker is off lives on the server, keyed by the session's address; the rest in the
  worker's store; never both.

**Lists**
- A screen's list is `self.list` with `more`. One remote object per screen, the screen's own id in its params. Never
  `{ first: 1000 }`, never chained pages, never a growing "first n".
- Drive a list from what the person has (their teams, shares, what they created). An `exists` is never the selective
  part of a list.
- A count reads every matching row on each run: count only what a key or an index bounds.
- No substring filter: `prefix` only; search goes through a search plugin's method.

**Access**
- A person's data comes from admission, never from params. Params only narrow inside what the admission allows.
- Conditions are built by server code; clients send values.
- Per-person rows (pins, unread marks) are filtered by the person, not only by the access condition.
- App-specific views check the session's current app.
- No `self.job` in an admitted type.
- Plugins never branch on principal kinds beyond "a person". Today's factories check `principal.kind` for the owner
  and the worker because persons do not exist yet (slice 5).

**Workers**
- No stale-worker checks: Chord's workers component closes an exiting worker's link and settles its queued commits
  before it publishes the exit. Data kept across a worker's runs is tagged with `ctx.incarnation`.

**Reload**
- Everything kept across a reload is in tables and documents; writables start over.
- A root opened inside a method takes the method's `ctx` (`host.root(fn, withoutAbortSignal(ctx))`; Chord's
  `withoutAbortSignal` is in `@earendil-works/chord/context`, not yet in p3's API: when you need it, it is an API
  change for Mario). Work longer than a few seconds is a job: a call still running at the reload drain bound (5 s) is cut.
- Every facet you touch is edited and reloaded while in use, in a test (`testing.md`).

**Contracts and errors**
- Bump a contract's `version` for every change of shape; serve the previous version through `accepts`.
- Admission sources `accept` their previous version.
- Throw Chord's errors: `invalid("args", …)`, `forbidden(…)`; `new PluginError(code, message, details)` for the
  plugin's own codes. Only code, reason, message and JSON details cross a link.
- Every text a person reads is a message (`defineMessages`, `plugin-authoring.md`, "Messages"); objects store
  messages as data, never sentences.

**Releases**
- Plugins ship as source: they import only the API and their own files; their tests end in `.test.ts`.
- A plugin's npm `dependencies` are bundled into its facet's script. No `import.meta`, `__dirname`, top-level `await`
  or literal `import("x")` in plugin code (the build refuses them). Chord reads a plugin's own files through
  `pluginFile` (`@earendil-works/chord/plugins`), which p3's API does not export yet: an API change for Mario.
- No new dependency without a measurement (`performance.md`) and the root `AGENTS.md`'s dependency rules (exact
  pins, the lockfile reviewed).

**Code style** (root `AGENTS.md`, "Chord v2 Code Style", binding for p3 code)
- One concept per file, named after it. First line: a comment saying what the file is for. Imports, exported types,
  the public entry point first, helpers below it in the order used.
- Every export has a one-line doc comment. Inline comments explain a non-obvious why, never what the next line does.
- Short functions with one job. No boolean flag parameters: two functions or a tagged value. Never the same lines
  twice. Context last: required args, then `ctx`, then optional args.
- Tagged unions for every state and result. Casts only with a short why. Runtime checks only at trust boundaries,
  each naming the boundary.
- No `any`. No inline imports (`await import()`, `import("pkg").Type`): top-level imports only. Erasable
  TypeScript only.
- Caches are `WeakMap`s keyed by their owner, each with a GC test. No module-level strong caches.
- Before reporting: re-read every changed file top to bottom as a stranger would.

## Where to find things

| What | Where |
| --- | --- |
| what p3 is, its plugins | `apps/p3/docs/overview.md` |
| names | `apps/p3/docs/names.md` |
| decisions | `apps/p3/docs/decisions.md` (p3), `packages/chord/docs/decisions.md` (Chord) |
| practices and mistakes | `apps/p3/docs/chord-practices.md` |
| slices, their briefs and state | `apps/p3/docs/slices/README.md`, `slices/NN-name.md` |
| walkthroughs of what is built | `apps/p3/docs/slices/01-base-and-sessions/walkthrough/`, `slices/26-release/walkthrough/` |
| Chord's design | `packages/chord/docs/design.md` (§2 concepts, §6 objects and admission, §10-11 store and state, §17 registries, §21 reload, §23 components, §29 telemetry, §30 cost) |
| Chord plugin guide | `packages/chord/docs/plugin-authoring.md` |
| Chord's components | `packages/chord/src/node/{http,workers,plugins,app}/` (each has a `README.md`) |
| Chord's examples | `packages/chord/test/examples/` |
| the API | `apps/p3/src/api/v1/` |
| the kit | `apps/p3/src/kit/` |
| process entries | `apps/p3/src/bootstrap/` |
| the model plugin | `apps/p3/plugins/sessions/` |
| tests and helpers | `apps/p3/test/` (`topology.ts`, `until.ts`, `launched.ts`, `commands.ts`, `plans.test.ts`, `release/`) |
| the bench | `apps/p3/bench/slice-1.ts` |
| p2 (inspiration only) | `apps/p2/plugins/`, `apps/p2/docs/`, `apps/p2/docs/p3-functions/` |
| Durable (the harness, slice 3) | `packages/durable/` |
| the archive (older designs, older names) | `apps/p3/docs/archive/`: translate with `names.md`; not a reference for building |

## Checklist

1. The brief is filled out and its decisions taken (`process.md`).
2. One folder per plugin, `package.json` named, one facet file per kind (`server.ts`, `worker.ts`), each
   default-exporting `defineFacet(...)`.
3. Imports: `@earendil-works/p3/v1` and your kind's module, your own files, same-root contract files by relative
   path. Nothing from Chord.
4. One audience per contract; contracts prefixed with the plugin's name; a version bump for every change of shape.
5. A store owns each table; writes through it; reads as named queries with an index comment each; `tx.update` for
   touches.
6. Lists are `self.list` with `more`, one object per screen; no hidden caps.
7. Views `forward` from the store; access by admission (or the owner check until slice 5).
8. Factories synchronous and declarative; standing behaviour in host-lifetime `local` objects.
9. Texts in `messages.ts` (`defineMessages`).
10. No change to Chord, Durable, p3's shared base and test code, or another package's files. Each needed change
    written up (problem, example, change) and taken to Mario by your user; another package's, to its owner.
11. Chord v2 code style, re-read top to bottom.
12. Tests per `testing.md`, numbers per `performance.md`; `cd apps/p3 && npm run check` clean.
13. Before you report: `npm run release:p3:local -- --out <dir>` passes when your package changes what the release
    ships (its plugins' files, their dependencies).
