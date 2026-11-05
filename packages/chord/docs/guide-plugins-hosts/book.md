---
title: Hosts and Plugins: a tutorial for Chord v2
cover: Hosts / and Plugins
kicker: A guide · Chord v2 · 2026-11-02
subtitle: Build a small notes app step by step, from one host to plugins on a server and on workers, edited while it runs
stats:
  - 3 | kinds of host in an app: server, worker, client
  - 1 | file per host kind in a plugin
  - 0 | restarts to apply a plugin edit
  - 1 | rule: plugins talk only through object types and registries
note: |
  A tutorial for people building apps on Chord v2, written by the redesign session from `design.md`, `slice-7c.md`,
  `slice-10.md`, `slice-12.md`, `slice-13.md`, the decision log and the code in `packages/chord/src`. API names
  are the current ones. The early chapters wire hosts by hand to show the parts; the last chapter shows the app kit
  (`chord/app`), which does that wiring for an app.
colophon: Hosts and Plugins · fourth edition · 2026-11-04 · Chord v2 slices 1-13, messages and languages, telemetry
---

# Before we begin {.preface}

You want to build a notes app. You type a note in a browser tab, and every other tab sees it at once. Each project
gets its own notes in its own process, so a project that misbehaves cannot take the others down. And you, or an agent
you work with, add features while the app runs: a search, an export button, a word count, without restarting
anything.

Chord gives you three things for that. **Hosts**: the processes of your app (the server, a worker per project, the
browser tabs), connected to each other. **Objects**: the state and methods your app is made of, living on one host and
used from any other. **Plugins**: directories of code that declare objects for each kind of host, loaded and
reloaded while the app runs.

This book builds the app in that order. Each chapter adds one concept and shows complete code.

## Seven things to know

:::findings
1. **A host is one participant.** The server, each worker, each browser tab and each terminal UI is a host; hosts
   connect over links. Tabs and terminal UIs are clients: no address, they connect to the server and ask.
2. **An object has a type, and a type is a contract.** The contract names the object's state and methods; any host can
   ask for an object by type and params, and Chord finds where it lives.
3. **A facet declares, an object acts.** A facet is a plugin's code for one host kind: it says which object types this
   host serves. The objects hold the state and do the work.
4. **A plugin is a directory** (or a single file). A `package.json` with the plugin's name, and one file per host kind:
   `server.ts`, `worker.ts`, `web.tsx`. It imports its host only through the app's versioned API (`@app/api/v1`).
5. **The server builds, every host evaluates.** The plugins component builds each facet into a small script; the
   server, workers and tabs load the scripts for their kind.
6. **Plugins meet through types and registries.** One plugin uses another's objects through its contract, or
   contributes to a registry another defines. Nothing else crosses between plugins.
7. **An edit is a rollout.** Change a file, build, roll out: the server, then every worker, swap the plugin's objects in
   place; a broken edit keeps the old code running and reports why.
:::

:::flow wide animate | How it all fits: plugins on disk are built once on the server; each host evaluates the facets of its kind; tabs and the TUI are clients that reach workers' objects through the server.
row "On disk" muted
box disk "plugins/notes/" "`server.ts`, `worker.ts`, `web.tsx`, `tui.ts`, `contract.ts`" muted
box core "src/ (base code)" "`@app/api/v1`: Chord's surface, host kinds, principals" muted
row "Server process" accent
box comp "plugins component" "discover, build every facet, watch, roll out" accent
box server "server host" "server facets; routes Project → workers"
row "Clients and workers"
box tab "client: tab or TUI" "web or tui facets, local UI objects; holds `Notes { p1 }`" blue
box w1 "worker p1" "worker facets; serves `Notes { p1 }`"
arrow disk -> comp "read, build"
arrow core -> comp "host packages"
arrow comp -> server "server scripts"
arrow comp -> tab "web or tui scripts"
arrow tab -> server "hold Notes { p1 }"
arrow server -> w1 "start (worker scripts), relay"
note "Each host loads only its own kind's facets. Plugins meet only through object types and registries."
:::

## Words used throughout

A **host** is one participant of the app, made with `createHost`. A **host kind** (`Server`, `Session`) describes
addressable hosts; an **address** (`Session({ id: "p1" })`) names one. An **object type** is a contract: `local` (used
on its own host only) or `remote` (used from any host). An **object** is one instance of a type, per params. A
**facet** is a plugin's declarations for one host kind. A **plugin** is a directory with a `package.json`. A
**reference** is what you get when you ask for an object (`host.get`, `self.get`, `ctx.get`). A **document** is data an object
stores, changed in **transactions**; a **table** holds many records with queries, in the host's **store**, and a **live query** keeps some of its rows current; a **derive** is a value computed from others; a **native** is an outside
resource an object opens and closes. A **registry** is an
extension point: one plugin defines it, others contribute. A **rollout** applies a build to the hosts in order.

# One Host {#host lede="The smallest app: one process, one object type, one call."}

Start without plugins. One host, one object that keeps notes:

```ts
import { createHost, defineFacet, defineState, local, method, obj, arr, str } from "@earendil-works/chord";

const NoteList = obj({ items: arr(str()) });          // one schema, used by the contract and the document

// the contract: what a Notes object offers
const Notes = local("notes.store", {
	version: 1,
	params: {},                                        // one object per host: no params
	members: {
		list: NoteList,                               // state anyone can read and watch
		add: method(obj({ text: str() })),            // a method: arguments checked by Chord
	},
});

// the document the object stores (its own version: storage can change without changing the contract)
const NotesDoc = defineState("notes", { schema: NoteList, version: 1, initial: () => ({ items: [] }) });

// the facet: which types this host serves, and how to make each object
const facet = defineFacet((host) => {
	host.serve(Notes, (_params, self) => {
		const doc = self.state(NotesDoc);
		return {
			list: doc,
			add: async ({ text }, ctx) => self.tx(async (tx) => { (await tx.draft(doc)).items.push(text); }, ctx),
		};
	});
});

const server = createHost({ onError: console.error });
await server.load([{ name: "@app/notes", facet }], ctx);
const notes = await server.get(Notes, {}, ctx);        // a reference: live, with its state
await notes.add({ text: "buy milk" }, ctx);
console.log(notes.list.value);                          // { items: ["buy milk"] }
```

Four things happened. The **contract** `Notes` says what the object offers; the **document** says what it stores.
Here they have the same shape, so one schema serves both; they are separate because they change separately (an
object may offer a computed value or a shortened view instead of what it stores, and storage can change its shape
without users noticing).
The **facet** says this host serves
`Notes`, with a **factory** that declares the object's parts: a document, and a method writing it in a transaction.
`load` publishes the facet. `get` returns a **reference** once the object is live; its members are the contract's.

The factory only declares: it is synchronous and opens nothing. Chord activates the object (loads its documents, opens
what it asked to open) and then serves calls. That is why the same factory can run again when the code changes.

**`load` comes first.** A `get`, `hold` or `registry` on a host whose `load` was not called throws `not_ready` at once
("call `host.load` first"): it would wait for types nobody published. A client with nothing to load calls
`load([])`. Mistakes that would otherwise look like slowness are reported through `onError` instead: a request
waiting for a type or registry nobody serves (`unbound_long`, after 5 s; it keeps waiting until its `readyTimeout`),
a registry with contributions and no provider (`registry_undeclared`, when `load` publishes), and a plugin name that is
no npm name makes `load` throw.

# An Object's Parts {#parts lede="Documents, tables, transactions, computed values, watching, and outside resources: the vocabulary of every factory."}

A factory builds an object from a handful of parts, each declared with one call on `self`. The notes object grows to
show all of them.

**Documents** hold the object's data: `self.state(NotesDoc)` gives a handle whose `.value` is the current data. Data
changes only in a **transaction**: `self.tx(fn, ctx)` runs `fn` with `tx`, and `await tx.draft(handle)` gives a
mutable copy of the document's data; whatever you change on it is committed at once when `fn` returns, or not at all
if it throws.

```ts
add: async ({ text }, ctx) => self.tx(async (tx) => {
	const draft = await tx.draft(doc);          // the document's data, writable inside this transaction only
	draft.items.push(text);                      // recorded as a change, committed when the function returns
}, ctx),
```

Documents live in memory unless they are **persisted**: `defineState(..., { persist: true, checkpointWhen })` keeps
one in the host's **store** (a SQLite file the app opens and gives to `createHost({ store })`), loaded when the
object activates. For many records with queries, an object declares a **table**:

```ts
const NoteRows = defineTable("notes", {
	version: 1,
	columns: { id: str(), text: str(), at: int() },
	key: ["id"],
	indexes: { by_time: ["at"] },
});

host.serve(NoteStore, (_params, self) => {               // a local type with empty params: it may persist
	const rows = self.table(NoteRows);                    // created (or migrated) when the object activates
	const recent = query(NoteRows).orderBy((n) => n.at, "desc");
	return {
		add: async ({ text }, ctx) => self.tx(async (tx) => tx.put(rows, { id: uuid(), text, at: Date.now() }), ctx),
		page: async ({ after }, ctx) => rows.page(recent, 50, ctx, { after }),   // 50 at a time, with a cursor
	};
});
```

Persisted data lives only in `local` objects with empty params (one per host and type), so its address never depends
on who asked or with which params; an object with params (a view per project) reads from such a store. Writes go
through the same transactions as documents: a note row and a document can change in one commit.

A table has no watch of its own. To show rows live (the newest notes in a tab), the object declares a **live query**
over its own table, with a limit:

```ts
const newest = self.query(rows, recent, 50);             // the 50 newest rows, a value like a document's
return { newest, add, page };                            // a member: tabs watch it and get only the changes
```

Chord runs the query before the object goes live, and again in every commit of the object that writes `rows`, and
sends what changed. Only the object's own tables: it is their only writer, so its commits are exactly when the rows
can change, and a commit that writes no such table costs nothing. Each writing commit runs the query once more, at
most the limit's rows: right for data people edit, wrong for a table written hundreds of times a second (there may be
dragons; keep what the tab shows in a document the object writes with each change instead). The limit is required.

A **derive** is a value computed from other values, recomputed whenever they change. It is how an object offers
something it does not store:

```ts
const count = self.derive([doc], ([notes]) => notes.items.length);   // 0, 1, 2, … as notes are added
return { list: doc, count, add };                                      // `count` can be a member like `list`
```

**Watching** is how anyone follows a value as it changes: a document handle, a derive, a reference's member. `watch`
gives the current value, then one call per change:

```ts
const watch = await notes.count.watch(ctx);
watch.start(async (call) => {
	if (call.kind === "value") console.log("notes:", call.value);   // "failed" calls say a value cannot be computed now
});
```

A **routine** is the object watching on its own behalf: `self.on(source, fn)` runs `fn` with each new value, for as
long as the object lives (a reconciler: "whenever the notes change, rebuild the export file").

A **native** is something outside Chord the object opens and must close: a file watcher, a database connection, a
child process. `self.open(open, close)` opens it while the object activates and closes it when the object ends:

```ts
const inbox = self.open(async (ctx) => watchDirectory(inboxPath, ctx.abortSignal), (watcher) => watcher.close());
self.onLive(async (ctx) => {                                  // a routine started once the object is live
	for await (const file of inbox.value.files(ctx.abortSignal)) await importNote(file, ctx);
});
```

Natives are why some objects restart when their plugin changes: an open connection cannot be moved to new code, so
Chord closes it and opens it again. Objects without natives are swapped in place. A first read of a table is no
native: declare it as a live query, not with `self.open`, or the object restarts at every change of its plugin.

**Await what you start in a root or a handler.** What is started with a context ends with it. Code outside objects
gets its `ctx` from `host.root(fn, ctx)`, and that scope seals when `fn` returns; a handler's context ends when its
caller cancels or its object ends. A change still waiting when its context ends is cancelled before it commits:

```ts
await server.root(async (ctx) => {
	void notes.add({ text: "lost" }, ctx).catch(() => {});   // fn returns, the scope seals: the call's change is cancelled
}, ctx);
await server.root(async (ctx) => notes.add({ text: "kept" }, ctx), ctx);   // awaited: it commits
```

The cancelled change rejects, and since an empty `catch` would hide that it never happened, Chord also reports it
through `onError` as `transaction_cancelled`, naming the object and, in its error, the scope that ended.

# Several Hosts {#hosts lede="A server, a worker per project, browser tabs: how they find each other's objects."}

Now give each project its own process. Declare the kinds of addressable host, and make notes a `remote` type that
lives on its project's worker:

```ts
export const Server = hostKind("server");
export const Project = hostKind("project", { id: str() });

export const Notes = remote("notes", {
	version: 1,
	params: { project: str() },
	hostAddress: ({ project }) => Project({ id: project }),   // where an object of these params lives
	variants: { editor: { state: { list: NoteList }, methods: { add: method(obj({ text: str() })) } } },
});
```

Two things are new. A `remote` type can be used from any host, and it has **variants**: different sets of members
for different callers, chosen by the factory (an `editor` variant with `add`, a `reader` variant for guests without
it). And `hostAddress` says where its objects live; it is the whole routing story.

A tab asks for `Notes { project: "p1" }`. Its host computes the address,
`Project(p1)`, and sends the request to its parent, the server. The server has a **route** for `Project`: it starts (or
finds) the worker for `p1` and passes the request on. The worker serves `Notes`. The tab gets a reference whose state
follows the worker's document, one frame per change.

:::flow wide animate | A tab holds a project's notes: the server routes by address to the project's worker and relays, without reading the data.
row "Clients" blue
box tab1 "tab A" "holds Notes { project: p1 }"
box tab2 "tab B" "holds Notes { project: p1 }"
row "Server" accent
box server "server" "route Project → worker"
row "Workers" muted
box w1 "worker p1" "serves Notes { p1 }"
box w2 "worker p2" "serves Notes { p2 }"
arrow tab1 -> server "hold"
arrow tab2 -> server "hold"
arrow server -> w1 "relay"
:::

Each host is created the same way, with what it is:

```ts
// server.ts
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError });

// worker.ts (started by the server for one project)
const worker = createHost<P>({ address: Project({ id }), principal: { kind: "worker", project: id }, onError });
worker.connect(parentLink, { principal: { kind: "server" }, trusted: true }, ctx);

// a browser tab: no address, it is a client
const tab = createHost<P>({ onError });
tab.connect(webSocketLink(new WebSocket("/chord")), { principal: { kind: "server" } }, ctx);
```

`P` is your app's type of **principal**, who is calling: an owner, a guest, the server, a worker. Links stamp it;
a `remote` object is made per principal, so a guest can get a read-only variant of the same notes.

## Who a reference acts as

A reference acts as whoever made it. `host.get` and `self.get` in a `local` object act as the host; `self.get` in a
`remote` object acts as that object's principal; **`ctx.get` in a method acts as the method's caller**. That is what
lets a guest's call reach a worker as the guest and get the guest's variant, never more than the guest may see.

It surprises one case: a server object that should act as itself towards a worker. The owner calls
`Search.rebuildIndex`, which asks each project's worker to scan its files:

```ts
// server.ts: wrong, the worker sees the owner
rebuildIndex: async ({ project }, ctx) => {
	const scan = await ctx.get(IndexScan, { project });   // acts as ctx.principal: the owner, the method's caller
	return scan.run(ctx);
},

// worker.ts: the factory serves only the server
host.serve(IndexScan, (params, principal, self) => {
	if (principal.kind !== "server") throw new Error("IndexScan serves the server only");   // refuses the owner
	…
});
```

The worker's factory gets `{ kind: "owner" }` and refuses. To act as the server, take the reference where the server
is the maker: `self.get(IndexScan, { project })` in a `local` server object of its own (a dependency of that object,
which acts as the host), or, in base code that has the host, a root of the server's host:

```ts
// base code: a root acts as the host (the server), not as the method's caller
rebuildIndex: async ({ project }, ctx) =>
	server.root(async (own) => (await own.get(IndexScan, { project })).run(own), ctx),
```

## Calls in progress

There is no limit on calls in progress per link. A tab sending 200 calls at once over its socket gets all 200 run:
at most N (256 by default, announced in the handshake) are in flight per origin, the rest wait in order in the link's
call queue, none is refused for being too many. The bounds are that call window and the part limits on what arrives
(sizes, not counts). An object that must limit work per caller does so in its methods, or runs the work as a job.

:::note | The app kit does this wiring
Starting workers, routing a host kind to them, the WebSocket entry and authentication are slice 10's components
(`createWorkers`, `chord.http`). An app built with the app kit (`chord/app`, the last chapter) does not wire them:
`startServer(...)` on the server and `startWorker(...)` in a worker's entry do.
:::

# Client Hosts {#clients lede="Browser tabs and terminal UIs are hosts too: what they can do, and what they cannot."}

A browser tab and a terminal UI are hosts like the server, with one difference: they have **no address**. Nobody can
send a request *to* a tab; a tab only connects to the server and asks for things. That is a deliberate rule: a tab
runs on a device the server does not control, so nothing on the server ever waits for, or trusts, a tab's state.

```ts
// a browser tab (slice 11's page host will do this wiring for you)
const tab = createHost<P>({ onError });                               // no address, no principal: a client
tab.connect(webSocketLink(new WebSocket("/chord")), { principal: { kind: "server" } }, ctx);
await tab.load([{ name: "@app/web", facet: webCore }, ...webFacets], ctx);

const notes = tab.hold(Notes, { project: "p1" }, ctx);               // a reference at once, live soon
(await notes.list.watch(ctx)).start(async (call) => {
	if (call.kind === "value") render(call.value.items);              // every change, as it commits on the worker
});
await notes.add({ text: "from the tab" }, ctx);                        // a call: tab → server → worker
```

**Who the tab is** is not the tab's to say. The server authenticates the WebSocket when it connects (a cookie, the
owner on loopback, a guest's share link) and stamps that principal on everything the tab asks for. The worker's
`Notes` factory receives it and may give a guest a read-only variant. A tab cannot claim to be the owner.

**What a tab serves** is only `local` types: state of this tab's UI, never shared. A draft that survives switching
panels, a selection, a tab-local cache:

```ts
// plugins/notes/web.tsx: the web facet serves a local type, and contributes a panel
export default defineFacet((host, self) => {
	host.serve(NoteDraft, (_params, self) => ({ text: self.state(DraftDoc) }));   // lives in this tab only
	self.contribute(Panels, { title: "Notes", Component: NotesPanel });
});
```

**When the connection drops** (a phone in a tunnel, a server restart), the tab keeps its references. Their values
stay readable, their `state` says `loading`, calls made meanwhile wait; on reconnect every reference is held again and
gets the current value in one frame. The UI shows a banner from `ref.state`, nothing more.

**A terminal UI** is the same in Node: a client host connected to the server over a WebSocket, loading the plugins'
`tui` facets, rendering with whatever terminal library the app chose. **What a client never does**: serve a `remote`
type, be routed to, or keep data others rely on. Data that must outlive a tab belongs in an object on the server or a
worker.

**Text in the viewer's language** is a client's job too, because two people looking at the same object may read
different languages. A plugin writes its texts once, in a shared `messages.ts`; a client renders them in its host's
language (the user's pick, else the device's), and objects store messages as data, never sentences (design §23,
"Messages and languages"):

```ts
// plugins/notes/messages.ts: the first catalog types the others
export const messages = defineMessages("notes", { en: { empty: "No notes yet" }, de: { empty: "Noch keine Notizen" } });
// plugins/notes/web.tsx: the facet contributes its catalogs; a component renders in the page's language
self.contribute(Translations, messages.translations);
const { t } = useMessages(messages);                       // re-renders when the user picks another language
// plugins/notes/worker.ts: a notice as data; every client renders it with t.render(notice)
draft.notice = messages.message("empty");
```

# Plugins {#plugins lede="Move the code into a directory that can be added, edited and removed while the app runs."}

So far the facets were part of the app's own code. A **plugin** is the same code in its own directory:

```text
plugins/notes/
  package.json        { "name": "@app/notes" }
  contract.ts         the Notes contract (other plugins import it)
  worker.ts           the facet for workers: serves Notes
  server.ts           the facet for the server: an export route
  web.tsx             the facet for browser tabs: a notes panel
```

The plugin's name is its `package.json` name. Each file named after a **host kind** is that kind's facet, its
default export a `defineFacet(...)`. A plugin has only the files it needs: a plugin that only adds a route has a
`server.ts` and nothing else.

```ts
// plugins/notes/worker.ts
import { defineFacet } from "@app/api/v1";
import { Notes } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(Notes, ({ project }, principal, self) => {
		const doc = self.state(NotesDoc);
		return { variant: "editor", members: { list: doc, add: async ({ text }, ctx) => /* … */ } };
	});
});
```

`@app/api/v1` is your app's **API**, version 1: the part of its base code plugins import, as a host package (the
plugin's build leaves it out; every host passes its own copy in). It holds what plugins share and never reloads:
Chord's builders re-exported (`local`, `remote`, `obj`, `str`, ...), host kinds, the principal type, a `defineFacet`
bound to it. A plugin never imports Chord itself; the version in the path says what it was written against.

# Loading Plugins {#loading lede="Two steps in two places: building a plugin into a script happens once, on the server; evaluating it happens in every process that runs it."}

A plugin is source code on the server's disk: TypeScript files that import each other, import other plugins'
contracts, import npm packages, and import things the app itself provides. None of the processes that run the plugin
can use those files as they are. A browser tab has no file system and no TypeScript; a worker could read the files,
but then every worker would compile every plugin again, and two workers started a minute apart could see two different
versions. So loading a plugin is two separate steps:

1. **Build**: turn each plugin facet (`notes/worker.ts`, `notes/web.tsx`) into one self-contained **script**. This
   happens once per edit, on the server, for every host kind.
2. **Evaluate**: run a script inside one process, which gives back the facet, ready for `host.load`. This happens in
   every process that hosts that kind: the server for its own facets, each worker for the worker facets, each tab for
   the web facets.

The two steps need different things, and that is why the API has two calls.

## Host packages: what a script leaves out

Look at what `notes/worker.ts` imports:

```ts
import { defineFacet, obj, remote, Session, str } from "@app/api/v1";   // the app's API: its own part and Chord's
import { Notes } from "./contract.ts";                                  // the plugin's own file
import slugify from "slugify";                                          // an npm package in its dependencies
```

The last two go into the script: the plugin's own files and its npm dependencies are copied in. The first must not.
If the script carried its own copy of the API, and with it of Chord, the worker would run two Chords: the plugin's
`ChordError` would not be the worker's `ChordError`, and the plugin's `defineFacet` would make a facet the worker's host
does not recognize. The plugin must see the very `Session` host kind and the very `Panels` registry the process
already has, not a copy.

Packages the process already has, and that every plugin must share, are its **host packages**. A script leaves them
out and asks for them by name when it runs. Building therefore needs only their **names**: "do not copy `@app/api/v1`
into this script".

## Building: `createPlugins`, on the server

```ts
const plugins = createPlugins({
	roots: [{ path: "./plugins", required: true }],      // where the plugin directories are
	api: { name: "@app/api", versions: ["v1"] },          // the app's API and the versions it provides
	kinds: {
		server: { platform: "node", hostPackages: ["@app/api/v1", "@app/api/v1/server"] },
		worker: { platform: "node", hostPackages: ["@app/api/v1", "@app/api/v1/worker"] },
		web: { platform: "browser", hostPackages: ["@app/api/v1", "@app/api/v1/web", "react", "react/jsx-runtime"] },
	},
	onError,
}, ctx);
```

`createPlugins` is the builder, and it builds for every kind, because only the server has the sources. For each kind
it needs two facts. The **platform** says where the scripts run: a `node` script may import `node:fs`, a `browser`
script may import a stylesheet but not `node:fs`. The **host package names** say what to leave out; they differ per
kind, because a tab also shares React with its plugins and a worker does not, and the API's per-kind modules
(`/v1/web`) belong to their kind only. With `api` set, the build checks every import of the API: a version the app
does not list, another kind's module, two versions in one facet, or Chord imported directly is a build error naming
the file and line. Nothing here runs a plugin.

## Evaluating: `plugins.load`, in the process that hosts

Evaluating is where the names become things. When the script runs and asks for `@app/api/v1`, someone has to hand
it the actual module, the one this process imported when it started. Only the process itself has it:

```ts
// server.ts
import * as api from "./api/v1/index.ts";                 // the app's API, the module plugins import as "@app/api/v1"
import * as apiServer from "./api/v1/server.ts";
import { serverFacet } from "./core.ts";

const report = await plugins.load(server, {
	kind: "server",                                          // evaluate the server kind's scripts
	modules: { "@app/api/v1": api, "@app/api/v1/server": apiServer },   // this process's own instances
	core: [{ name: "@app/core", facet: serverFacet }],       // base-code facets, loaded beside the plugins
}, ctx);
```

`modules` is this process's answer to every host package name. The server passes its own; a worker passes its own in
`workerMain`; a page passes its own in `startPage`. Each process has different instances, which is exactly the point:
inside each process, plugins share that process's Chord and base code.

`core` is the app's base code in facet form. It is a facet like a plugin's, but it is not a plugin: it is made in the
process's own code, often from values only this process has (`core.workerFacet(start)` closes over a worker's start
data and store), and it never reloads, because it defines what all plugins share. Passing it here loads it together
with the plugins, so they are published in one step.

## Why `plugins.load(host)`, not `host.load`

A host has its own `load`, and `plugins.load` calls it. The host's `load` takes facets that already exist: functions
in memory. It knows nothing about directories, builds, scripts or modules, on purpose: the same host runs in a test
with facets imported directly, or in a Cloudflare Durable Object where plugins are bundled at deploy time and nothing
is built or evaluated at runtime.

The plugins component is the part that knows about directories. It finds the plugins, builds them, evaluates them
with the process's modules, and then calls `host.load` with the result. It also remembers, per host, which facet each
plugin runs, so that a later reload can hand the host its complete new plugin set, with unchanged plugins as the very
same objects. That memory is why the host is passed to it: `plugins.load(server, …)` on the server,
`plugins.load(worker, …)` in a worker (where `workerMain` gives it a `plugins` that only evaluates), the same call
in every process.

:::flow wide | Building on the server needs names; evaluating in each process needs that process's modules.
row "Server: build (once per edit)" accent
box src "plugin sources" "`notes/worker.ts`, imports `@app/api/v1`" muted
box build "createPlugins" "copies own files and npm deps; leaves host packages out" accent
box script "worker script" "`require(\"@app/api/v1\")` left as a name"
row "Each worker: evaluate" blue
box mods "the worker's modules" "its own `@app/api/v1`, its own Chord" muted
box load "plugins.load(worker, …)" "runs the script, answers each name" blue
box facet "the facet" "uses the worker's `Session`, the worker's `defineFacet`"
arrow src -> build
arrow build -> script
arrow script -> load "shipped"
arrow mods -> load
arrow load -> facet
:::

## What happens, step by step

:::steps | `plugins.load(server, { kind: "server", … })`
+++ Discover
The component lists `./plugins` and reads each `package.json`. Its `name` is the plugin's name; the files named after
a kind are its facets. A directory without a `package.json`, or with two `server` files, is reported, not loaded. Files
at the root's top named `<name>.<kind>.ts` (`hello.server.ts`) are single-file plugins, grouped by name.
+++ Build
For each plugin with a `server` facet it builds one script, if no current one exists. A syntax error or an import the
rules do not allow (a path into base code, a package not in the plugin's dependencies) is a failed build with the file
and line, never a crash.
+++ Evaluate
The script runs. Each host package name it asks for is answered from `modules`; anything else it may not have. The
script's default export must be a facet.
+++ Load
`host.load` runs the setups of `core` and of every plugin facet and publishes them together. A plugin whose build,
evaluation or setup failed is left out and listed in `report.failed` with the reason; the others load. Objects that
need it wait until a later edit loads it.
:::

Only the server builds. Workers and clients (browser tabs, terminal UIs) only evaluate: the server builds their kinds
too, a worker gets its scripts in its start message, a tab or a TUI gets them from the server over HTTP, and each
evaluates them with its own modules (a worker's from `workerMain`, a page's from its base bundle).

# Plugins Using Plugins {#together lede="Two ways one plugin uses another, and the one it may not."}

A search plugin wants to search the notes. It **imports the contract** and asks for the object:

```ts
// plugins/search/worker.ts
import { Notes } from "../notes/contract.ts";   // a plugin of the same root, by relative path: copied into search's script

host.serve(Search, ({ project }, principal, self) => {
	const notes = self.get(Notes, { project });   // a dependency: Search goes live once Notes is
	const index = self.derive([notes.list], ([list]) => buildIndex(list.items));
	return { variant: "main", members: { find: async ({ q }) => lookup(index.value, q) } };
});
```

Which file a plugin imports decides which version of the contract it claims, so the rule is: **a plugin carries the
contract it was written against.** Two cases:

- **Plugins that change together** (the app's own, in its repository; a user's, in one root) import each other by
  relative path, `../notes/contract.ts`: the same commit holds both sides. The file is copied into the importer's
  script, so only contracts and other side-effect-free files belong there (a copied file may import only the API and
  files of its own plugin). A relative path leaving the root (into base code, into another root) is a build error.
- **Plugins from another repository** take contracts as a dependency at a fixed version, by package name:
  `@bob/notes` (its `contract.ts`, through the package's `exports`), `@bob/notes/web` (its `contract.web.tsx`), pinned
  in `package.json` by an npm version or a git ref (`"@bob/notes": "github:bob/notes#<commit>"`). The build inlines
  the installed version: when Bob's notes move to contract version 2, a consumer built against version 1 keeps
  claiming version 1, and the provider serves it through `accepts` or the consumer waits "contract mismatch", visible,
  never silently wrong. A plugin inside a repository holding several (which lists them in its own `package.json`,
  `"chord": { "plugins": ["./notes", "./search"] }`) is a dependency on the whole repository, imported by path into it:
  `@bob/plugins/notes/contract.ts`.

A contract file may be for one kind: `contract.web.tsx` (React components in a type, a panel's registry token) is a
**web file**. Importing it, directly or through other files, from a facet of another kind is a build error naming
the chain (`server.ts → view.ts → ../notes/contract.web.tsx`). The shared `contract.ts` mentions native things only
through `import type`.

`self.get` in a factory declares a dependency: Chord makes `Search` live only once `Notes` is, and if the notes
plugin is missing, `Search` waits with a clear reason ("waiting for notes: not served here") instead of failing.

The other way is a **registry**: an extension point one plugin defines and others contribute to. The app's API
defines `Panels` in its web module, and every plugin with a UI contributes one:

```tsx
// plugins/notes/web.tsx
import { Panels } from "@app/api/v1/web";
export default defineFacet((host, self) => self.contribute(Panels, { title: "Notes", Component: NotesPanel }));
```

What a plugin may not do is reach into another's data. Search never reads notes' documents; it uses the `Notes`
object's state. That rule is what lets the notes plugin change its storage without breaking search.

# Changing a Plugin {#reload lede="Edit, build, roll out: how new code takes over while every tab stays connected."}

You change the notes plugin: notes now have a timestamp. The watcher sees the saved file and marks the plugin dirty.
You (or an agent) build and roll out:

```ts
const built = await plugins.build(plugins.state.value.dirty, ctx);
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);
```

The rollout goes host by host, server first, then every running worker. On each host Chord compares the new plugin
set with the loaded one, runs the new factories against a recording `self` to see what each object would declare, and
then gives every object of the changed plugin its fate:

| The object | What happens |
| --- | --- |
| holds no natives (open files, sockets), the new code neither | **swapped** in place: new methods, same documents; running calls finish on the old code |
| holds natives | **restarted**: calls wait, running ones finish, natives close and reopen with the new code |
| its type was removed | **ended**; its users wait until something serves it again |

The tab's reference follows the new object and gets one frame with the difference. Nothing reconnects. If the edit
is broken (a syntax error, a factory that throws), that plugin keeps its old code on that host and the report says why;
every other plugin of the rollout applies.

A tab applies a new web script the same way, without reloading the page, and the UI keeps what lives outside the
changed plugin. The changed plugin's own components are new functions, so React mounts them anew and their `useState`
starts over. What must survive the update (a half-typed note, a scroll position) goes into **page state**, kept by the
tab's host under a key: `usePageState(key, initial)` from `chord/react` instead of `useState`, and
`scope.pageState(key, initial)` on a terminal's `TuiScope` (design §21, "UI on client hosts").

:::note | Versions
A change to a contract (a new field in `Notes`'s state) gets a new `version`. A tab built with the old contract keeps
working if the provider maps the old version (`accepts`); otherwise it waits with "version mismatch" until it reloads.
:::

# Base Code and Plugins {#base lede="What goes into the app itself, what goes into plugins, and how an app ships plugins of its own."}

Every app has two kinds of code, and the line between them decides what can change while the app runs.

**Base code** is the app's own program: `src/`, started by `node server.ts`. It shrinks to three things: the **API**
(the versioned modules plugins import), the **bootstrap** (creating hosts, opening the store, components such as
`createHttp` and `createWorkers`) and one small **start-data facet** serving process values (start data, the opened
store) as core objects. Base code changes only with a restart: if it reloaded, the process would hold two `Panels`
registries, and old and new plugins would no longer meet.

**Plugins** are everything else: notes, search, export, a terminal, the harness, the providers of the app's core
registries. They reload on an edit, a broken one is left out alone, and an agent can write one while the app runs.

## The API, by version and by kind

Plugins import their host only through the API, a version in the path:

```ts
// src/api/v1/index.ts: "@app/api/v1", for every kind
export { defineRegistry, local, obj, remote, str } from "@earendil-works/chord";   // the Chord surface the app supports
export { defineFacet, Project, Server } from "../../core.ts";                           // bound to the app's principal
// src/api/v1/web.ts: "@app/api/v1/web", for pages only
export const Panels = defineRegistry<Panel, readonly Panel[]>("app.panels", { version: 1 });
```

The app lists the versions it provides, newest first (`api: { name: "@app/api", versions: ["v2", "v1"] }`), and each
kind's modules in `kinds.<kind>.hostPackages`. When the app changes its API in a way that breaks plugins, it adds
`/v2` and keeps `/v1` as a thin layer over it for a while; once `/v1` goes, a plugin importing it fails to build with
"@app/api/v1 is not available: this app provides v2", the plugin alone, the message saying what to change. One facet
uses one version. Contracts the app promises others are re-exported in the API (`export { Notes } from
"../../plugins/notes/contract.ts"`), so a plugin built against `/v1` keeps v1's contract files.

## Plugins the app ships

An app comes with plugins of its own. They follow the same rules as anyone's, in a root inside the app, next to the
root where users and agents add theirs:

```ts
const plugins = createPlugins({
	roots: [{ path: "./plugins", required: true }, join(dataDir, "plugins")],   // the app's own, then the user's
	api: { name: "@app/api", versions: ["v1"] },
	kinds,
	onError,
}, ctx);
```

They are built at startup like any plugin (a quarter of a second for twenty), reload like any plugin, and are left out
alone when broken at a reload. The app's root is **required**: a plugin of it failing at startup makes
`plugins.load` reject with a `PluginError` naming it (after the load settled), so the app stops instead of running
without its core. A failure in the user's root is reported and the app runs on. If two roots have a plugin with the
same name, the first root wins, and the other is reported.

## Small plugins, installed plugins, tested plugins

- **A single file** at a root's top is a plugin: `plugins/hello.server.ts` and `plugins/hello.web.tsx` are the plugin
  `hello` with two facets. It has no `package.json` and imports only the API; when it needs a second file or a
  package, it becomes the directory `hello/`, which a reload treats as the same plugin.
- **Installing** from git or npm: `plugins.installPlugin({ git: url, ref }, root, ctx)` clones the ref (a branch, tag
  or commit) into the root, `{ npm: name, version }` extracts the package; then its dependencies are installed. Removal
  is deleting the directory.
- **Testing** a plugin alone: `testPlugin("./plugins/stats", { kind: "worker", api, modules, stubs }, ctx)` builds it
  as production does, loads it on an in-memory host beside stub facets serving what it uses, collects what it
  contributes to registries nobody serves, and lists the contracts it waits for (`docs/plugin-authoring.md`).

# The App Kit {#kit lede="startServer and startWorker: the hosts, stores, sign-in, files and plugin roots every app needs, so an app is its API, its plugins and a start script."}

The chapters so far wired an app by hand: a store, a host, `createHttp`, `createWorkers`, `createPlugins`, an
authenticator, a worker entry connecting to its parent. Every app needs the same wiring, and most of it has one right
answer. The **app kit** (`chord/app`) is that answer, opinionated on purpose: one data directory layout, one way
to sign in, one place for files.

## A whole app

The notes app of example 53 is four files of base code and two plugins:

```ts
// start.ts
const app = await startServer<NotesPrincipal>({
	name: "notes",                                  // the data directory: ~/.notes unless dataDir says otherwise
	root: "./plugins",                              // the app's own plugins: a required root
	api: { name: "@notes/app", versions: ["v1"], modules: { "@notes/app/v1": v1, "@notes/app/v1/server": v1server } },
	kinds: { server: { platform: "node" }, worker: { platform: "node" } },
	principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", project: address.key }) },
	workers: [{
		kind: Project,                              // one worker per project
		entry: "./worker.ts",
		start: (address) => ({ project: address.key }),
		authorize: (principal) => principal.kind === "owner" || principal.kind === "server",
	}],
	onError: (error) => log(error),
}, ctx);
console.log(`Open ${app.ownerLink()}`);

// worker.ts
startWorker({ api: API, kinds: KINDS, onError: (error) => log(error) });
```

`startServer` creates the data directory (`server/store.sqlite`, `workers/<kind>/<address>/`, `plugins/`, `logs/`,
`owner-token`), opens the server's store, creates the server host, HTTP, a workers component per worker kind and the
plugins component over two roots: the app's `plugins/` and the user's `<dataDir>/plugins/`. Then it loads the server's
plugins with the kit's own facets beside them and resolves. `startWorker` does the worker's half: the project's
directory and store, the host at the project's address, the link to the server first, the worker's plugins.

## What plugins get from the kit

Plugins still import only the app's API; the API re-exports the kit's objects it offers:

- `AppInfo` on the server (data directory, app name, API version) and `WorkerInfo` on workers (the address and the
  start data `start(address)` made): the **start-data objects**. Process values reach plugins only through them.
- `Files`, one per host: `put` for small files, `begin`, `append` and `finish` for large ones, ranged `read`, `remove`
  and a watchable `list`, stored in the host's directory with caps per host.
- `Sessions` on the server: `issue`, `revoke`, `list`.

This finishes what the previous chapter started. Base code is the API, the start script and the worker's entry. The
providers of the app's own registries live in its required root: example 53's API declares a `Sections` registry, and
its home plugin serves it and reads `AppInfo`, so it reloads like any other plugin.

## Who may come in

HTTP **denies by default**: a request without a principal gets 401 before any plugin code runs, unless the route says
`public: true`. Someone gets a principal through a **session**: a random token, kept in the store only as a hash, sent
as a signed cookie by a browser or as `Authorization: Bearer` by a command-line client.

The first session is the owner's. At each start the kit makes a one-time **owner link**,
`http://127.0.0.1:8788/_chord/owner#<token>`, valid ten minutes; the start script prints it. The token is in the
fragment, which browsers never send, so it never reaches a log: the page posts it, the kit consumes it and sets the
owner's cookie. A command-line client on the same machine reads `<dataDir>/owner-token` (mode 0600). One on another
machine **pairs**: it asks for a code, the owner approves the code in a signed-in browser, and the client's next poll
returns its token (example 54).

Users other than the owner come from optional plugins the app adds: `defineUsers(profile)` for accounts,
`inviteFacet()` for invite links, `ephemeralLoginFacet()` for "pick a name and you're in".

## Applying changes, moving projects

The kit never reloads by itself. An edit or an install marks plugins dirty; `app.plugins.state` drives the app's
"apply changes" button, and `app.applyChanges(ctx)` builds and rolls out to the server, then the workers.

A project's data is what its worker created: its store and its files. `app.exportData(Project({ id }), path, ctx)`
writes them as one archive (a manifest, the store's export, the files) and stops nothing: a running worker writes its
own store at one consistent point. `app.importData(path, Project({ id: "copy" }), ctx)` makes a new project from it and
refuses one that already has data (example 55).

# Seeing a Request Across Hosts {#telemetry lede="One trace from a click in a client through the server's relay into a worker's method: adapters, carriers and spans."}

A tab calls `notes.add(…)`. The call leaves the tab, the server relays it, the project's worker runs the method, the
method commits. When it is slow, where did the time go? Each host is a different process, so no single log has the
answer. Chord's telemetry makes the four steps one **trace**: a tree of **spans** (named, timed pieces of work), each
host recording its own with its own **adapter**, joined by **carriers** (a few strings naming the caller's span) that
ride on the wire with every `hold` and `call`.

Give the server a store and the kit does the rest. The SQLite store (`@earendil-works/chord/telemetry-sqlite`)
records settled spans and metrics in one file in the data directory, and the server is its only writer: every worker
records in memory and sends its spans and metrics to the server once a second over its link, and a page that records
(`startPage({ telemetry: true })`) sends its own every few seconds and when hidden (example 62):

```ts
// start.ts: the server, its store, and whom spans were for (default: the principal's key)
const telemetry = await createSqliteTelemetry(await openNodeSqliteDatabase(join(dataDir, "telemetry.sqlite")));
await startServer({ ...options, telemetry, principalAttributes: (p) => ({ "chord.principal": p.kind }) }, ctx);
// worker.ts: nothing about telemetry (its own `principalAttributes`, if any)
startWorker({ api, kinds, onError });
// the web entry: the page records
startPage({ ...options, telemetry: true });
```

A page is untrusted: the server checks each batch's every field (sizes, no control characters, ids printable ASCII),
keeps only spans under the page's own ids, caps them per page and minute, marks them `chord.host: browser` and stamps
them with the principal of their link. A click is a trace of its own with `host.root(fn, ctx, { trace: { name } })`.

Nothing else changes in plugin code. A method's `ctx.telemetry` is its `chord.method` span, so whatever it calls or
commits is parented under it, on its host or the next one. `ctx.trace(name, attributes, fn)` adds a span of your own:

```ts
add: async (n, ctx) => {
	await ctx.trace("tally.check", { n }, async () => {
		if (!Number.isSafeInteger(n) || n <= 0) throw new Error("add a positive count");
	});
	return store.add(n, ctx);
},
```

The store renders the click's trace across the three hosts (the client's spans, the server's relay, the worker's
methods and the commit, an event of the method that made it); every span of Chord names the host that recorded it
(`chord.host`: its address key, `client` without an address), and method and call spans whom they were for
(`chord.principal`, the host's `principalAttributes` hook):

```
tally.click
  chord.hold chord.host="client" type="tally.counter" object="tally.counter(t1)" address.kind="tally" outcome="bound"
    chord.relay chord.host="server" type="tally.counter" member="hold" upstream.kind="tally" outcome="ok"
      → link to chord.resolve
  chord.call chord.host="client" type="tally.counter" member="add" object="tally.counter(t1)" address.kind="tally" outcome="ok"
    chord.relay chord.host="server" type="tally.counter" member="#0" upstream.kind="tally" outcome="ok"
      chord.method chord.host="tally|t1" type="tally.counter" member="add" object="tally.counter(t1)" principal.kind="owner" chord.principal="{\"kind\":\"owner\"}" outcome="ok"
        tally.check chord.host="tally|t1" n=3
        chord.method chord.host="tally|t1" type="tally.store" member="add" object="tally.store" principal.kind="worker" chord.principal="{\"kind\":\"worker\",\"tally\":\"tally|t1\"}" outcome="ok"
          · chord.commit documents=1 ops=1 rows=0 duration=1.9
```

Work shared by several requests is its own trace, linked rather than nested: the worker's start (`chord.resolve`),
an object's activation (`chord.activate`, linked to whoever asked first). Routines and job phases are roots too; a job's
`run` and `finish` stay under the carrier its start stored, even when a restarted worker resumes the run. Metrics
(`chord.link.bytes`, `chord.commit.duration`, `chord.calls.in_flight`, ...) are aggregated per 10 s; ids are never their
attributes. Without an adapter (the default), Chord starts no span and sends no carrier: a call costs what it did before.
A script or a viewer reads the file with `openTelemetryStore(path)` (`@earendil-works/chord/telemetry-sqlite/node`),
which opens it read-only and offers only the read interface (`findTraces`, `getTrace`, `findMetrics`).

# Reference {.appendix}

| Call | What it does |
| --- | --- |
| `createHost<P>({ address?, principal?, store?, onError })` | a host: addressable with an address, else a client |
| `host.load([{ name, facet }], ctx)` / `host.reload(...)` | publish facets / apply a new plugin set |
| `host.get(Type, params, ctx)` / `host.hold(...)` | a live reference / a reference at once that follows its object |
| `local(name, { version, params, members })` / `remote(name, { version, params, hostAddress, variants })` | contracts |
| `defineFacet((host, self) => …)`, `host.serve(Type, factory)`, `self.contribute(R, value)` | a facet |
| factory `self`: `state`, `derive`, `get`, `registry`, `open`, `on`, `onLive`, `job`, `tx` | an object's parts |
| `createPlugins({ roots, api, kinds, onError }, ctx)` | the plugins component |
| `plugins.load(host, { kind, core, modules }, ctx)`, `build(names)`, `rollout(steps, built)` | load, build, roll out |
| `plugins.installPlugin(source, root, ctx)`, `testPlugin(dir, options, ctx)` | install a plugin, test one alone |
| `hostKind(name, params?)`, `Kind(params)` | host kinds and addresses |
| `startServer<P>({ name, dataDir?, root?, listen?, api, kinds, principal, workers?, files?, onError }, ctx)` | an app's server, with the kit |
| `startWorker({ api, kinds, busy?, onError })` | a worker's entry, with the kit |
| `app.ownerLink()`, `app.applyChanges(ctx)`, `app.plugins.install(source, ctx)` | sign in, apply changes, install |
| `app.exportData(address, path, ctx)`, `app.importData(path, address, ctx)` | move a worker's data |
| `AppInfo`, `WorkerInfo`, `Files`, `Sessions` | the kit's objects plugins get |
