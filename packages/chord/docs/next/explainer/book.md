---
title: Chord v2: a guide to building apps that reload
cover: Chord v2 / A Guide
kicker: A guide · Chord v2 target design · 2026-10-20
subtitle: How to build an app like p2 from nothing on Chord v2 and pi-durable, one object at a time, so that new plugin code takes over while the agent keeps running
stats:
  - 11 | layers in the rebuild, L1 to L11
  - ~1,300 | lines built so far (L1 contracts)
  - 6–7k | target size of Chord v2, without tests
  - 0.004 ms | Delta's apply per small change
note: |
  This guide teaches the **designed** API of Chord v2 (`packages/chord/src/next`, export `@earendil-works/chord/next`)
  from `packages/chord/docs/next/design.md` and the newer decision log `packages/chord/docs/next/decisions.md`, which wins
  where the two differ. Most of it is **not built yet**: a first kernel of about 10k lines is frozen as a reference and
  Chord v2 is being rebuilt layer by layer; only the L1 contract layer exists (`src/next/contracts/`, commit
  `7d2bb8ea8`). Code in this guide is therefore the target, not something you can run today. Every chapter says what is
  built. API names are working names. Notes marked *review* are points that are undecided, or where the sources
  disagree; they name the files. The reader is assumed to know pi-durable; Chord is explained from the start.
colophon: Chord v2 · a guide · first edition · 2026-10-20 · based on design.md (target design v2), redesign-decisions.md (review rounds 2 and 3), chord-next-walkthrough.md, layer-1.md, contracts/README.md, the p3 functionality map, questions.md and the pi-durable README
---

# Before we begin {.preface}

It is late in the evening. Mario is on his phone, connected to his laptop at home through the Radius relay. In session
S1 the agent is twenty minutes into a refactoring; right now it is running a test suite through `bash`. A colleague,
Ann, follows the session read-only from her own browser. Mario notices that the notes panel sorts notes the wrong way
round. He fixes one line in the notes plugin on the laptop and presses **Reload**.

What should happen is easy to say. The notes panel on both screens shows the new order. The test run keeps running. The
agent's turn continues as if nothing happened. Ann's view does not flicker into an error. Nothing that was written is
lost, and no process restarts.

The obvious ways to get there fail. **Restarting the processes** loses the turn in flight, the open terminal and every
connection; pi-durable would resume the turn, but the test run and the connections are gone. **Hot-swapping modules**
in place, as front-end tooling does, leaves the old code alive in closures, timers, event listeners and sockets that
nobody knows about: the old sort function keeps running inside a callback someone stored, a file watcher opened by the
old code is never closed, and two versions of the plugin now write the same data without any order.

Chord v2 is the runtime that makes the first outcome normal. It does so by being strict about one thing: **every piece
of state, every open OS handle and every piece of running work has exactly one owner, an object, and objects only
declare what they need.** Chord itself activates, connects, reloads and ends them. Because Chord knows every timer,
watcher, transaction and reference an object has, it can swap the object's code while its data stays, restart only
what touches the operating system, and route calls between browser tabs, the server and per-session worker processes
without the plugin author writing any of that.

This guide teaches Chord v2 by building an app called **Studio**: a small version of p2 (Pi Mobile), with a server,
one worker process per session, browser tabs as clients, and an agent from pi-durable on each worker. The first
chapters grow one plugin, `@studio/notes`, until it uses every concept; the last three chapters assemble the rest of a
p2-like app from the same parts.

:::review | Review: what exists today
Nothing in this guide runs yet except the contract layer. `packages/chord/src/next/contracts/` (L1 part 1: `remote`,
`local`, `method`, `evolve`, `checkAccepts`, the schema helpers) is built and reviewed. The rest of L1 (inputs,
argument checks, principals, errors) is a draft spec (`packages/chord/docs/next/layer-1.md`). The frozen kernel in
`src/next/*.ts` implements an older version of the design (host values, a development freeze, JSONL storage,
descriptions on the wire); do not read it as the target. Build on the design, not on the frozen code.
:::

## Ten things to know

:::findings
1. **An app is a tree of hosts.** One server, any number of workers it starts on demand, any number of clients (tabs,
   TUIs) that connect to it. Clients reach workers only through the server, which relays.
2. **Objects are the unit of everything.** An object type is a contract (name, input, placement, members, version); an
   object is one instance per input and caller. The first `get` creates it, later gets share it, the last release ends
   it.
3. **Factories declare, Chord activates.** A factory is synchronous: it declares documents, references, derived
   values, OS handles, routines and jobs through `self`, and returns the members. Chord opens, binds and starts them,
   and undoes them in reverse.
4. **Links stamp who is calling.** A caller's data never says who it is; the link it arrived on does. Each caller gets
   its own object and the variant of members it may use.
5. **Shared data lives once, behind views.** A `local` shared store holds the data; per-caller `remote` views expose
   what each caller may see. Only stable identities persist documents.
6. **State changes only in transactions.** Documents are JSON values written in `self.tx`; commits are atomic for
   every viewer and travel as small operations, never as whole values.
7. **Failures look like disconnects.** A reference survives link drops, restarts and failures: calls park or fail,
   values stay readable, and Chord retries by itself. There are no request ids.
8. **Everything long-lived has a declared form.** Standing behaviour is a routine, work that outlives a call is a job,
   input from a person is a flow, behaviour from other plugins comes through a registry. Nothing else may hold a timer
   or a callback.
9. **Reload swaps pure objects in place and restarts native ones.** Objects without OS handles get the new code with
   their data and running work intact; objects with OS handles close and reopen them. A broken change leaves the whole
   host on its old code.
10. **pi-durable runs inside a core object.** The agent harness is a host-lifetime object on each worker; models,
    environments and tools reach it through registries, and tools reach Chord through `chord(fn, context)`.
:::

## Words used throughout

A **host** is one participant of the app: a process, a browser tab or a Durable Object, identified by a logical
identity and an **incarnation** that changes on every start. A **link** connects two hosts. The **server** is the one
addressable root host; a **worker** is a host the server starts for one session; a **client** is a tab or TUI, not
addressable. A **plugin** is a directory with a `package.json`; its code for one kind of host is a **facet**. **Base
code** is the app's own code (Chord calls its facet the core facet); it restarts the hosts when it changes, while
plugins reload. An **object type** (or **contract**) describes objects; an **object** is one instance; its **input** is
its key among objects of that type, and its **placement** computes from the input on which host it lives. A **factory** builds an
object; **`self`** is what a factory declares through. A **principal** is who calls, stamped by the link; a
**variant** is the set of members a principal gets. A **reference** is what `get` returns. A **readable** is a value
plus its ordered changes. A **document** is a named JSON value an object owns, written in a **transaction**. A
**derive** is a value computed from readables. A **native** is an OS-level value (a socket, a watcher, a process)
opened with `self.open`; an object with natives is a **native object**, one without is a **pure object**. A
**routine** is standing behaviour, a **job** is owned work that outlives its call, a **flow** is input into running
work. A **registry** is an owner's extension point, filled with **contributions**. **`ctx`** is what every call
receives: cancellation, caller, call-scoped references. A **reload** swaps a plugin's code inside running hosts; a
**restart** ends a process; a **revision** names the complete code set the hosts run.

:::note | Reading the code in this guide
Imports are shown once per file and then omitted. `obj`, `str`, `arr` and friends are Chord's schema helpers (they
return ordinary TypeBox schemas). Helper functions that belong to the app (`authenticate`, `watchDir`, `uuidv7`) are
named and not shown. Where the design gives no name, the guide says it uses a working name.
:::

# The Shape of an App {#shape lede="Which processes a Chord app has, how they find each other, and the start code that connects them."}

Before any plugin exists, Studio needs processes and connections between them. In Chord each participant is a host,
and the app's own start code creates every host, connects them and decides how workers start. Chord deliberately does
none of that itself: a laptop app forks child processes, a test runs everything in one process, a Cloudflare
deployment routes through the edge. This chapter writes Studio's start code: `server.ts`, `worker.ts`, the browser
entry, and a test setup.

## Three roles

A Node app on Chord has one shape:

:::flow wide | The three roles. Clients connect to the one server; the server starts workers and relays between them.
row "Clients: not addressable" muted
box tab1 "browser tab" "owner, local"
box tab2 "browser tab" "guest Ann"
box tui "TUI" "owner"
row "Server: exactly one" accent
gap
box server "server" "`Server()`" accent
gap
row "Workers: one per session, on demand" blue
box w1 "worker" "`Session({ id: \"S1\" })`" blue
box w2 "worker" "`Session({ id: \"S2\" })`" blue
box w3 "worker" "`Session({ id: \"S3\" })`" dashed
arrow tab1 -> server "WebSocket"
arrow tab2 -> server "WebSocket"
arrow tui -> server "WebSocket"
arrow server -> w1 "IPC"
arrow server -> w2 "IPC"
note "A worker for S3 does not exist until something asks for an object that lives there."
:::

| Role | Addressable | Who it is comes from | Lifecycle |
| --- | --- | --- | --- |
| client | no | the authentication of its link | connects by itself |
| server | yes, exactly one | its own declaration | runs |
| worker | yes, many, by a typed address | stamped by the server, its parent | started on demand by the app |

The **server** holds what all sessions share (the session list, access, settings) and starts workers. A **worker**
runs one session: its agent, its files, its terminal connections. **Clients** are browser tabs and TUIs. Nobody can
send a request *to* a client, so a client can only serve objects that nobody outside it needs; chapter IV names them
`local` types.

Things that look like hosts but are not: a code mode sandbox (a worker thread inside a worker, owned by an object), a
remote environment's daemon (it speaks its own protocol, owned by an object), the TUI's sandbox behind its launcher.
A detached process such as a terminal host could become another kind of child of the server.

## Host kinds and addresses

Every addressable host has a typed address. The app declares its **host kinds** once, in base code:

```ts
// studio/src/hosts.ts
import { hostKind, obj, str } from "@earendil-works/chord/next";

export const Server = hostKind("server");
export const Session = hostKind("session", obj({ id: str() }));

Server();                  // the address of the server
Session({ id: "S1" });     // the address of the worker of session S1
```

There are no host-name strings anywhere in app code. Chord serializes addresses internally; your code only calls the
kinds. An object type names its host with a placement function from its input to an address (chapter II), so the
type checker knows that `Session({ id: session })` needs a `session` field.

## Links

A **link** is an ordered, two-way channel of messages between two hosts; it only delivers. Chord ships three: a memory
pair for tests, IPC for a Node child process forked with `serialization: "advanced"`, and WebSocket. All three carry
the same binary message format and the same flow control (chapter XVII). Recovery policy belongs to the link adapter:
IPC needs no heartbeat, a WebSocket through a relay needs one, because TCP does not notice that a laptop went to sleep.

Each link has a **direction**. A host has at most one link to its parent (`connect`) and any number of links from
below (`accept` for clients, `route` for workers). Requests arriving on a link act as the principal the link was given;
chapter III explains why that matters.

## The server

```ts
// studio/src/server.ts
import { createHost, ipcLink, webSocketLink } from "@earendil-works/chord/next";
import { fork } from "node:child_process";
import { WebSocketServer } from "ws";
import { Server, Session } from "./hosts.ts";
import { coreServerFacet } from "./core/server.ts";
import type { P } from "./principal.ts";

const server = createHost<P>({
  address: Server(),
  principal: { kind: "server" },                 // who this host's own code acts as
  storage: await openServerStorage(dataDir),     // persisted documents (chapter V); memory if omitted
  onError: (e) => { if (e.kind === "storage_failed") process.exit(75); else log(e); },
});

await server.load([
  { name: "@studio/core", facet: coreServerFacet(config) },   // base code, under a fixed name
  ...(await loadPlugins("server")),                           // [{ name, facet }] from the plugin loader
]);

const wss = new WebSocketServer({ server: http, path: "/chord", maxPayload: 64 * 1024 * 1024 });
wss.on("connection", (ws, req) => {
  const principal = authenticate(req);           // app code: cookie, loopback, device token
  if (!principal) return ws.close(4401);
  server.accept(webSocketLink(ws), { principal });
});

server.route(Session, {
  authorize: (p, { id }) =>
    p.kind === "owner" || p.kind === "server" || (p.kind === "guest" && p.session === id),
  resolve: async ({ id }, { signal }) => {
    const principal: P = { kind: "worker", session: id };
    const child = fork("worker.ts", [], { serialization: "advanced", signal });
    child.send({ id, principal, init: await initFor(id, signal) });   // the app's own start message
    return { link: ipcLink(child), principal };                       // Chord stamps `principal` on it
  },
});
```

Each call has one job:

| Call | Meaning |
| --- | --- |
| `createHost<P>({ address?, principal?, ...options })` | with an address: an addressable host whose own code acts as `principal`; without: a client. `P` is the app's principal type |
| `load([{ name, facet }])` | the facets this host runs, each with its plugin's `package.json` name; duplicates and invalid names are refused. Base code passes its core facet the same way |
| `accept(link, { principal })` | a link from a client; every request on it acts as `principal` |
| `route(Kind, { authorize, resolve })` | how to reach hosts of a kind. `authorize(principal, address)` runs before anything starts; `resolve(address, { signal })` returns `{ link, principal }` |
| `connect(link, { principal })` | the link to the parent, at most one, replaced after a reconnect; `principal` says who the parent is |
| `root(fn, { principal?, signal? })` | a call scope for code outside objects (a CLI command): gives `fn` a `ctx` (chapter VI) |

Chord has no `listen`. Entry points differ too much: a loopback WebSocket server, a tunnel, the Radius relay
delivering channels, a Durable Object edge, a memory link in a test. Each entry point authenticates and calls
`accept`. Radius, for example, is one more line:

```ts
radius.onChannel((ws) =>
  server.accept(webSocketLink(ws), { principal: { kind: "owner", access: "relay" } }));
```

## The worker

```ts
// studio/src/worker.ts
const { id, principal, init } = await startMessage(process);       // app code: the first IPC message
const worker = createHost<P>({
  address: Session({ id }),
  principal,                                                       // { kind: "worker", session: id }
  storage: await openSessionStorage(init.dataDir, id),             // one storage per session
});
await worker.load([
  { name: "@studio/core", facet: coreWorkerFacet(init) },          // serves the start data (chapter IX)
  ...(await loadPlugins("worker")),
]);
worker.connect(ipcLink(process), { principal: { kind: "server" } });
```

## A browser tab

```ts
// studio/web/main.tsx
const client = createHost<P>();                                    // no address: a client
await client.load(await loadPlugins("web"));
client.connect(webSocketLink(new WebSocket("/chord")), { principal: { kind: "server" } });
const notes = await client.get(Notes, { session: "S1" });          // tab → server → worker S1
```

## The first `get`, step by step

The tab asks for the notes of S1. No worker for S1 runs yet.

:::sequence animate | The first get for an object on a worker that is not running. The server authorizes, the app starts the worker, Chord stamps the link.
actor tab "browser tab" "owner"
actor server "server" accent
actor app "route(Session)" "app code" muted
actor worker "worker S1" blue
tab -> tab: placement: Session({ id: "S1" })
tab -> server: hold Notes { session: "S1" }
server -> server: not mine: route(Session)
server -> app: authorize(owner, { id: "S1" })
app --> server: true
server => app: resolve({ id: "S1" })
app -> worker: fork + start message
worker -> worker: createHost, load, connect
app --> server: { link, principal: worker S1 }
server => worker: hold (stamped: owner)
worker -> worker: placement check, run factory
worker --> server: bound: snapshot
server --> tab: bound: snapshot
:::

`resolve` runs once per address while its link lives. When the link drops (the worker crashed or the supervisor
stopped it) and references to that worker still exist, Chord calls `resolve` again by itself, with a per-address
backoff, so a tab that only watches recovers without a click. A worker start that already produced a link finishes
even if the request that triggered it went away.

**Incarnations** make restarts visible. Chord mints a fresh id (a uuidv7) on every host start and sends it in the link
handshake; the other side sees a restart as a new incarnation of the same identity, and references to it re-hold
(chapter VI).

## Tests: everything in one process

The same code runs in a test with memory links. `resolve` builds the worker host in memory and returns one end of the
pair:

```ts
server.route(Session, {
  authorize: () => true,
  resolve: async ({ id }) => {
    const [up, down] = memoryLinkPair();
    const principal: P = { kind: "worker", session: id };
    const worker = createHost<P>({ address: Session({ id }), principal });
    await worker.load([{ name: "@studio/core", facet: coreWorkerFacet({ id, dataDir }) }, notesWorker]);
    worker.connect(up, { principal: { kind: "server" } });
    return { link: down, principal };
  },
});
```

Memory links deliver the same encoded messages asynchronously, so a test runs the production protocol path.

## What stays app code

Starting processes, the start message, authentication, supervising and stopping idle workers are app code. Chord
provides one readable for the last one: `host.activity`, with `{ references, calls, jobs, lingering }` (viewers, calls
in flight, unsettled jobs, objects kept warm after their last reference). Studio's core reports it to the server
together with the agent's running tasks, and the server's supervisor stops a worker when everything has been zero for
five minutes, as p2 does. Chord counts; it has no idle policy.

## Host options and timeouts

`createHost` takes the options introduced later in this guide: `storage` (V), `principalKey` and `revokedBy` (III,
VII), `telemetry` (XVII) and `onError`. `onError` receives background errors and `{ kind: "storage_failed" }`; every
app must handle the latter, because Chord never ends the process. Studio exits with its own code so its supervisor
restarts it.

Timeouts are host defaults with per-thing overrides; the full table is in the appendix. The two you meet first:
`readyTimeout` (60 s: how long an activation and an awaited `get` wait) and the park deadline (60 s: how long a call
waits through a link drop or a restart before failing `unavailable`).

:::note | Built so far
Nothing in this chapter is built in Chord v2 yet: hosts, links and routes are layers L6 and L7. The frozen kernel has
working versions with the same shape (`createHost`, `connect`, `accept`, `route`, `load`), which the rebuild
simplifies.
:::

# A First Object {#first-object lede="A plugin, a contract, a factory, and a browser tab that calls it on another process."}

Studio's first feature is session notes: a list of short notes per session, shown in a panel, that anyone allowed can
add to. Several places need "the notes of S1": the owner's tab, a guest's tab, later a download route and an agent
tool. If each built its own copy, the copies would drift apart and nobody would know when to clean them up. In Chord
there is **one object** for "the notes of S1", everyone asks for it by its type and input, and Chord routes them all to it.

## The plugin's files

A plugin is a directory with a `package.json`. Its `name` (npm style, globally unique and stable) is the plugin's
identity: Chord finds its stored documents, reports its errors and orders its contributions by it, never by a
directory name or load order.

| File | Runs on | Holds |
| --- | --- | --- |
| `package.json` | read by the loader | `"name": "@studio/notes"` |
| `contract.ts` | every host that imports it | object types: names, shapes, method signatures; no running code |
| `worker.ts` | every session worker | the worker facet |
| `server.ts` | the server | the server facet (later: the download route) |
| `web.tsx` | browser tabs | the web facet: the panel |

## The contract

An object type is a contract: a name, an **input** (the object's key among objects of this type), a **placement**
(on which host it lives, computed from the input), the **members** (state you can read and methods you can call) and a **version**.

```ts
// notes/contract.ts
import { arr, int, method, obj, remote, str, type Static } from "@earendil-works/chord/next";
import { Session } from "@studio/core/hosts";

export const Note = obj({ id: str(), text: str({ max: 2000 }), by: str(), at: int() });
export type Note = Static<typeof Note>;

export const Notes = remote("notes", {
  version: 1,
  input: obj({ session: str() }),                          // the key: { session: "S1" }
  placement: ({ session }) => Session({ id: session }),    // input → the host's address
  variants: {
    editor: {
      state: { notes: obj({ items: arr(Note) }) },
      methods: {
        add: method(obj({ text: str({ min: 1, max: 2000 }) }), str()),   // returns the new id
        remove: method(obj({ id: str() })),                              // no result
      },
    },
  },
});
```

`remote` means objects of this type can be reached from any host, across links (chapter IV introduces `local`). The
schema helpers (`obj`, `str`, `int`, `arr`, `map`, `opt`, `lit`, `oneOf`, `union`, `bool`, `num`, `nul`, `bytes`,
`unknown`) return ordinary TypeBox schemas; short options such as `{ min, max }` bound lengths or values. Schemas must
describe data: no callbacks, no class instances, no custom codecs.

`method()` has four forms: `method()` (no arguments, no result), `method(args)`, `method(args, result)` and
`method(undefined, result)`.

A contract contains no code that runs, so every host can import it. When you declare it, Chord materializes its
description and computes a **fingerprint**, a hash of its input, variants and members. Two hosts compare contracts by
version and fingerprint (chapter XVI). Placement is not part of the fingerprint.

## Placement

The input says *which* object; `placement` says *where* it lives. The caller runs the placement function on the input and sends the resulting address with its request; the server
routes by it. The provider runs the function too and refuses an object that is not its own with `invalid/placement`.
So a worker for S2 never builds "Notes for S1", even if a caller has an outdated rule. Because placement is a typed
function, a `Session` placement on a type whose input has no `session` field does not compile.

Inputs are **normalized** before anything else: defaults are applied, unknown fields removed, and a canonical key
computed. `{ session: "S1" }` and `{ session: "S1", extra: 1 }` are the same object.

## The facet and the factory

A **facet** is a plugin's setup for one kind of host. It runs once when the plugin loads on that host and tells the
host which object types it serves:

```ts
// notes/worker.ts
import { defineState } from "@earendil-works/chord/next";
import { defineFacet } from "@studio/core";          // Studio's defineFacet: principals typed as Studio's P (chapter III)
import { Note, Notes } from "./contract.ts";

const NoteList = defineState("notes.list", {      // a document (chapter V); in memory for now
  schema: obj({ items: arr(Note) }),
  version: 1,
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

export default defineFacet((host, self) => {
  host.serve(Notes, ({ session }, principal, self) => {
    const list = self.state(NoteList);            // THE note list of this object
    return {
      variant: "editor",
      notes: list,                                // a document handle is a readable: expose it as state
      add: ({ text }, ctx) =>
        self.tx(async (tx) => {
          const id = uuidv7();
          (await tx.draft(list)).items.push({ id, text, by: "someone", at: Date.now() });
          return id;
        }, ctx),
      remove: ({ id }, ctx) =>
        list.change((d) => { d.items = d.items.filter((n) => n.id !== id); }, ctx),
    };
  });
});
```

Read `host.serve(Notes, factory)` as "this host builds `Notes` objects like this". The factory receives the
normalized input, the caller's principal (chapter III) and `self`, through which it declares what the object needs.
It returns the members of one variant, tagged with `variant`.

**Factories declare; Chord activates.** The factory is synchronous and has no side effects. It does not await, open
files or start timers. `self.state(NoteList)` does not load anything: it declares that the object has this document
and returns a **handle** that stays valid for the object's whole life. Chord then performs the activation: it loads the
document, binds references, opens OS handles, starts routines, and only then lets calls in. The rule exists for
reload: a reload runs the factory again, and anything the factory did itself would happen twice.

## Calling it

```tsx
// notes/web.tsx
export function NotesPanel({ session }: { session: string }) {
  const notes = useRef(Notes, { session });                 // app-side hook over host.get / release
  const items = useReadable(notes?.notes)?.items ?? [];
  return (
    <section>
      {items.map((n) => <p key={n.id}>{n.text}</p>)}
      <AddBox onAdd={(text) => notes?.add({ text })} />
    </section>
  );
}
```

Underneath the hooks is the reference API:

```ts
const notes = await client.get(Notes, { session: "S1" });   // live and hydrated once awaited
notes.notes.value.items;                                    // the current list
notes.notes.subscribe((v) => render(v.items));              // every committed change
const id = await notes.add({ text: "check the flaky test" });
notes.release();                                            // the object may end now
```

An awaited reference is **live and hydrated**: every state member has a value. State members are **readables**:
`.value` is the current value, `subscribe` is called after every commit. The first `get` for `{ session: "S1" }` runs
the factory; every later `get` for the same input and caller shares that object. The object ends when the last
reference is released (a type may keep it a little longer with `linger`).

:::sequence animate | A call to add. Arguments are checked once at the provider; the commit reaches the viewer as one small change.
actor tab "browser tab"
actor server "server" muted
actor worker "worker S1" blue
actor obj "Notes { S1 }" accent
tab -> server: call add { text }
server -> worker: relay (header only)
worker -> obj: strip + validate args
obj => obj: self.tx: push note, commit
obj --> worker: result: id
worker --> server: state: ops of the commit
worker --> server: result
server --> tab: state, then result
:::

## Two rules for members

**Methods return data, never objects.** A method that wants to point you to another object returns its address
(`{ session: "S2" }`), and you `get` it yourself. That keeps every reference owned by someone who releases it.

**No callbacks as arguments.** A callback carries code, and everything it closes over, from one object into another.
Suppose an inbox object passed `onFile` to another object, which stored it. After a reload of the inbox's plugin, the
other object still calls the *old* `onFile`; after the inbox ends, it calls into an object whose file watcher is
already closed. Chord forbids this by construction: members are data (JSON plus bytes). Behaviour from elsewhere goes
through registries (chapter XIII), multi-step work through jobs (XI), input from a person through flows (XII).

## What is wrong with this version

This first version works for one person. It has two problems, which the next two chapters fix. Everyone gets the
`editor` variant, including a read-only guest. And, less obvious, the owner and a guest do not see the same notes: as
chapter III shows, a remote object exists per caller, so each caller's `Notes` object has its own `NoteList`.

:::note | Built so far
`remote`, `method`, the schema helpers, `Static` and fingerprints are built (`src/next/contracts/`). Serving, `get`,
references and documents are layers L3 to L5.
:::

# Who Is Calling {#principals lede="Principals: how Chord knows who calls, why a caller cannot lie about it, and how the answer picks the object and its members."}

The owner may add and remove notes. Ann, a read-only guest, may only read them and should not even see who wrote
what. The object must therefore know who is calling, and the caller must not be able to claim to be someone else. In
Chord the answer is a **principal**, a small JSON value the app defines and the links stamp.

## The app's principal type

Chord defines no principal kinds; the app does. Every variant has a `kind`. Studio uses p2's set:

```ts
// studio/src/principal.ts
export type P =
  | { kind: "owner"; access: "local" | "relay" | "device"; device?: string }
  | { kind: "guest"; session: string; mode: "read" | "write"; grant: string; revision: number }
  | { kind: "server" }
  | { kind: "worker"; session: string };
```

| `kind` | Who |
| --- | --- |
| `owner` | the person running the app, on loopback, through the relay, or on a paired device |
| `guest` | someone invited into one session, with a mode and the grant (and its revision) that let them in |
| `server` | the server's own code calling a worker |
| `worker` | a session worker calling the server |

## Links stamp principals

A principal never comes from a request's data. The server authenticates a client once, when its WebSocket connects,
and stamps the result on the whole link (`server.accept(link, { principal })`). The server tells Chord who each worker
is when it resolves it (`return { link, principal }`). When the server relays a client's request to a worker, Chord
writes the client's principal into the forwarded request; a principal field coming from a client is always
overwritten, and only a trusted parent link may carry one.

Where principals come from is app code. Studio's sharing feature creates a share link per session and mode; a guest
who opens it gets a guest record (grant `g1`) and a cookie; `authenticate(req)` turns the cookie into
`{ kind: "guest", session: "S1", mode: "read", grant: "g1", revision: 1 }` on every new connection. Chord never sees
cookies or grants, only the finished principal.

## The caller is part of the identity

A `remote` object exists once per **(type, input, principal key)**. The **principal key** is a string computed from
the principal; by default its canonical JSON (sorted keys). The app may pass its own `principalKey` to `createHost`,
and must pass the same function on every host, or identities split silently.

```ts
const principalKey = (p: P) =>
  p.kind === "owner" ? `owner:${p.access}:${p.device ?? ""}`
  : p.kind === "guest" ? `guest:${p.grant}:r${p.revision}`
  : p.kind === "worker" ? `worker:${p.session}`
  : p.kind;
```

The design wants the key to include how the client is connected and the grant's revision, so that two access paths
never share objects and a changed grant never reuses the old grant's object:

| Caller | Principal key | `Notes { S1 }` object |
| --- | --- | --- |
| owner, tab A, local | `owner:local:` | 1 |
| owner, tab B, local | `owner:local:` | 1 (shared with tab A) |
| owner through the relay | `owner:relay:` | 2 |
| guest g1, revision 1 | `guest:g1:r1` | 3 |
| guest g1 after a change to write mode, revision 2 | `guest:g1:r2` | 4 (new) |

## Variants

The contract lists named sets of members; the factory receives the principal and returns the variant that principal
may use:

```ts
// notes/contract.ts (version 1, final form for now)
variants: {
  editor: {
    state: { notes: obj({ items: arr(Note) }) },
    methods: { add: method(obj({ text: str({ min: 1, max: 2000 }) }), str()), remove: method(obj({ id: str() })) },
  },
  reader: {
    state: { notes: obj({ items: arr(PublicNote) }) },     // no `by`: authors are hidden
  },
},
```

```ts
// notes/worker.ts
host.serve(Notes, ({ session }, principal, self) => {
  if (canWrite(principal, session)) return { variant: "editor", notes: …, add: …, remove: … };
  return { variant: "reader", notes: … };
});
```

A reader has no `add` at all. Chord refuses a call to a member that is not in the caller's variant, so `add` needs no
check of its own. Three rules keep variants compatible: a member name has the same kind (state or method) in every
variant that has it; a method has the same arguments and result in every variant; only state schemas may differ per
variant (the reader's notes have no authors). `remote(...)` enforces them at the type level, and at runtime for
contracts that arrive as data.

## How a facet knows `P`

`P` is Studio's type, not Chord's, and every host is created with it (`createHost<P>`). A plugin's facets are written
and compiled separately, then handed to `host.load` as values, so the type checker cannot infer `P` from the host into
the factory's `principal`. Studio's base code therefore exports its own `defineFacet`, already bound to `P`, and every
facet of every plugin imports that one instead of Chord's:

```ts
// studio/src/facet.ts (base code, exported as @studio/core)
import { bindFacet } from "@earendil-works/chord/next";
import type { P } from "./principal.ts";

export const defineFacet = bindFacet<P>();         // a facet's principals are Studio's P
export type { P, Revocation } from "./principal.ts";
```

```ts
// notes/worker.ts (server.ts, web.tsx and tui.ts import the same defineFacet)
import { defineFacet } from "@studio/core";

export default defineFacet((host, self) => {
  host.serve(Notes, ({ session }, principal, self) => {   // principal: P
    if (principal.kind === "guest" && principal.mode === "read") return { variant: "reader", notes: … };
    …
  });
});
```

The import is cheap: `@studio/core` is a host package plugins already import at runtime (the contract imports `Session`
from it), `P` is a type-only import, and `bindFacet` is a one-line function. The host checks the pairing: `load`
accepts only facets typed for its own `P`, so a facet compiled against another app's principal type, or one built with
Chord's untyped `defineFacet`, does not compile into Studio's start code. Client facets (`web.tsx`, `tui.ts`) use the
same `defineFacet`; they rarely see a principal, because clients serve only `local` types.

None of this is checked at runtime, and none of it needs to be: the principal a factory receives is the one the link
stamped.

:::review | Review: binding facets to the app's principal type (open)
The design shows `defineFacet((host, self) => …)` without saying how `P` reaches the factory. The frozen kernel takes
it as an explicit type parameter, `defineFacet<P>(…)`, defaulting to `{ kind: string }`
(`packages/chord/src/next/facet.ts`), and the playground writes `defineFacet<AppPrincipal>(…)`. The pre-bound
`defineFacet` above (`bindFacet` is a working name) is the owner's preferred direction, recorded as an open point in
`packages/chord/docs/next/layer-1.md` §4.
:::

## Narrowing on the caller's side

Owner and guest run the same `web.tsx`, and which variant they get is known only at runtime. The types force every
caller to narrow before using variant members:

```ts
const notes = await client.get(Notes, { session: "S1" });
notes.add({ text: "hi" });                         // type error: `add` exists only in "editor"
if (inVariant(notes, "editor")) await notes.add({ text: "hi" });
expectVariant(notes, "editor");                    // or assert (throws)
function Editor({ notes }: { notes: RefIn<typeof Notes, "editor"> }) { … }
```

The protection is not the type checker; it is Chord refusing the call at the provider. A client that ignores the
types gets the same error.

## Admission before a worker starts

Principals also decide whether a caller may reach a host at all. `route(Session, { authorize })` runs before Chord
resolves an address, so a guest of S1 asking for anything in S2 is refused at the server, and no worker starts for
them. Finer authority lives in the per-principal view's methods; there is no asynchronous "may this caller activate
this object" guard. An object whose address carries authority (say, a login flow by id) may exist; what a caller can
see and do is decided by the variant its factory picks.

## Inside methods

`ctx.principal` is the caller of the current call. In Studio's notes the editor's `add` uses it to record the
author:

```ts
add: ({ text }, ctx) => store.add({ text, by: authorOf(ctx.principal) }, ctx),
```

Where principals act, in summary:

| Purpose | Where |
| --- | --- |
| identity: which object a caller gets | principal key |
| variant: which members | the factory |
| admission: whether a host is reachable | `route.authorize` |
| attribution and fine checks | `ctx.principal` in methods |
| revocation | `revokedBy` (chapter VII) |

## The bug from chapter II

Now the bug is visible. The owner's `Notes { S1 }` and Ann's `Notes { S1 }` are two objects (rows 1 and 3 above), and
each declared its own `NoteList`. The owner's notes are not in Ann's list. Per-caller objects must not hold the data;
they must be views over something that exists once. That is the next chapter.

# One Store, Many Views {#shared-store lede="Local types, and the pattern every Chord plugin uses: shared data once in a store, per-caller views in front of it."}

Every caller has its own `Notes` object, which is what makes per-caller variants possible. But data must exist once.
The fix is the most common pattern in Chord: a **shared store**, a `local` object that holds the data and does the
heavy work once, behind thin per-principal **views**, the `remote` objects callers get.

## `local` types

```ts
// notes/contract.ts
export const NoteStore = local("notes.store", {
  version: 1,
  input: obj({ session: str() }),
  members: {
    notes: obj({ items: arr(Note) }),                          // state: a schema
    public: obj({ items: arr(PublicNote) }),
    add: method(obj({ text: str(), by: str() }), str()),       // methods: method(...)
    remove: method(obj({ id: str() })),
  },
});
```

A `local` contract has flat `members` and no variants. The differences:

| | `remote` | `local` |
| --- | --- | --- |
| reachable from | any host, across links | its own host only |
| identity | (type, input, principal key) | (type, input) |
| principals, variants | yes | no |
| factory | `(input, principal, self)` | `(input, self)` |
| arguments | stripped to the provider's schema and validated, for every caller | see the review note below |
| values on the same host | passed by reference, never copied | passed by reference, never copied |
| `ctx.principal` | the caller | none |
| may persist documents | no (chapter V) | yes |

A local object has no principal: it is trusted code on its own host, acting for the host. So attribution ("who wrote
this note") is passed as data (`by`), by the view that knows who called. Clients serve only local types, because
nobody can address a client.

## The pattern

```ts
// notes/worker.ts
export default defineFacet((host, self) => {
  host.serve(NoteStore, ({ session }, self) => {
    const list = self.state(NoteList);
    const pub = self.derive("public", [list], ([l]) => ({ items: l.items.map(stripAuthor) }));
    return {
      notes: list,
      public: pub,                                   // computed once, for every reader
      add: ({ text, by }, ctx) =>
        self.tx(async (tx) => {
          const id = uuidv7();
          (await tx.draft(list)).items.push({ id, text, by, at: Date.now() });
          return id;
        }, ctx),
      remove: ({ id }, ctx) => list.change((d) => { d.items = d.items.filter((n) => n.id !== id); }, ctx),
    };
  });

  host.serve(Notes, ({ session }, principal, self) => {
    const store = self.get(NoteStore, { session });   // a reference, declared: held for the view's life
    if (canWrite(principal, session)) return {
      variant: "editor",
      notes: store.notes,                             // the store's readable, exposed as-is
      add: ({ text }, ctx) => store.add({ text, by: authorOf(principal) }, ctx),
      remove: (args, ctx) => store.remove(args, ctx),
    };
    return { variant: "reader", notes: store.public };
  });
});
```

:::flow wide | One store, three views. The redaction runs once in the store; both readers read the same value.
row "Per-principal views (remote)" blue
box ve "Notes { S1 }" "owner · editor" blue
box vr1 "Notes { S1 }" "guest Ann · reader" blue
box vr2 "Notes { S1 }" "guest Bob · reader" blue
row "Shared store (local)" accent
gap
box store "NoteStore { S1 }" "notes, public (a derive)" accent
gap
arrow ve -> store "self.get"
arrow vr1 -> store "self.get"
arrow vr2 -> store "self.get"
note "Authority is the view's: the reader variant has no add. The store does not check; it is trusted and acts for the host."
:::

`self.get(NoteStore, { session })` in a factory declares a **reference** that the view holds for its whole life; Chord
binds it during activation and waits until the store is live (chapter VI). The view exposes the store's readables
directly. Owner, Ann and Bob now give three `Notes` objects, one `NoteStore`, one note list and one redacted list.

Any heavy or shared part belongs in a store like this: a pi-durable watch, a file watcher, a sandbox, a search index.
Base code uses the same pattern with the same primitives; nothing about it is special to core.

## Derived values, briefly

`self.derive(name, sources, fn)` computes a value from readables and recomputes it when a source changes; viewers get
only the difference. The reader's list above is one. Chapter VIII covers derives in depth, including the one footgun
that matters: `stripAuthor` must return the *same* object for an unchanged note, or every commit costs the size of the
whole list. The tool for that is `mapShared`.

## Arguments are checked at the provider

Trusted code is not type-checked code: plugins are bundled with esbuild without type checks, and agents write
JavaScript plugins. So the provider checks arguments itself (decision R7): every method's arguments are stripped to
the **provider's own** schema (unknown fields removed) and validated with it, whoever the caller is, and never with a
schema a peer sent. Schemas are compiled lazily on first use and cached per schema object. Bytes are checked as leaves
(`instanceof Uint8Array` plus an optional length bound), never walked. Stripping copies only when a field was removed;
the caller's value is never mutated (proposal Q12, in the L1 draft). Results and state are not validated: they come
from the provider.

On the same host nothing is copied: arguments and results are passed by reference. Values are **immutable by
convention** (Delta's rule, as in Durable): nobody mutates a value it received, and Chord neither copies nor freezes
values to enforce it. There is no development mode that would freeze them; one behaviour everywhere (R9).

:::review | Review: are local arguments validated? (Q15, open)
Design §5's table says `local` arguments are "neither validated nor copied"; §3 and R7 say arguments are validated
"for every caller". Review round 3 raised this as Q15 (apply R7 to `local` too, or keep `local` as the one exception),
and `layer-1.md` lists it as open. Until it is decided, write local methods so that they do not depend on either
answer: trust the shape, but never trust content (lengths, ids) that came from a remote caller without the view
checking it. `chord-next-walkthrough.md` concept 6 still describes the older rule ("validated only when the caller is
not a host principal"), which R7 replaced.
:::

## Choosing between the two

Use a `remote` type for what callers address: views, things with per-caller authority. Use a `local` type for what
exists once per input on one host: stores, caches, owners of OS handles, and the core objects a host provides
(chapter IX). If a type is reached across a link, it is remote; if a type persists documents, it is local (or a
host-lifetime object, chapter V).

# Writing It Down {#documents lede="Documents and transactions: how an object stores data, changes it atomically, survives restarts and migrates it."}

Notes must be stored, changed safely while others read them, sent to viewers as small changes, and survive a worker
restart. An object's data lives in **documents**: named JSON values the object owns, changed only in
**transactions**. The design is a port of pi-durable's store, so most rules will look familiar; this chapter states
them for Chord.

## Defining a document

```ts
// notes/worker.ts
const NoteList = defineState("notes.list", {
  schema: obj({ items: arr(Note) }),
  version: 1,
  initial: () => ({ items: [] }),
  persist: true,                                                   // stored; default: memory only
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase > 64,
});

const Draft = defineState("notes.draft", {                         // one unfinished note per author
  schema: obj({ text: str() }),
  version: 1,
  initial: () => ({ text: "" }),
  keyed: true,                                                     // many per object, by key
  persist: true,
  checkpointWhen: () => true,                                      // small: a full base per write
});
```

`checkpointWhen` is required on every definition, with no default (R14, as in Durable since pi `5c1736f82`): it says
when a commit stores a complete base instead of a delta, which bounds how much is replayed on load. Small documents
checkpoint on every write; growing ones after a number of deltas.

A document's root is always a JSON object (lists live in a field). Documents hold JSON only; bytes are a value and wire
type, not a document type.

## Singleton and keyed

```ts
host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);      // THE note list of this object
  const drafts = self.state(Draft);       // all drafts of this object
  …
});
```

| | singleton (no `keyed`) | keyed |
| --- | --- | --- |
| how many | one per object | many per object, by a short key |
| loaded | at activation, kept in memory | on demand |
| read | `list.value` (synchronous) | `await drafts.get(key)`: the value or `undefined` |
| list | (it is one value) | `for await (const key of drafts.keys())` pages keys |
| expose as state | yes: the handle is a readable | no: expose a method or a singleton index |

There is no live key list. A collection shown live is a singleton (an object holding a list or a map); a large
collection is a method returning pages.

## Transactions

All writes go through `self.tx(fn, ctx)`. Inside, `await tx.draft(handle, key?, { tags? })` returns a draft of the
current document, or a draft over `initial()` if it is absent. Drafts record operations (assignments, `push`,
`Object.assign`); asking for the same document twice in one transaction returns the same draft. `tx.retire(handle,
key?)` removes a document. There is no `tx.get`: reading is drafting, and a draft is an overlay over the current
value, so nothing is copied. A draft you do not change commits nothing, so reading never stores an absent document.

```ts
saveDraft: ({ author, text }, ctx) =>
  self.tx(async (tx) => { (await tx.draft(drafts, author)).text = text; }, ctx),
```

Shorthands for one document: `handle.change(fn, ctx)` (keyed: `handle.change(key, fn, ctx)`) (loads the document, then runs the synchronous `fn` on
its draft) and `handle.retire(ctx)` (keyed: `handle.retire(key, ctx)`).

### Four patterns

Two decisions (R12 and R13, both as in Durable) shape how transactions are written. **Drafts are revoked when the
transaction settles**, so a transaction returns at most plain values, never something taken from a draft. And
**there is no existence check inside a transaction.**

```ts
// 1. Return data: write in the transaction, read after the commit.
await self.tx(async (tx) => { (await tx.draft(list)).items.push(note); }, ctx);
return list.value.items.length;                    // the committed revision, or a newer one

// 2. Remove if present: retire of an absent document is a no-op.
await drafts.retire(author, ctx);

// 3. Create with tags if missing: the draft creates it, only if it changes.
await self.tx(async (tx) => {
  (await tx.draft(drafts, author, { tags: [SessionTag(session)] })).text = text;
}, ctx);

// 4. Branch on existence: read first, outside the transaction.
if ((await drafts.get(author)) === undefined) { … }
```

### Durable's rule

Inside the callback, only `await tx.*`. No other objects, no network, no models, no processes, no second `self.tx`, no
reads past `tx`. Breaking it is not an error but a hang: the object's line is held while the callback waits. Fetch
first; decide and write inside.

```ts
// Wrong: a fetch inside the transaction holds the object's line.
await self.tx(async (tx) => { (await tx.draft(list)).items.push({ …, title: await fetchTitle(url) }); }, ctx);
// Right: fetch, then write.
const title = await fetchTitle(url, ctx.signal);
await self.tx(async (tx) => { (await tx.draft(list)).items.push({ …, title }); }, ctx);
```

## What a commit does

:::flow wide animate | The commit sequence, Durable's. Nothing is copied, frozen or revalidated; viewers get one batch per commit.
row "Inside self.tx" accent
box line "wait for the line" "per object"
box run "run the callback" "drafts record ops" accent
box prep "prepare" "Delta checks placed values"
box write "storage batch" "deltas or a base" accent
row "After the write" blue
box adopt "adopt" "pointer swap"
box local "notify locally" "once, with the ops" blue
box wire "send" "one batch per link"
box revoke "revoke drafts" "touching one throws"
arrow line -> run
arrow run -> prep
arrow prep -> write
arrow write -> adopt "stored"
arrow adopt -> local
arrow local -> wire
arrow wire -> revoke
note "An error or an abort before the storage write discards everything. Storage commits are serialized per host."
:::

Lines are per object, never across objects; reads outside a transaction do not take the line. Subscribers on the same
host get the new value and the commit's operations by reference. Remote viewers get the commit's operations, never the
document again; chapter XVII shows how one commit touching several holds still arrives as one message.

## Tags and deleting by tag

Tags are typed tokens set when a document is created:

```ts
export const SessionTag = defineTag<string>("studio.session");     // base code, shared by every plugin
await self.tx(async (tx) => { (await tx.draft(drafts, author, { tags: [SessionTag(session)] })).text = text; }, ctx);
// when the session is deleted
await store.retireByTag(SessionTag, "S1");                          // every document tagged S1
```

The design names the operation `store.retireByTag(tag, value)` without saying who holds the store; session delete is
one of the app decisions still open (#18, chapter XIX).

## Who may persist

`persist: true` is allowed only in `local` objects and `lifetime: "host"` objects: identities without a principal. A
`remote` object's identity contains the principal key, which changes with the access path and the grant revision. Its
stored documents would scatter across access paths and be orphaned after a reconnect. The rule is enforced at the type
level (`self.state` in a remote factory accepts only non-persisted definitions) and at declaration ("persist needs a
stable identity: put the documents into a local shared store"). This is the second reason for the shared store.

What survives a host teardown (a crash, a restart) is exactly what is persisted. In-memory documents live as long as
their object: they survive reloads and native restarts of a live object, and go when it ends. Everything else
(natives, derives, routines, references) is rebuilt on activation.

## Facet documents

A facet has its own identity (its plugin's name) and may hold documents too, for plugin-wide data such as
preferences. Objects the facet serves may read and write their facet's documents, and one transaction may span the
object's own documents and its facet's (lock order: own line, then the facet's). The facet never touches a served
object's documents.

## Ownership across plugins

No plugin reads or writes another plugin's documents, Chord or Durable. Data crosses plugins only through state and
methods. Data that core enforces lives in a format core owns and is handed to core through its API when the data is
created (as with Durable's `createConversation({ init })`), never written into core's documents.

## Versions and migration

A change of shape or meaning raises `version` and adds a pure `migrate(old, from)`:

```ts
const NoteList = defineState("notes.list", {
  schema: obj({ items: arr(NoteV2) }),           // NoteV2 adds `pinned`
  version: 2,
  migrate: (old, from) => ({ items: old.items.map((n) => ({ ...n, pinned: false })) }),
  initial: () => ({ items: [] }),
  persist: true,
  checkpointWhen: (_v, _o, info) => info.deltasSinceBase > 64,
});
```

Documents migrate on access by the new definition: singletons during activation (hydration counts as access), keyed
ones on their next access. The migrated base is persisted with the next commit; right after a bump, a read-only
transaction writes it.

Chord does not walk values against schemas. Instead, each definition computes a **schema fingerprint** once
(descriptions and titles ignored), and every stored record keeps the fingerprint it was written with. On access Chord
compares them: the same version with a different fingerprint fails the object `broken` ("schema changed without a
version bump"). So every structural change needs a bump, an additive one with a trivial `migrate`. The one exception
to "no value checks" (R8): the result of `migrate` and of `initial()` is validated against the new schema once, when
produced. A failed check, a throwing `migrate`, or old code meeting a newer document refuses the access, keeps the
stored data and fails the owning object. A changed meaning without a schema change cannot be detected; that is on
you.

## Storage

Behind the store is a `DocumentStorage`, passed as `createHost({ storage })`; memory by default. The server has one
shared storage, each worker one for its session.

```ts
interface DocumentStorage {
  commit(writes: readonly DocumentWrite[]): Promise<Seq>;            // create/change/retire, atomic
  find(address: DocumentAddress): Promise<DocumentRecord | undefined>;
  load(id: string): Promise<StoredDocument | undefined>;             // version, value, deltasSinceBase
  scan(query: { owner: string; definition: string }, limit: number, cursor?: string):
    Promise<{ keys: string[]; next?: string }>;
  byTag(tag: string, value: string, limit: number, cursor?: string): Promise<{ ids: string[]; next?: string }>;
  mintId(): Promise<string>;
}
```

Chord ships a memory storage and a SQLite storage (over `@earendil-works/chord/sqlite`, the driver layer that moved
from Durable; Node and Durable Object drivers). Storages check only metadata (incarnation, version, sequence, address
occupancy, fingerprint) and write the supplied delta or base; they never rebuild or validate content on a commit.
Chord documents never commit together with Durable transcripts: Chord has its own storage, not an adapter over
Durable's. Your own storage can prove itself with `registerDocumentStorageConformance(runner, name, withStorage)` from
`@earendil-works/chord/testing`.

Keyed persisted documents that nobody reads, writes or watches for 10 minutes leave memory and reload on the next
access. A storage error ends the store and closes the host; `onError` receives `{ kind: "storage_failed" }` and the
app decides (chapter I).

## Kinds of state

| Kind | For | API |
| --- | --- | --- |
| document | data the object owns | `self.state`, `self.tx` |
| derive | computed values | `self.derive` (chapter VIII) |
| source readable | external data: Durable views, files, logs | value plus ordered changes; feeds derives |
| paged method | large or queryable collections | a method returning pages (chat history) |
| plugin database | full-text search, large blobs | a native opened by its owner (chapter IX) |

App state lives in Chord documents. Only transcript-bound data, which must fork and rewind with a conversation, lives
in Durable.

:::review | Review: does an absent singleton read `undefined` or `initial()`? (Q11, open)
Design §9 says "whether a document exists is read outside the transaction (`handle.value` / `handle.get` give
`undefined` for an absent one)" and also "a singleton that does not exist yet reads `initial()` through its handle;
retiring resets it to `initial()`". Review round 3 proposes: singletons always read `initial()`, only absent keyed
documents read `undefined`, and singleton existence needs no API. This guide follows the proposal (`list.value` is
never `undefined`); it is not decided.
:::

:::note | Built so far
Documents, transactions and storages are layer L3, a port of Durable's session store; not started. The frozen kernel
has a working version with a JSONL storage, which the design rejected.
:::

# Holding On {#references lede="References, the object lifecycle and ctx: what a caller sees while objects start, fail, restart and move, and why nobody writes retry code."}

A tab shows the notes of S1 for an hour. During that hour the laptop sleeps, the worker is stopped for idleness and
started again, the notes plugin reloads twice and the store's storage hiccups once. The panel should show the notes the
whole time, say "reconnecting" when it cannot reach them, and recover by itself. In Chord this is what a
**reference** does; plugin code contains no retry loops and no request ids.

## Three ways to hold

| Where | API | Released |
| --- | --- | --- |
| a factory | `self.get(Type, input)` | when the object ends |
| a call | `await ctx.get(Type, input, { state? })` | when the call ends |
| outside objects | `await host.get(Type, input, { signal, state?, parkTimeout? })` | `ref.release()` |

Use `self.get` for what an object needs its whole life (the view's store), `ctx.get` for what one call needs, and
`host.get` only in UI code, tests and entry points. `{ state: false }` binds for methods only, without receiving state.
A reference keeps its object alive while held.

## The object lifecycle

```text
(get) → activating → live → ending → ended
             └→ failed (backoff) → activating …
```

**Activating:** Chord binds the declared references and waits until they are live and hydrated, loads singleton
documents, opens natives (one after another, in declaration order), computes derives and starts routines. The object
goes live when all of that succeeded. Calls wait behind its **gate** until then.

**Ending:** routines stop, the object's calls and jobs are aborted as their rules say, natives close in reverse order,
references are released. An object with `lifetime: "referenced"` (the default) ends when its last reference goes,
after the type's `linger` if it has one. A `lifetime: "host"` object (only for types without a required input) lives
as long as the host. A running, finishing or blocked job counts as a reference (chapter XI).

## `ref.state`

Every reference reports what is going on as a tagged value; listeners get each new one:

```ts
type RefState =
  | { kind: "loading" }                                                // first hold, reconnecting, restarting
  | { kind: "live" }
  | { kind: "failed"; cause: FailureCause; retryAt: number | undefined } // undefined: no automatic retry
  | { kind: "released" };
```

| Situation | Calls | Values |
| --- | --- | --- |
| link drop | park until reconnected | readable, `loading` |
| object loading or restarting | park until live | readable, `loading` |
| rollout: provider ahead or installing | park until installed | readable |
| object `failed` | reject at once with the cause | `failed`, with cause and `retryAt` |

Values stay readable through all of this: the panel keeps showing the last notes. Parked calls share one deadline (60
s by default, `parkTimeout` per `get`), then fail `unavailable`. Otherwise a call ends only through its caller's
signal; there is no per-call deadline. A call that was running on an instance that ends fails with an error and is
not resent: Chord cannot know whether it took effect.

**Errors look like disconnects.** A consumer handles a failed call exactly as a dropped link: show the error, let the
user retry. Work that must not run twice carries its own idempotency key as data (Durable's `requestId`, a job's
`key`).

:::steps | The worker restarts while a tab watches the notes
+++ Watching
The tab holds `Notes { S1 }`. `ref.state` is `live`; `notes.notes.value` has 40 notes.
+++ The worker goes away
The supervisor stops worker S1 (or it crashes). The server's IPC link to it drops. The server tells the tab that its
hold is gone; the tab's reference goes `loading`. The 40 notes stay readable.
+++ A click meanwhile
Ann's colleague clicks **Add**. The call **parks** on the reference; nothing is sent yet. The deadline is 60 s.
+++ Chord resolves again
Holds on S1 still exist, so Chord calls `route(Session).resolve({ id: "S1" })` again, with the per-address backoff.
The app forks a new worker: a new **incarnation** of `Session({ id: "S1" })`.
+++ Re-hold
The server re-holds every hold on S1 over the new link. The new worker activates `NoteStore { S1 }` (its notes load
from storage) and the views; it sends fresh snapshots. The tab's reference goes `live`.
+++ The parked call runs
The parked `add` is sent now and succeeds. The panel shows 41 notes. Nobody wrote recovery code.
:::

## Failure and retry

Any broken part fails the **whole** object: a half-working object could break rules that rely on its documents
changing together. Chord tags the cause by where it failed:

```ts
type FailureCause =
  | { kind: "transient"; error: ChordError }   // an open threw, a dependency was unreachable: automatic backoff
  | { kind: "broken"; error: ChordError };     // factory, derive, hydration or migrate threw: retried only by a trigger
```

**Transient** causes get a backoff per address: 1 s, doubling to 60 s; concurrent gets share one attempt; success
resets it. **Broken** causes would fail the same way again (a code bug, invalid data), so they are retried only by a
**trigger**: a plugin reload, `ref.retry()` (a Retry button), or a readable the factory declared with
`self.retryOn(...readables)`. Only an opener may declare its own failure broken, with `throw broken(error)`, for
example for invalid configuration. A failed reference stays held; on success it goes `loading`, then `live`.

```ts
host.serve(EnvConnection, ({ env }, self) => {
  const config = self.get(EnvConfig, {});                 // a facet or registry value, outlives the attempt
  self.retryOn(config.envs);                              // a config change retries a broken open
  const ssh = self.open(async ({ signal }) => {
    const c = config.envs.value[env];
    if (!c) throw broken(new Error(`unknown environment ${env}`));
    return connect(c, signal);
  }, (s) => s.close());
  …
});
```

`retryOn` sources must live independently of the attempt (facet documents, registry values); a member of one of the
object's own references is a type error, since it goes away with the attempt.

## Waiting for dependencies

An object whose references are not live yet stays `loading` and goes live the moment they are, bounded by
`readyTimeout` (60 s). The decision for the failure case (R18) is what makes recovery automatic:

:::sequence animate | Dependency recovery. The view fails transient with the store's cause, keeps its reference, and is retried the moment the store goes live.
actor tab "tab"
actor view "Notes { S1 }" blue
actor store "NoteStore { S1 }" accent
tab -> view: hold
view -> store: self.get (activation)
store -> store: open fails: disk not mounted
store --> view: failed (transient)
view --> tab: failed: transient, cause inside
note view..store: the view keeps its reference; its state is the retry trigger
store -> store: backoff retry: open succeeds
store --> view: live
view -> view: retried at once (backoff cancelled)
view --> tab: live
:::

A dependency that fails, or does not become live in time, fails the dependent **transient** with the dependency's
cause inside, never broken: the cause is the dependency's. The dependent keeps its references while failed, and Chord
uses their state as a retry trigger. Factory authors write `self.get` and know none of this. After an object is live,
a dependency leaving `live` does not change it: its calls that use the dependency get the dependency's error, or park
while it loads.

**Cycles are rejected** (Q5). If A's activation gets B and B's gets A, neither would ever lose its last reference.
Every object instance has a uuidv7 instance id; on one host Chord follows the waiting edges of activating objects, and
across hosts a hold made during an activation carries the chain of instance ids. A cycle fails the activation
`broken`, naming it ("A → B → A"), and keeps no references.

## No optional references

`get` has no `optional` flag. When a dependency's plugin may be missing, turn the dependency around: the dependent
owns a registry and the other plugin contributes to it. Radius uses forwards from the ports plugin, but ports is
optional, so radius owns `radius.forwards` and ports contributes its forwards; without ports the table is empty and
radius works (chapter XIII).

## `ctx`

Every call gets a `ctx` as its last argument:

| Field | Meaning |
| --- | --- |
| `signal` | fires when the caller cancelled or the object ended; pass it to everything you wait on |
| `principal` | the caller (remote types only) |
| `incarnation` | the calling host's incarnation, for calls that arrived over a link (chapter X) |
| `get` | references released when the call ends |
| `telemetry`, `trace(name, attributes, fn)` | the current span; a child span with a child `ctx` (chapter XVII) |
| `jobId`, `progress` | in a job's `run` (chapter XI) |

```ts
exportText: async ({}, ctx) => {
  const catalog = await ctx.get(Catalog, {});                     // released when the call ends
  const title = catalog.sessions.value[session]?.title ?? session;
  const res = await fetch(renderUrl, { method: "POST", body: render(title, list.value), signal: ctx.signal });
  return await res.text();
},
```

There are no code versions and no request ids in `ctx`. Durable's `Context` is the same module (`chord/context`):
`ctx` extends it, so passing `ctx` into pi-durable needs no conversion. Code outside objects gets a `ctx` from
`host.root(fn, { principal?, signal? })`; inside Durable tools it uses `chord(fn, context)` (chapter XIV).

:::note | Built so far
References, `ctx` and the lifecycle are layers L4 and L5. `ChordError` and `FailureCause` are specified in the L1
draft (`layer-1.md`), with codes `invalid`, `contract_mismatch`, `forbidden`, `gone`, `not_ready`, `released`,
`too_large`, `unavailable` and `aborted`, and a finer `reason` such as `invalid/args`.
:::

# Taking Access Away {#revocation lede="Revocation: how removing a guest ends their objects on every host at once, and why reconnecting does not bring access back."}

The owner removes Ann from S1. Her tab still has a WebSocket open and a `Notes { S1 }` view on worker S1. Both must end
now, on the server and on the worker, and her tab's automatic reconnect must not restore anything. Chord provides the
mechanism; the app decides who is blocked and remembers it.

## Labels, not predicates

The app declares, once, which **revocation labels** each principal carries. Revoking means revoking one label;
everything carrying it is hit.

```ts
// studio/src/principal.ts
export type Revocation = { grant: string } | { device: string } | { session: string };

export const revokedBy = (p: P): Revocation[] =>
  p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }]
  : p.kind === "owner" && p.access === "device" && p.device ? [{ device: p.device }]
  : [];

const server = createHost<P, Revocation>({ address: Server(), principal: { kind: "server" }, revokedBy });
// every worker is created with the same revokedBy
```

| Principal | Labels |
| --- | --- |
| guest Ann (grant g1) in S1 | `{ grant: "g1" }`, `{ session: "S1" }` |
| guest Bob (grant g2) in S1 | `{ grant: "g2" }`, `{ session: "S1" }` |
| owner on the paired phone | `{ device: "phone" }` |
| owner, local | none |

| Call | Hits |
| --- | --- |
| `server.revoke({ grant: "g1" })`: remove Ann | Ann |
| `server.revoke({ session: "S1" })`: archive S1 | Ann and Bob |
| `server.revoke({ device: "phone" })`: sign out the phone | the phone |

A label is plain data because revocation is an event that must travel from the server to the workers; a predicate
function could not be sent.

## What `revoke` does

`host.revoke(r)` ends every object and closes every link whose principal `p` has `r` in `revokedBy(p)` (compared by
canonical JSON; never the host's own principal), and passes `r` to its children, which apply their own `revokedBy`.

:::sequence animate | Removing guest Ann. The label travels down; her objects end on every host; her reconnect is refused by the app's own record.
actor owner "owner tab"
actor server "server" accent
actor worker "worker S1" blue
actor ann "Ann's tab" "guest g1" muted
owner -> server: Sharing.remove({ grant: "g1" })
server -> server: app: mark g1 blocked (document)
server => server: revoke({ grant: "g1" })
server -> ann: close link
server => worker: revoke { grant: "g1" }
worker -> worker: end Notes { S1 } as g1
ann -> server: reconnect
server -> server: authenticate: g1 blocked
server --> ann: refused (4401)
:::

On worker S1, for `revoke({ grant: "g1" })`:

| Object | Principal | Hit |
| --- | --- | --- |
| `Notes { S1 }` | owner, local | no |
| `Notes { S1 }` | guest g1 | **yes**: ends |
| `Notes { S1 }` | guest g2 | no |
| `NoteStore { S1 }` | none (local) | no |

Ending Ann's view releases its reference to the store, which keeps serving the others.

## Chord persists nothing here

`revoke` cuts live access only. Lasting denial lives in the app's data (the sharing plugin's guest records), which
`authenticate` checks on every new connection. After a server restart nothing live exists to revoke; every client
authenticates again and blocked grants are refused there.

**No re-stamping.** A changed grant (Ann moves from read to write) is a revocation of the old grant. Her link closes,
her tab reconnects and authenticates with the new grant revision, which gives a new principal key, and her references
re-hold by themselves, now as an editor. Reconnecting never restores revoked authority.

**Revocation beats jobs** (R11). Normally a running job keeps its object alive after the last reference is released
(a closed tab does not abort an import). Revoking a principal ends its objects at once regardless; their jobs get the
abort signal and the normal close timeout.

## Work in shared stores

Revocation ends objects whose principal carries the label. A shared store has no principal, so work it runs *on
behalf of* someone (a question waiting for Ann's answer, a shell command a guest started) is not ended by `revoke`.
Such a store keeps the grant as data with the work and reconciles from the grant owner's live state with a routine
(chapter X):

```ts
// in a shared store that runs work for guests
const sharing = self.get(Grants, {});                              // the sharing plugin's live grants
self.routines.on(sharing.live, async (live, ctx) => {
  for (const run of shell.running.value)
    if (run.args.grant && !live[run.args.grant]) shell.abort(run.id);   // idempotent
});
```

There is no revocation hook: a hook can be missed (a crash between revoke and hook), a routine over current state
cannot. The window between the revocation and the routine's run is accepted (R10); a step started in it still runs.

## Who does what

| Chord | The app |
| --- | --- |
| stamps principals on links | what a grant is; share links, cookies, `authenticate` |
| keeps one object per principal key | defines `Revocation` and `revokedBy` |
| on `revoke(r)`: ends matching objects and links, passes `r` down | decides when to revoke; stores who is blocked |

# Computed Values {#derives lede="Derives, the one footgun that makes them expensive, mapShared, and presence: who is looking."}

The reader's notes without authors, a note count, the number of people viewing: values computed from other values.
Storing copies would go stale; recomputing them on every read would be wasteful and could not be watched. A
**derive** is computed once per change and sent to viewers as a difference.

## `self.derive`

```ts
const count = self.derive("count", [list], ([l]) => l.items.length);
const summary = self.derive("summary", [list, store.pinned], ([l, pinned], previous) => ({
  total: l.items.length,
  pinned: pinned.length,
}));
```

`self.derive(name, sources, (values, previous) => value)`. Sources can be documents, readables, other derives and
state members of references. The value is recomputed when a source changes and diffed into operations for the wire.
Derived values are adopted before ordinary observers run and share their source commit's wire batch, so a viewer
never sees a note list and a count from different commits.

`previous` is the derive's last value, kept across factory re-runs (reloads) by name. It is a cache, empty after a
host teardown, so a derive must be correct without it. A derive that throws fails its whole owner `broken`.

## How the difference is found

Chord compares the new value with the previous one using Delta's `diffRevisions`. Parts that are the **same objects**
as last time cost one `===` each. Parts that are new objects must be compared by content.

**The footgun.** A derive that builds new objects for unchanged data makes every commit cost the size of the whole
value, per view. The reader list from chapter IV, written naively:

```ts
self.derive("public", [list], ([l]) => ({ items: l.items.map((n) => ({ id: n.id, text: n.text, at: n.at })) }));
// one note added to 2,000: 2,001 new objects, every one compared by content
```

**`mapShared(f)`** keeps one result per source element: `f` runs only for new or changed elements, unchanged ones
return their previous result object.

```ts
import { mapShared } from "@earendil-works/chord/delta";

const stripAuthor = mapShared((n: Note): PublicNote => ({ id: n.id, text: n.text, at: n.at }));
self.derive("public", [list], ([l]) => ({ items: l.items.map(stripAuthor) }));
// one note added: one new object, 2,000 identical references; the diff emits one insert
```

:::review | Review: mapShared is planned, not available
Design §12 introduces `mapShared` as coming "from `@earendil-works/chord/delta`", but nothing in `packages/chord/src`
defines it yet, and Delta does not yet treat bytes as atomic leaves in `diffRevisions`. Design §28 lists both as the
step "Delta in pi", before the layered rebuild. Until then, keep a `Map` from source element to result yourself, which
is what `mapShared` will do.
:::

## Cookbook

| Case | How |
| --- | --- |
| select a field, look up by key, a small aggregate | compute it; the value is small |
| filter or map a list | `mapShared` over the elements |
| redaction | preferably separate documents per visibility; otherwise `mapShared`, computed once in the shared store, never per view |
| join two sources | `mapShared` plus the looked-up source's revision |
| a window over a large list | take a section of the source elements without rebuilding them; cache per-element measurements by identity; keep the window's start stable so changes arrive as appends |
| a large view combined from several sources | re-path the sources' operations, as Durable's `ConversationView` does; application code never interprets ops |

**Container width** (R24): structural sharing is O(change) along a path, not across a container's width. Changing one
item of a flat array copies the array's slots, and `mapShared` visits every element once (one identity comparison
each). Large collections are keyed documents or bounded windows. A benchmark of long arrays is to set the documented
limit.

## Readables that are not documents

Three small readables round out the toolkit:

- `constant(value)`: never changes. Start data uses it (chapter IX).
- `self.writable(initial)`: a host-local readable of any in-process value (functions included), compared by identity,
  with `set`. It never goes on the wire; it exists for registry contributions that change (chapter XIII).
- Source readables from elsewhere: a Durable view or document watch is already a Chord readable, because Durable and
  Chord v2 share the readable type (`chord/src/state.ts`), so it can feed a derive or be exposed as state directly.

:::review | Review: exposing a writable (Q14, open)
A `writable` may hold functions; nothing yet stops a factory from returning one as a state member, which would reach
the wire encoder. Review round 3 proposes that only members with a JSON schema in the contract are exposable, checked
when the object is served. Undecided.
:::

## Presence: who is looking

`host.references(Type)` is a readable of who holds references to objects of a type on this host: input, principal and
client. Client holds carry an opaque origin id, so two tabs are two clients.

```ts
host.serve(NoteStore, ({ session }, self) => {
  const viewers = self.derive("viewers", [host.references(Notes)], ([refs]) =>
    refs.filter((r) => r.input.session === session).length);
  return { …, viewers };
});
```

A link drop is a departure: accurate and simple. Smoothing (a phone switching networks makes the count flicker) is the
UI's job, for example a debounced count. Counts per person are derived by the app from principals and origins. There
is no consumer-side linger: a closed tab closes its link and keeps nothing. The provider's `linger` keeps a
just-closed object warm, and that also keeps the worker alive through `host.activity`.

**"Leaving" is never derived from an unmount.** A UI reload unmounts and remounts components; a component unmounted by
a reload has not left. Leaving is explicit navigation, or presence (a dropped reference). This replaces p2's presence,
viewer and login-abandon leases with one mechanism.

:::note | Built so far
Readables and derives are layer L2 (a readable is today's `replicatedState`, derives reuse today's derived cells over
it). Not started in the rebuild.
:::

# Things the OS Gives You {#natives lede="Start data, host-lifetime objects and natives: how a plugin opens a file watcher or a socket so that it is closed exactly once, also across reloads."}

Studio's notes get an inbox: a text file dropped into the session's `inbox/` directory becomes a note. That needs a
file watcher, a **native**: an OS-level value (a file handle, a socket, a process, a database connection) that cannot
be JSON, cannot be copied, must be opened, and must be closed exactly once. It also needs the session's data
directory, which the plugin does not know. This chapter covers both.

## Start data is an object

A worker knows things before any plugin loads: its session id, the data directory, init data from the server's start
message. There is no special mechanism for them. Start data is an ordinary `local` object with `lifetime: "host"` and
constant state, served by base code's core facet:

```ts
// studio/src/core/contract.ts
export const Init = obj({ id: str(), dataDir: str(), cwd: str(), env: opt(str()) });
export const SessionInfo = local("studio.session-info", {
  version: 1,
  input: obj({}),
  members: { init: Init },
});

// studio/src/core/worker.ts
export const coreWorkerFacet = (init: Static<typeof Init>) => defineFacet((host) => {
  host.serve(SessionInfo, () => ({ init: constant(init) }), { lifetime: "host" });
  // … the Harness and other core objects (chapter XIV)
});
```

Any plugin on the worker declares a reference and reads it **after activation**: in an opener, a derive, a routine or
a method, never synchronously in the factory.

```ts
const info = self.get(SessionInfo, {});
// later: info.init.value.id, info.init.value.dataDir
```

Paths are derived by the plugin from generic start data (`join(dataDir, id, "notes-inbox")`), never provided per
plugin. Platform bindings work the same way: on a Durable Object, a core object's `self.open` returns the binding
(`state`, `env`) and its close does nothing.

## `self.open`

```ts
const watcher = self.open(
  async ({ signal }) => watchDir(path, { signal }),       // open: during activation
  (w, reason) => w.close(),                               // close: when the object ends or restarts
  { closeTimeout: 10_000 },                               // optional; host default 30 s
);
watcher.value;                                            // the watcher; reading it before activation throws not_ready
```

`self.open` returns a handle with `.value` (type `Native<T>`), not a proxy. The rules:

- **Natives live only in objects.** Not at module level, not in the facet. A module-level watcher would survive a
  reload with nobody to close it.
- **Order:** natives open one after another in declaration order (a later opener may read an earlier handle's
  `.value`) and close in reverse. The object goes live after all opens succeeded.
- **The value never changes during an attempt.** No replacement, no versions, no stale-handle logic. To change a live
  native, the object restarts.
- **A failed open** makes the object `failed`: transient with backoff by default, broken if the opener says so
  (`throw broken(error)`). A partly failed activation closes the natives already open, with reason `end`; the next
  attempt opens all of them anew.
- **`close` gets a reason:** `{ kind: "reload" }` (the plugin reloads and this native object restarts), `{ kind:
  "stop" }` (the host shuts down) or `{ kind: "end" }` (the last reference ended, or the type was removed). Each
  `close` is bounded by `closeTimeout`, then reported as a possible leak while the rest continues. A throwing `close`
  does not stop the others; `host.close()` collects the errors, background ends report to `onError`.
- **Behaviour around a native goes into routines** (chapter X). Listeners on natives outside routines are forbidden.

An object with at least one `self.open` is a **native object**; one without is a **pure object**. The difference
decides what a reload does (chapter XV): pure objects are swapped in place, native objects restart.

## The inbox

The inbox must run as long as the worker, whether anyone looks at the notes or not. So it is a `lifetime: "host"`
object. The facet cannot `self.get` a type it serves, and the inbox has no meaningful input, so it is an object
without input that reads its session from the start data:

```ts
// notes/contract.ts
export const NoteInbox = local("notes.inbox", { version: 1, input: obj({}), members: {} });

// notes/worker.ts
host.serve(NoteInbox, (_input, self) => {
  const info = self.get(SessionInfo, {});
  const watcher = self.open(async ({ signal }) => {
    const { id, dataDir } = info.init.value;                       // read in the opener: after activation
    return watchDir(join(dataDir, id, "notes-inbox"), { signal });
  }, (w) => w.close());

  self.routines.loop("import", async (ctx) => {                    // chapter X
    const store = await ctx.get(NoteStore, { session: info.init.value.id });
    for await (const file of watcher.value.files(ctx.signal)) {
      await store.add({ text: await readFile(file, "utf8"), by: "inbox" }, ctx);
      await rm(file);
    }
  });
  return {};
}, { lifetime: "host" });
```

Note `ctx.get(NoteStore, …)` in the routine rather than `self.get` in the factory. The factory runs before the
session id is known (start data is read after activation), so a host-lifetime object without input gets
session-scoped objects with `ctx.get` in a routine or method (R22). A `get` whose input is computed after activation is
to be added only if a real case needs it.

## Natives with work in flight

A restart is sequential (R16): close the old native, then open the new one. When the old one still has work running,
use one of two patterns:

- **Drain in the background.** `close` detaches the old resource and returns at once; it disposes of it when its work
  finishes, or after `closeTimeout` at most. Chord opens the new one immediately. Code mode's sandbox does this: a
  script running during a reload finishes on the old sandbox (for up to 30 s, Q7; a longer one is aborted and its turn
  fails), new scripts start on the new one.
- **Swap through a registry.** The resource is a registry contribution (chapter XIII). Readers always look up the
  current one at use; a reader that must wait for one uses a cancellable "wait until present" with the park deadline.

Chord aborts only the object's own calls and jobs on close. Other work that uses the native (Durable tool calls on a
sandbox) is the owner's business: `close` may drain instead of tearing down. What an old native does after its owner
restarts is also the owner's `close`: a model runtime keeps working until collected, a closed SSH connection fails its
in-flight `exec`.

## Natives that follow a relocation

A session can move to another directory. The inbox watcher must follow. Restarting the object on every move would be
heavy-handed; instead the native is a stable manager opened once, and a routine on the session location switches its
internal resource and bumps a generation, so late events from the old location are dropped:

```ts
const watcher = self.open(async ({ signal }) => new SwitchableWatcher({ signal }), (w) => w.close());
self.routines.on(location.cwd, (cwd) => watcher.value.switchTo(join(cwd, ".notes-inbox")));
```

## Call-scoped natives

A native that lives exactly as long as one call (a temporary SSH session for a directory listing, a file handle for a
download) is opened and closed inside the method with `try/finally`. There is no `ctx.open`:

```ts
list: async ({ path }, ctx) => {
  const session = await ssh.open(config, ctx.signal);
  try { return await session.readDir(path, ctx.signal); }
  finally { session.close(); }
},
```

## Core vs. plugin

`SessionInfo` comes from base code, `NoteInbox` from a plugin; both use the same primitives. Where code lives decides
which it is. **Base code** (the app's `src/`, imported statically by the start code under a fixed name such as
`@studio/core`) is always there, not switchable, and a change restarts the hosts. **A plugin** (its own directory,
found by listing, named by its `package.json`) is switchable and reloads. Core is what the app always needs and
everything builds on: the harness, the session list, access, the session location. Optional features are plugins;
code mode is a plugin.

:::note | Built so far
Natives and host-lifetime objects are layer L4. `constant` is decided (R23), not built.
:::

# Standing Behaviour {#routines lede="Routines, reconciling instead of notifying, and how two owners keep a rule between them without a shared transaction."}

Notes older than 30 days should go every hour. Inbox files should be imported as they arrive. Notes of an archived
session should become read-only. Each of these is behaviour that stands, not a call someone makes. Written as bare
`setInterval`s and event listeners, it would keep running old code after a reload and touch state from nowhere. Chord
has one declared form for it: the **routine**.

## Four kinds

```ts
self.routines.every("cleanup", HOUR, (ctx) => dropOlderThan(30 * DAY, ctx));   // due time survives reloads
self.routines.on(settings, async (value, ctx) => applyLimit(value, ctx));        // a readable or event source
self.routines.loop("import", async (ctx) => {                                     // runs until the object ends
  while (!ctx.signal.aborted) await importNext(ctx);
});
self.routines.custom("ticker", ({ signal, run }) => {                             // anything else
  const timer = setInterval(() => run(tick), 1000);
  return () => clearInterval(timer);                                              // cleanup undoes the setup
});
```

Routines start when the object goes live, stop when it ends, and restart with the new code on every reload of their
plugin. Each run gets its own `ctx`; errors are caught and reported, never uncaught. Routines are named (`on`
optionally by its source) so Chord recognizes them across reloads; that is how `every` keeps its due time.

## Serialized per routine

The new instance of a routine starts only after the old handler in flight has settled; only that routine waits, for at
most the routine handover timeout (10 s), after which it starts anyway and the stuck handler is reported.

The reason, as a trace: a supervisor routine reconciles pending worker restarts. The old handler is midway through
`restart(W1)` when the plugin reloads. Without serialization the new routine starts at once, sees W1 still pending, and
restarts it a second time.

## Reconcile, don't track

A routine **reconciles from the current value**: it makes the world match what it sees now. It writes no "in
progress" flags, and it starts a job for long work (chapter XI). A handler that only cares about the latest value
compares with the current value itself; there is no `overlap` option. Subscribing to the object's own documents is
gapless: every commit is seen.

No bare timers or callbacks that touch state outside routines, jobs or calls. That is what lets Chord stop all of an
object's behaviour when it ends or reloads.

## Rules between two owners

Every thing has exactly one owner, the smallest object it belongs to. Some rules span two: "notes of an archived
session are read-only" involves the catalog (which knows archiving) and `NoteStore` (which holds notes). Two tempting
designs are wrong:

- **A cross-owner transaction** (archive and lock the notes atomically) would make the catalog know every plugin and
  couple their storage.
- **A notification** (`catalog` calls `notes.archive(session)`) can be lost: the worker is not running, the link drops,
  the process crashes between the archive and the call.

The design's rule: **the owner of the dependent data enforces the rule** by reconciling from the other owner's state
with an idempotent routine.

```ts
// NoteStore: an archived session's notes are read-only
const flags = self.state(NoteFlags);                         // { archived: boolean }, NoteStore's own document
const catalog = self.get(Catalog, {});                       // the server's session list: another owner
self.routines.on(catalog.sessions, async (sessions, ctx) => {
  const archived = sessions[session]?.archived ?? false;
  if (flags.value.archived !== archived) await flags.change((d) => { d.archived = archived; }, ctx);
});
// add and remove refuse while flags.value.archived
```

After a crash the routine runs again with the current value. The catalog does not know the notes plugin exists. The
same pattern closes a forward of an archived session in the ports plugin, aborts a job whose grant was revoked
(chapter VII), and keeps any invariant between plugins.

## Reading without starting a worker

The session list in the sidebar shows each session's note count. Getting `NoteStore { S1 }` for every session would
start every worker. The answer is plain publishing between two objects of one plugin, no Chord mechanism: the worker
side reports a summary to a server-side object by a method call from a routine, and clients read the server object.

```ts
// notes/contract.ts
export const NoteCounts = remote("notes.counts", {
  version: 1, input: obj({}), placement: () => Server(),
  variants: {
    owner: { state: { counts: map(int()) } },
    worker: { methods: { report: method(obj({ session: str(), count: int() })) } },
  },
});

// notes/server.ts
const Counts = defineState("notes.counts", {
  schema: obj({ bySession: map(obj({ count: int(), incarnation: str() })) }),
  version: 1, initial: () => ({ bySession: {} }), persist: true,     // survives a server restart
  checkpointWhen: (_v, _o, info) => info.deltasSinceBase > 64,
});

host.serve(NoteCountStore, (_input, self) => {                        // local, lifetime "host"
  const counts = self.state(Counts);
  return {
    counts: self.derive("counts", [counts], ([c]) => mapValues(c.bySession, (e) => e.count)),
    report: ({ session, count, incarnation }, ctx) =>
      counts.change((d) => {
        const last = d.bySession[session];
        if (last && last.incarnation > incarnation) return;               // uuidv7: an older worker, ignore
        d.bySession[session] = { count, incarnation };
      }, ctx),
  };
}, { lifetime: "host" });

host.serve(NoteCounts, (_input, principal, self) => {
  const store = self.get(NoteCountStore, {});
  if (principal.kind === "worker") return {
    variant: "worker",
    report: ({ session, count }, ctx) => {
      if (session !== principal.session) throw forbidden();               // a worker reports only itself
      return store.report({ session, count, incarnation: ctx.incarnation }, ctx);
    },
  };
  return { variant: "owner", counts: store.counts };
});

// notes/worker.ts, inside NoteStore
const counts = self.get(NoteCounts, {});                                   // a reference to the server
self.routines.on(count, (n, ctx) => inVariant(counts, "worker") && counts.report({ session, count: n }, ctx));
```

The server object keeps the latest value per session (in a document if it must survive a server restart) and
**ignores reports from an older worker incarnation** (incarnations are uuidv7, so they order by start time). A worker that was replaced may still deliver a late report; the
fence is the caller's incarnation, which Chord stamps on every call from the link handshake (R20): `ctx.incarnation`,
next to `ctx.principal`, not part of the principal or its key, never sent as data, so it cannot be forged. Session
status, subagent lists, unread marks and artifact lists in p2 all follow this pattern. The store is local and has no
caller incarnation of its own, so the view passes it on as data.

:::review | Review: `ctx.incarnation` across a relay (Q13, open)
A worker's call to the server arrives directly, so `ctx.incarnation` is the worker's. But a call relayed through the
server (a tab's call to a worker) carries the server's incarnation on the worker's side, because the worker's
handshake is with the server. Review round 3 proposes that relays stamp the origin host's incarnation, as they stamp
the principal. Undecided; the pattern above only needs the direct case.
:::

:::note | Built so far
Routines are layer L8. The design treats `every` as one of four forms over one runner; review round 3 proposed cutting
to `on` and `loop` only (C4), not decided.
:::

# Work That Outlives the Call {#jobs lede="Jobs: owned work started by a method that keeps running after its caller leaves, with cancel, dedupe and a recorded outcome."}

Importing a 50 MB text file into notes takes a minute. The tab that started it may close; the import must go on, be
cancellable, not run twice when the tab retries after a link blip, and its result must be recorded. A method cannot do
this (it dies with its caller), a routine is standing behaviour rather than a request, and a Durable task is for work
that must resume after a crash. Chord's form for it is the **job**, built in pi-durable's sandwich: **intent** (a
transaction), **effect** (anything), **outcome** (a transaction in the current code).

## Defining and running a job

```ts
// notes/worker.ts
const ImportJob = defineJob("notes.import", {
  version: 1,
  args: obj({ path: str() }),
  progress: obj({ lines: int() }),
  result: obj({ added: int() }),
  concurrency: 1,                                         // one import at a time per NoteStore
});

const ImportResults = defineState("notes.import-result", {
  schema: obj({ outcome: union([obj({ added: int() }), obj({ error: str() })]) }),
  version: 1, initial: () => ({ outcome: { added: 0 } }), keyed: true,
  checkpointWhen: () => true,
});

host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);
  const results = self.state(ImportResults);
  const imports = self.job(ImportJob, {
    run: async ({ path }, ctx) => {                                       // 2. effect
      let lines = 0;
      for await (const line of readLines(path, ctx.signal)) {
        await addNote({ id: `${ctx.jobId}:${lines}`, text: line, by: "import" }, ctx);   // keyed by job id
        ctx.progress({ lines: ++lines });
      }
      return { added: lines };
    },
    finish: async (outcome, tx) => {                                      // 3. outcome, current code
      (await tx.draft(results, outcome.id)).outcome =
        outcome.kind === "done" ? outcome.result : { error: outcome.error };
    },
  });
  return {
    …,
    imports: imports.running,                                             // live list of runs
    startImport: ({ path, requestId }, ctx) =>
      imports.start({ path }, ctx, { key: requestId }),                   // 1. intent (refined below)
    abortImport: ({ id }) => imports.abort(id),
  };
});
```

`defineJob(name, { version, args, progress, result, concurrency?, persist?, accepts? })`; `progress` and the outcome
are typed by the schemas.

:::sequence animate | The job sandwich. The intent commits before anything runs; the effect runs outside any transaction; the outcome commits in the current code.
actor tab "tab"
actor store "NoteStore { S1 }" accent
actor run "run" "effect" blue
tab -> store: startImport({ path, requestId })
store => store: 1. intent: busy check, dedupe by key, commit
store --> tab: { id }
store -> run: start after the commit
run -> run: read lines, add notes (keyed by jobId)
run --> store: progress { lines } (throttled)
note tab..store: the tab may close here: the job counts as a reference
run --> store: settles: { kind: "done", result }
store => store: 3. record outcome, finish(outcome, tx), ack
:::

## The three steps

**1. Intent.** `job.start(args, ctx, { key? })` is shorthand for `tx.start(job, args, { key? })` inside a
transaction, which may contain other writes. The busy check (`concurrency`) and deduplication (the same key returns the
existing run) are atomic and in the same commit; `run` starts only after the commit. Run ids are uuidv7.

**2. Effect.** `run(args, ctx)` may do anything: processes, network, other objects. It writes no document itself; it
returns the outcome. External writes carry a dedupe key derived from `ctx.jobId` (above: note ids), so an interrupted
attempt cannot apply them twice. On a reload `run` keeps its old code.

**3. Outcome.** When `run` settles, Chord records the outcome in its own record, then calls the **current** code's
`finish(outcome, tx)` and acknowledges the run in the same commit. The outcome is tagged:

```ts
type Outcome<R> = { id: string } & ({ kind: "done"; result: R } | { kind: "failed"; error: "threw" | "aborted" | "lost" });
```

A throwing `finish` changes nothing and is retried with a backoff (1 s to 60 s), and after the next reload. `finish`
is optional and follows Durable's transaction rule.

## Dedupe ends with the run

Deduplication covers **unsettled runs only** (Q9). Once `finish` has committed, Chord drops the run's record and key
and releases its waiters' references; it keeps nothing beyond a run's lifetime. Dedupe after completion is the
owner's. Studio records which run a request started, in the same commit as the intent, and `finish` records the
result by run id (`ImportResults` above):

```ts
const Requests = defineState("notes.import-request", {
  schema: obj({ run: str() }), version: 1, initial: () => ({ run: "" }), keyed: true, persist: true,
  checkpointWhen: () => true,
});

startImport: async ({ path, requestId }, ctx) => {
  const prior = await requests.get(requestId);                  // read outside the transaction (R13)
  if (prior) return { id: prior.run };                          // started before, maybe finished long ago
  return self.tx(async (tx) => {
    const run = await tx.start(imports, { path }, { key: requestId });   // dedupes a concurrent retry
    (await tx.draft(requests, requestId, { tags: [SessionTag(session)] })).run = run.id;
    return { id: run.id };
  }, ctx);
},
```

Two concurrent retries both miss `prior`, but the key makes `tx.start` return the same unsettled run. The client
watches `imports` for progress and reads the result by run id once it is gone from `running`.

Why Chord does not keep completed runs itself: either 100,000 keyed imports would stay in memory forever, or a
retention limit would let a retried key rerun its effect. The owner knows which results matter.

## Watching, waiting, aborting

- **`running`** is a readable of `{ id, version, args, progress, phase }`. `phase` is `running`, `finishing` (outcome
  recorded, `finish` not yet committed) or `blocked` (with the reason). `concurrency` counts only active runs. The
  panel shows a progress bar from it.
- **Progress** is in memory, throttled and sent as deltas. For output, use `OutputBuffer` and `Progress` from
  `@earendil-works/chord/output`: bounded windows, adaptive throttling, no write amplification.
- **Waiting:** `start` returns a run with `outcome(ctx)`. The caller's abort ends only its wait, never the run.
- **Abort is a request:** `job.abort(id)` fires the run's `ctx.signal`; the run decides what it returns (a result
  that already arrived stays a success). A run that ignores the signal keeps its slot until it ends. `finish` runs in
  Chord's own context.

## Lifetime, persistence, revocation

**Jobs keep their owner alive.** A running, finishing or blocked job counts as a reference to its object, which ends
only once all its jobs are settled. Starting an import and closing the tab does not abort it. Unsettled runs also
count as activity for the worker's keep-alive.

**Revocation takes precedence** (R11). Revoking a principal ends its objects at once, whatever jobs remain; the jobs
get the abort signal and the normal close timeout. A job runs as its object's principal.

**Persistence:** jobs are in memory by default and gone with the process. `persist: true` (only for stable
identities) keeps the record: a run live at a crash ends `lost` at the next activation and `finish` records it.
Nothing is rerun automatically.

**Versions:** a run started under an older job version keeps its version; `finish` and `running` see it through pure
`accepts` adapters, and stored outcomes are never rewritten. A version bump without an adapter does not refuse the
reload: the old outcome is `blocked`, kept and reported until a later reload brings the adapter.

**Native objects:** a job in a native object ends `aborted` when the object restarts on a reload (chapter XV). In a
pure object it keeps running on its old `run` code.

## What is not a job

| Work | Use |
| --- | --- |
| request and response that may die with its caller | a method |
| input into running work (a pasted code, an approval) | a flow (chapter XII) |
| work that must resume after a crash | a Durable task |
| standing behaviour | a routine |

:::review | Review: jobs are the largest open simplification (#9, C3)
Decision #9 (deferred until login is ported): a login or a long relocation is a job whose state consumers want to
address and watch (`LoginFlow { id }`). Options: (a) jobs stay records inside their owner, watched through `running`;
(b) a job is an object of its own, addressed by its id, living until done. Separately, review round 3 proposed cut C3:
shrink jobs to a runner over documents (no job versions, `accepts`, `blocked`, `persist`) or move them out of the
kernel. Not decided. `chord-next-walkthrough.md` concept 17 still shows the older outcome shape `{ ok: true, result }`;
the design tags outcomes by `kind`.
:::

# Asking a Person {#flows lede="Flows and the Questions service: how running work waits for an answer from someone who may be on any tab, may reconnect, and may answer twice."}

A provider login asks for a pasted code, then an account choice. A dangerous tool call waits for the owner's
approval. The agent asks everyone present a question. In each case running work waits for a person, who may be on any
tab, may lose the connection halfway, may answer late or twice. Two patterns cover this: a **flow** kept as its
owner's state, and the **Questions** service, a shared store for questions.

## A flow is state, not a call

The tempting design is a long-held server call, `step()`, that blocks until the next step. A link drop fails it, and
the consumer cannot tell whether it missed a step. Chord's answer is that the owner keeps the flow as **state**, which
re-holds by itself after any drop:

```ts
// models/contract.ts (sketch from the design)
start:  method(obj({ provider: str() }), obj({ id: str() }))              // uuidv7
answer: method(obj({ id: str(), step: int(), value: str() }), Answered)   // ok | "step no longer active"
cancel: method(obj({ id: str() }))

// LoginFlow { id }: state
type FlowState =
  | { kind: "running"; step?: { id: number; prompt: LoginPrompt }; notices: Notice[] }
  | { kind: "done" | "failed" | "cancelled"; notices: Notice[] };
```

The UI watches the state and renders the current step. A late or second answer to a step that is gone is refused. A
promise-based callback inside the work (pi-ai's `prompt` during a login) stays **inside** the owner: its job keeps the
resolver, and nothing crosses an object boundary.

Imperative consumers (tests, scripts, a CLI, an agent tool) use a generic client helper over the same state, not a
second protocol:

```ts
async function* steps(flow: LoginFlowRef, ctx: Ctx) {
  let last = 0;
  for (;;) {
    const s = await until(flow.state, (v) => v.kind !== "running" || (v.step !== undefined && v.step.id > last), ctx);
    if (s.kind !== "running") return s.kind;
    last = s.step!.id;
    yield s.step!;
  }
}

for await (const step of steps(await ctx.get(LoginFlow, { id }), ctx))
  await login.answer({ id, step: step.id, value: answerFor(step) }, ctx);
```

`last` keeps steps from being lost or repeated across re-holds.

:::review | Review: where a flow lives (#11, deferred)
Decision #11, deferred until login is ported: (a) a keyed document of its owner, or (b) an object `LoginFlow { id }`
living until done; tied to #9 (jobs as objects). The `LoginFlow { id }` address above assumes (b). Also undecided is
how "leaving" ends a login (p2 cancels when the starting owner leaves everywhere); with presence it is a dropped
reference, never an unmount (chapter VIII).
:::

## The Questions service

The Questions service (`apps/p2/docs/questions.md`) is a p2 design, not a Chord feature, built from Chord's
primitives: a shared store with per-principal views. The asker gets `ask`; viewers get the open questions and
`answer`.

```ts
export type Question =
  | { kind: "text"; message: string; secret?: boolean; help?: string }
  | { kind: "select"; message: string; options: readonly { id: string; label: string }[] }
  | { kind: "confirm"; message: string; allow: string; deny: string };

type Policy = { mode: "first" } | { mode: "quorum"; count: number } | { mode: "all"; join?: "live" | "snapshot" };

ask(question, {
  audience,                // a readable or a list of principals
  policy,
  key?,                    // stable per asking flow: a re-ask reattaches to the pending question
  deadline?,               // then resolve with what is there; `missing` names who did not answer
}, ctx): Promise<Result>;
```

Its rules:

- **The store is the truth.** Pending questions and their resolvers live in the store; `open` is a readable over it,
  filtered per viewer. Nothing is a document, so a reload or migration cannot leave a ghost question.
- **One settlement point.** Register the waiter and the abort listener before publishing the question; an answer, an
  abort or the deadline atomically takes the entry out before resolving. A late or second answer gets "no longer
  active". Answers are validated against the stored question (a select id must be one of the options). Never await an
  answer inside a transaction.
- **Policies over a live audience.** `first` resolves with the first answer; `quorum(n)` after n answers; `all` when
  every member of the audience has answered. With `join: "live"` (the default), someone who joins becomes required and
  someone who leaves drops out.
- **Authorization.** The asker is stamped by the host (a worker asks only in its own session's scope; secret questions
  only from server askers). Each question stores who may answer it; a guest's send access does not imply approval
  rights. Secret answers never appear in `open`, documents or logs.
- **Link drops and crashes.** A rejected `ask` is not a denial. Askers retry with the same `key` until their own signal
  aborts; a pending `ask` counts as an active call for keep-alive.
- **Where it lives.** On the host where the asking work runs: session questions on the session's worker, login
  questions on the server. UIs reach both through the usual relay.

The store in Chord v2 terms:

```ts
host.serve(QuestionStore, ({ scope }, self) => {
  const pending = self.open(async () => new PendingQuestions(), (p) => p.rejectAll("store closed"));
  const open = self.derive("open", [pending.value.readable], ([all]) => all);   // data only, no resolvers
  return { open, ask: (args, ctx) => pending.value.ask(args, ctx), answer: (args, ctx) => pending.value.answer(args, ctx) };
});

host.serve(Questions, ({ scope }, principal, self) => {
  const store = self.get(QuestionStore, { scope });
  if (isHost(principal)) return { variant: "asker", ask: (args, ctx) => store.ask({ ...args, asker: principal }, ctx) };
  if (!mayView(principal, scope)) throw forbidden();
  return {
    variant: "viewer",
    open: self.derive("mine", [store.open], ([all]) => openFor(all, principal)),
    answer: ({ id, value }, ctx) => store.answer({ id, value, by: principal }, ctx),
  };
});
```

The pending map with its resolvers is in-process state with promises, so it is a native of the store (opened and
closed with it). Its `close` rejects every waiter; askers retry with their key against the new store after a reload.

:::review | Review: questions.md predates the v2 rules
`apps/p2/docs/questions.md` writes the store as `self.resource(...)` with a `replace` hand-over, which the design
rejected ("resources replaced in place"), and opens Chord call scopes in Durable hooks with `host.root`, which Q6
replaced with `chord(fn, context)` (chapter XIV). Design §20 says the Questions store "must live in an object (it
predates natives only in objects)". The sketch above is this guide's translation, with the derive per viewer; filtering
per viewer in the store, once per variant, may be cheaper for large audiences. The `ask` signature passes typed
objects as arguments, which is fine (data), but the `audience` readable form cannot cross a link: across links,
audience must be data (principals) or computed by the store.
:::

## Choosing

| Case | Use |
| --- | --- |
| a multi-step login in one owner | a flow: the owner's job keeps the resolver, state shows the steps |
| a tool needs the owner's approval | Questions, `first`, audience the owner |
| the agent asks everyone present | Questions, `all`, audience from presence |
| deploy needs 2 of 3 approvals | Questions, `quorum(2)` |
| a notice (auth URL, device code, progress) | not a question: the asking work's own progress state |

# Extension Points {#registries lede="The facet, registries and the HTTP component: how plugins add behaviour to each other without callbacks, and how the owner stays in charge."}

The notes plugin wants a download route, `GET /s/:session/notes.txt`. A logs plugin wants to time every request.
Several plugins add model providers, tools for the agent, commands for the TUI. Someone must combine these
contributions, decide conflicts, and replace one plugin's part as a whole when it reloads. Between plugins exactly two
things pass: object types and **registries**.

## The facet, completed

The facet has appeared since chapter II as the place that serves types. It is also itself a **pure object** with the
host's lifetime:

```ts
// notes/server.ts
export default defineFacet((host, self) => {
  const prefs = self.state(NotesPrefs);                                  // plugin-wide documents
  self.contribute(Http, { routes: { "GET /s/:session/notes.txt": exportNotes } });
  host.serve(NoteCountStore, …, { lifetime: "host" });
  host.serve(NoteCounts, …);
});
```

- It may hold documents, references, routines and contributions; **no natives** (those need an object with its own
  lifetime).
- Its identity is the plugin's name, so its persisted documents survive restarts and reloads.
- Served objects go live after the facet and may read and write its documents (chapter V).
- `host.serve` and `self.contribute` are valid only while the setup runs. The facet never `self.get`s a type it
  serves.

## Registries

A registry is an extension point owned by someone (a Chord component, the app, a plugin). Each contributor
contributes **at most one value** per registry; the table is an immutable, ordered list of `(contributor, value)`;
the registry's `compose` turns it into the value consumers use.

```ts
// owned by the HTTP component
export const Http = defineRegistry<HttpContribution, Router>("chord.http", {
  version: 2,
  accepts: { 1: (old: HttpContributionV1): HttpContribution => upgrade(old) },
  compose: (table, { report }) => buildRouter(table, report),   // pure; always delivers a value
});

self.contribute(Http, { routes: { … }, wraps: [ … ] });          // a contributor
const router = host.registry(Http).value;                        // a consumer: live
```

**`compose` runs at runtime, whenever the table changes:** after a reload's commit, when a contributor goes live or
ends, when a contribution changes. It is not a staging check: contributions can be dynamic (known only once a native
is open), so no check before a reload could be complete. `compose` always delivers a value with its fallback built in
(e.g. the first by plugin name wins) and reports conflicts through `report`, which become owner notices and telemetry
events. Readers get a plain value and never handle conflicts. Only if `compose` throws is the registry in an error
state, and readers get an error when they use it. Work that started earlier keeps the value it read.

**Rules:**

- **Who contributes** (R21): only facets and `lifetime: "host"` objects; only their `self` has `contribute` (a type
  error elsewhere). Every object may read registries.
- **A contribution is in the table exactly while its contributor is live:** a facet's while its plugin is loaded; an
  object's from `live` until it ends, fails or restarts.
- **Order** is sorted by plugin name: deterministic on every host and across reloads, and deliberately meaningless.
  Meaningful order comes from the owner's composition (HTTP phases, below). Helpers: `keyed(table, entriesOf)`,
  `ordered(table, itemsOf, orderOf?)`.
- **One authoritative declaration** (Q8): only the defining plugin's facet declares the registry to the host
  (`compose`, version, `accepts`). Other plugins' tokens only identify it by name and types. A reload of the defining
  plugin replaces the declaration atomically and the table recomposes. If the defining plugin is not loaded, the
  registry has no value (readers get an error like a failed reference) and contributions wait in the table.
- **Versions** (Q8): a contribution carries the registry version its plugin was built against; older ones are adapted
  by the defining facet's pure `accepts`. One without a matching version or adapter is left out and reported naming
  plugin, registry and versions; its plugin keeps working. Contributions are in-process values (often functions) and
  are not schema-checked.
- **Use sites guard contributions.** A contribution is untrusted code (third-party plugins are a goal). Every use site
  catches throws and rejections when calling an entry, reports naming the contributor, and continues with the others.
- **The owner decides** conflicts, order and selection. Registries add behaviour; they never replace an owner's checks.

## Natives through registries

Registries are the only way a native reaches another plugin. An entry lives exactly as long as its contributor;
consumers look up at each use (or follow the composed value) and keep nothing from an entry beyond a use. The models
plugin's host-lifetime object contributes its runtime; the harness looks it up at every request. After a models reload
the next request gets the new runtime, while a running stream finishes on the old one.

A handler that stores `const r = entry()` in a module variable and uses it for days has a bug: after the contributor
restarts it holds a closed native.

## Contributions that change

Some contributions are known only at runtime: MCP tools appear when a server connects. A contribution is either fixed
for its contributor's life (dynamic parts behind handles read at use) or a **readable**, which Chord subscribes to;
on every change Chord replaces that entry and runs `compose` again. For in-process values, `self.writable(initial)` is
a host-local readable of any value (no JSON, no wire, compared by identity) with `set`:

```ts
const ext = self.writable(mcpExtension([]));                   // a Durable Extension, no tools yet
self.contribute(HarnessExtensions, ext);
self.routines.on(mcp.tools, (tools) => ext.set(mcpExtension(tools)));
```

There is no remove call. An entry leaves when its contributor ends, or after a reload whose new code no longer
contributes. A live contributor with nothing to offer sets its readable to the registry's empty value (an extension
without tools, empty routes); the table keeps exactly one entry per live contributor.

## Optional dependencies

Registries also replace optional references (chapter VI). Radius forwards connections to ports the ports plugin
manages, but ports is optional. So radius owns `radius.forwards` and ports contributes its forwards; without ports the
table is empty and radius works.

## The HTTP component

HTTP is an optional Chord component (`@earendil-works/chord/next/http`) built on a registry. A route gets a plain
request summary (method, path params, query, principal, provenance such as local or relayed, selected headers, parsed
and capped JSON bodies, uploads in chunks) and a `ctx` whose `principal` is the request's, so `ctx.get(Notes, …)` gives
exactly the view that person may see. The route returns a description; the component does the HTTP work once (ranges
with 206 and 416, HEAD, download headers with a safe filename, `nosniff`, CSP and its nonce, caching, streaming, abort
on disconnect):

```ts
type HttpResponse =
  | { kind: "json"; value: JsonValue } | { kind: "page"; title: string; body: string }
  | { kind: "bytes"; name: string; mime: string; size: number; read(offset: number, length: number): Promise<Uint8Array> }
  | { kind: "redirect"; to: string } | { kind: "error"; status: number };

// notes/server.ts
self.contribute(Http, {
  routes: {
    "GET /s/:session/notes.txt": async (req, ctx) => {
      const notes = await ctx.get(Notes, { session: req.params.session });   // the requester's view
      const text = new TextEncoder().encode(render(notes.notes.value));
      return { kind: "bytes", name: "notes.txt", mime: "text/plain", size: text.byteLength,
               read: async (offset, length) => text.subarray(offset, offset + length) };
    },
  },
});
```

Routes compose with `keyed`: two contributors with one pattern is a reported conflict, and the first by plugin name
wins. **Wraps** are middleware in phases the owner defines (`observe`, `headers`, `transform`, outermost first),
within a phase in contributor order. No numeric priorities: plugins have no single registration order, so Fastify's
lifecycle phases and encapsulation are the model, not Express.

```ts
// logs/server.ts
self.contribute(Http, {
  wraps: [{
    name: "access-log", phase: "observe", scope: "all",          // default scope "own": only own routes
    wrap: async (req, next, ctx) => {
      const t = Date.now();
      const res = await next(req);
      log(req, res, Date.now() - t);
      return res;
    },
  }],
});
```

`route` narrows a wrap to one route; a `route` that does not exist is a reported conflict. Wraps may add a security
boundary on top of an owner's checks, never instead of them. A request uses the router as it was when it started.
Request resolvers (who sent a request: cookie, loopback, relay) are hooks over the summary.

## Channels and big bytes

**Channels** are WebSocket byte channels (`send`, `onData`, `close`) for terminals, separate from object links and
with their own acknowledged windows, so a large state message never holds up keystrokes.

**Big transfers are chunked by the owner,** not by Chord: bytes are a schema type (`bytes()`), carried natively
(never base64), and a 50 MB upload is a protocol of plain calls:

```ts
beginUpload({ name, size }, ctx)               → { upload }
append({ upload, offset, bytes }, ctx)         // about 1 MiB per chunk; the awaited call is the backpressure
finishUpload({ upload }, ctx)                  → { id }
read({ id, offset, length }, ctx)              → bytes
```

After a link drop the `append` in flight fails like any call; the writer asks the owner for the stored offset and
resumes. Unfinished uploads expire through the owner's routine. Chord has no stream type: it would need its own rules
for drops, cancellation, relays and restarts, which this offset protocol already survives.

:::note | Built so far
Registries are layer L9. The HTTP component, channels and the chunked-transfer helper are deferred until after the
kernel and a first real proof (the harness, one tool with an approval pause, a code mode reload); until then the
playground serves its pages with plain app code. Their design stays the target.
:::

# The Agent {#agent lede="pi-durable inside Chord: the harness as a core object, models, environments and tools through registries, and how a tool reaches Chord objects and people."}

Each Studio worker runs a pi-durable harness for its session. The harness must run for the worker's whole life,
whether anyone watches or not. Its models come from the models plugin, its execution environments from the envs
plugin, its tools from every plugin, and all of those reload independently. This chapter assumes you know pi-durable
and shows only how it plugs into Chord.

## Shared foundations

Durable and Chord v2 share modules: Durable imports Chord's `context`, `delta`, `json`, `output` and `sqlite`, and v2
imports the same, so `Context`, `Draft` and `JsonValue` are one type each. A v2 readable is today's
`replicatedState` (`chord/src/state.ts`), so Durable's `viewState()` and document watches can be exposed as Chord state
members without conversion. Only plain data crosses between Durable and Chord objects.

## The harness is a core object

```ts
// studio/src/core/harness.ts (base code)
import { Harness as DurableHarness } from "@earendil-works/pi-durable";

export const ChordHostKey = createContextKey<Host<P>>("studio.chord-host");
export const HarnessModels = defineRegistry<Models, Models>("studio.harness-models", { version: 1, compose: firstModels });
export const HarnessEnvironments = defineRegistry<EnvFactory, EnvFactory>("studio.harness-envs", { version: 1, compose: firstEnv });
export const HarnessExtensions = defineRegistry<Extension, RegistrySnapshotSource>("studio.harness-extensions", {
  version: 1,
  compose: (table, { report }) => extensionSnapshot(table, report),      // one Durable Extension per plugin
});
const HarnessRuntime = defineRegistry<() => DurableHarness, () => DurableHarness>("studio.harness-runtime", {
  version: 1, compose: onlyEntry,                                        // core-private: one contributor
});

host.serve(Harness, (_input, self) => {
  const info = self.get(SessionInfo, {});
  const harness = self.open(async ({ signal }) => {
    const { id, dataDir } = info.init.value;
    const base = withContextValue(ChordHostKey, host, withAbortSignal(signal, BACKGROUND_CONTEXT));
    return DurableHarness.open(await openNodeSqliteStorage(join(dataDir, id, "durable.sqlite")), {
      models: () => host.registry(HarnessModels).value,                  // read at each use
      env: (target) => host.registry(HarnessEnvironments).value(target),
      settings: () => currentSettings(),
      registry: durableRegistry(host.registry(HarnessExtensions)),      // a RegistryReader over the composed value
    }, base);
  }, (h) => h.close(BACKGROUND_CONTEXT));
  self.contribute(HarnessRuntime, () => harness.value);                 // for core's conversation objects
  return { … };
}, { lifetime: "host" });
```

- **Lifetime `"host"`:** it runs for the worker's whole life, also while nobody holds it, because Durable tasks
  continue.
- **Base code:** it lives in the core facet, so a plugin reload never restarts it; only a base-code change (a host
  restart) does.
- **Registries, looked up at each use:** Durable's `models` and `settings` accept functions (pi `7ec1f648e`), so each
  generation gets the current value. After a models reload the next request uses the new runtime; a running stream
  finishes on the old one.
- **Durable's storage is its own.** Chord documents never commit together with Durable transcripts.

The design writes the call as `Durable.open(storage, { … })`; pi-durable's actual entry point is
`Harness.open(storage, options, context)`, used here as `DurableHarness` to keep it apart from the core object
`Harness`.

## Start order

At host start Chord loads every facet and waits until every facet and every `lifetime: "host"` object **other than the
harness** is live or failed: the **start barrier**. Then the registries hold the contributions of every plugin that
loaded, and the harness opens and resumes scheduling (R17). An object that must contribute at start, like the model
runtime, is therefore `lifetime: "host"`. Nothing waits for specific contributions; what is missing shows where it is
used:

| Missing | What happens |
| --- | --- |
| a tool | its call gets an error result the model sees |
| a model | the generation reports "model unavailable" and waits, not fails, until a model appears |
| a task definition | the task stays blocked (`missing_task`) until the plugin is installed or the task is aborted |
| a plugin that failed | reported with its error; a facet in backoff contributes later and the registries recompose |

The same holds when a session's database is copied to an instance with other plugins: missing tools, sections and
hooks are skipped, documents of missing plugins stay untouched, stored selections are never rewritten. The UI must
show blocked tasks with their reason and offer to abort them; a turn waiting on one hangs until then.

:::review | Review: the harness exception to the barrier (C17, R17)
R17 makes the harness start after the barrier, a special case in the barrier's rule. Review round 3 proposed cut C17:
no harness-specific exception; the harness is an ordinary object the app's start code holds after `load` resolves.
Not decided. `chord-next-walkthrough.md` concept 28 still says the harness's activation *is* the start barrier, which
R17 replaced.
:::

## Tools that call Chord

Durable tools, hooks and sections receive Durable's `ToolExecutionApi` (or `HookApi`) and a `Context`, never a Chord
`ctx` (Q6). Core put the host into the harness's base context under `ChordHostKey`, and every phase context inherits
it. A core helper opens a Chord call scope from any Durable context:

```ts
// studio/src/core/chord.ts
export function chord<T>(context: Context, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const host = context.value(ChordHostKey);
  if (!host) throw new Error("not inside the Studio harness");
  return host.root(fn, { signal: context.abortSignal, telemetry: context.telemetry });
}
```

The scope runs as the host principal; attribution is data; references taken with `ctx.get` are released when `fn`
settles. There is no wrapping of tools and no app-specific `defineTool`. The notes plugin gives the agent a tool:

```ts
// notes/worker.ts
const addNote = defineTool({
  name: "notes_add",                                         // tools are named <plugin>_<name>
  description: "Add a note to this session's notes panel",
  parameters: Type.Object({ text: Type.String({ maxLength: 2000 }) }),
  execute: (args, api, context) => chord(async (ctx) => {
    const info = await ctx.get(SessionInfo, {});
    const store = await ctx.get(NoteStore, { session: info.init.value.id });
    const id = await store.add({ text: args.text, by: `agent:${api.conversationId}` }, ctx);
    return { output: [{ type: "text", text: `added note ${id}` }] };
  }, context),
});

export default defineFacet((host, self) => {
  self.contribute(HarnessExtensions, defineExtension({ name: "@studio/notes", tools: [addNote] }));
  …
});
```

A reload of the notes plugin replaces its extension in the table; Durable pins a registry snapshot per task phase, so
a tool call already running finishes on the old code and the next phase uses the new one.

## Tools that need a person

Clients are not addressable, so a tool cannot call the user's tab. A tool that needs the user goes through an owner's
state: the Questions service (chapter XII). The model-facing `ask_user` tool and an approval hook both call
`Questions.ask`; tabs render the open questions and answer them.

```ts
hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    if (!needsApproval(call)) return undefined;
    const decided = await api.memo<boolean>("approval", context);       // a rerun does not ask again
    if (decided !== undefined) return decided ? undefined : { block: "Denied" };
    const allowed = await chord(async (ctx) => {
      const q = await ctx.get(Questions, { scope: { session } });
      for (;;) {
        try {
          const r = await q.ask(
            { kind: "confirm", message: `Run ${call.name}?`, allow: "Allow", deny: "Deny" },
            { audience: approvers, policy: { mode: "first" }, key: api.taskId },
            ctx,
          );
          return r.answer;
        } catch (error) {
          if (ctx.signal.aborted) throw error;                          // a link blip is not a denial: retry
          await backoff(ctx);
        }
      }
    }, context);
    await api.memo("approval", allowed, context);
    return allowed ? undefined : { block: "Denied by the user" };
  },
});
```

Durable runs `beforeTool` in the tool task's call phase; after the execute checkpoint a crash retries execution
without hooks, so the stored decision covers that retry. The approval must cover the final arguments: put the
approval hook after hooks that rewrite arguments.

## Conversations for the UI

Chat panels need a conversation's live view, submit, steer, stop. The design leaves p3's conversation API to the p3
design; one construction that follows the rules: a core `ConversationStore { conversation }` (local) opens the Durable
watch as its own native, getting the Durable harness from the core-private `HarnessRuntime` registry contribution (a
native may reach another object only through a registry entry), and exposes a bounded window as a derive. Per-principal
`Conversation { session, conversation }` views in front of it check who may send (chapter XIX).

## Code mode

Code mode is a plugin. It owns its `pi-codemode` sandbox as a native; its tool entry looks up the **current** sandbox
when `execute()` starts, so a call pinned by a phase before a reload (waiting in an approval hook, say) starts on the
new sandbox. On `reload` and `stop` the old sandbox is sealed and drained in `close`: running scripts finish or hit
their deadline, for at most 30 s (Q7). After a worker stop Durable replays as it does today.

## What lives where

| Data | Where |
| --- | --- |
| transcript-bound: entries, documents that fork and rewind with a conversation | Durable |
| app state: session list, notes, drafts, grants, settings | Chord documents |
| data core enforces on conversations (read-only one-shots, cwd followers) | a core per-conversation policy document, written when the conversation is created (`createConversation({ init })`) |

**Telemetry:** pass the host's adapter as `HarnessOptions.telemetry`; Durable stores trace carriers on submissions and
tasks (chapter XVII).

# Reload and Rollout {#reload lede="What happens when you press Reload: per host, per object, and across the server, the workers and every tab."}

Back to the preface. Mario changed the notes plugin's sort order and pressed Reload. Everything the earlier chapters
asked of plugin authors (synchronous factories, natives only in objects, routines instead of timers, data in
documents) exists so that this moment is safe. This chapter shows what Chord does with it.

## On one host

```text
1. load      new bundles; an import or syntax error rejects
2. staging   facet setups and every live object's new factory run with a recording self
             (declarations only, nothing activated); any throw rejects
3. commit    the host switches to the new code atomically
4. after     per object: pure objects swap, native objects restart
```

**Rollback is all-or-nothing per host.** Any load or staging error leaves the whole host on its previous code, so a
host is always completely at one revision and its status is one value. Runtime states (a registry conflict, a failed
open, a migration) are not reasons to roll back; after the commit, errors stay with one object. There is no factory
trial, no migrate dry run, and no consumer contract check in staging: an incompatible consumer fails at bind with
`contract_mismatch` and a notice naming plugin and type.

:::steps | Reloading @studio/notes on worker S1, object by object
+++ Load and stage
The new bundles load. The facet setup and the factories of `Notes` (three views), `NoteStore { S1 }` and `NoteInbox`
run with a recording `self`: they declare, nothing activates. Nothing throws, so the host commits to the new code.
+++ NoteStore: pure, swapped in place
`NoteStore` has no `self.open`. Its new methods and derives take over; `NoteList`, the drafts, its references and the
running import job stay. Routines restart, serialized: the new `cleanup` waits for the old handler in flight. The gate
opens.
+++ Running calls finish on old code
An `add` that was running when the swap happened finishes on the old code with its old handles; its transaction still
commits. Only new calls get the new handles. Exception (R15): if the reload raised a document's version, old code that
touches the migrated document throws, the document stays intact, and that call fails once.
+++ The import job keeps its old run
The job's `run` keeps the code it started with. When it settles, the **new** `finish` records the outcome.
+++ The views: pure, swapped
The three `Notes` views swap in place. Owner, Ann and Bob keep their references; the reader derive is recomputed with
the new sort and the difference is sent. Nobody sees a reconnect.
+++ NoteInbox: native, restarts
`NoteInbox` has a watcher. Its running work ends `aborted`, the watcher closes with reason `reload`, the new factory
runs, the watcher reopens. Its documents would stay. Whether a file dropped during the restart is seen is the
watcher's business: Studio's `watchDir` scans the directory once when it opens.
:::

**Why natives restart instead of being handed over:** a native has no line, no transactions and no schema. If old and
new code shared it, they would interleave on it unchecked. In practice restarts are cheap: the Durable harness is base
code, terminal PTYs live in a separate terminal host process, and model runtimes, sandboxes and a search index rebuild
in milliseconds. Only reloading the plugin that owns SSH connections (running remote commands die) or the relay socket
(relayed connections drop) hurts.

**Removing a type:** its objects end (routines stop, natives close, references end with an error); in-memory documents
go with them; persisted ones stay until retired. **Consumers elsewhere** see a restarting object like any object that
briefly goes away: `loading`, parked calls, then `live`.

**UI facets reload too.** A reload unmounts and remounts components. That is why "leaving" (abort a login, close an
overlay) is never derived from an unmount (chapter VIII).

## Across hosts

A **revision** is (server incarnation, sequence) and names the complete desired code set: every facet with its
digest, not a batch of changes. Every install reconciles everything missing, and a host reports a revision only when it
runs that complete set. A revision also carries the code-set digest (a hash over the facet bundles' content hashes),
so a server restart with unchanged code triggers no reinstall.

The order is **server, workers, clients**. Each host reports `installed`, `installed_failed` (with the objects that
failed) or `rejected` (with the reason; it stays on its previous code). A server that rejects stops the rollout. A
host that starts or reconnects installs the current revision before anything is routed to it. Installs are serialized
per host and bounded (60 s).

Calls keep flowing during a rollout. When a call reaches a provider on another revision, the mismatch response
carries the provider's revision and status:

| Provider | The call |
| --- | --- |
| ahead, or behind and installing | `updating`: values readable, calls park (with the park deadline) |
| rejected | fails at once; retried on the next revision |
| same revision | `contract_mismatch`: a real mismatch, final |

A host checks its own install status first: if its own install was rejected, a call fails at once with the reason
instead of waiting on a provider. Calls parked on a binding that is released end with an error and are not resent.
There are no cross-host transactions and no votes.

:::sequence animate | A tab calls into a worker that is still installing. The call parks and runs once the worker reports the revision.
actor tab "tab" "revision 8"
actor server "server" "revision 8" accent
actor worker "worker S1" "installing 8" blue
server => worker: install revision 8
tab -> server: call Notes.add (new contract)
server -> worker: relay
worker --> server: updating (rev 7, installing)
server --> tab: updating
tab -> tab: park (deadline 60 s)
worker --> server: installed 8
server --> tab: provider at 8
tab -> server: call Notes.add (resent from park)
server -> worker: relay
worker --> tab: result
:::

## Start barrier

At host start and first load there is one more rule (chapter XIV): load every facet (the core facet with its start
data among them), wait until every facet and `lifetime: "host"` object other than the harness is live or failed, then
resume dependent work. Plugin reloads need no barrier.

## Loading and the dev loop

- **Roots:** plugins come from built-in, global (`<data>/plugins`), package (npm or git, installed with
  `--ignore-scripts`) and project roots, found by directory listing; no source parsing. The server selects which load.
  Dependencies between plugins resolve by contract name at runtime. Names are prefixed: objects `<plugin>.<name>`,
  tools `<plugin>_<name>`.
- **Loader D:** one base bundle per surface (host packages and the app runtime) plus one script per facet, with host
  packages passed in (no module map). Old generations are reclaimed by the garbage collector; a stable filename per
  (facet, digest), and V8's compilation cache off on hosts that reload in place. The loader is an adapter: static
  imports (tests, Durable Objects) work the same, with the app passing the plugin name to `load`.
- **Dev loop:** a source watcher marks plugins dirty and never applies anything. A reload control (the playground's web
  shell, a CLI, an agent tool such as p2's `reload_plugins`) reloads the changed plugins, or restarts all hosts for
  base code. Reloads are always explicit.

:::review | Review: project plugins (#14, deferred)
Per-directory plugins with trust prompts and snapshots (`apps/p2/docs/plugin-loading.md`, still the reference for
roots, trust and scopes) need their own pass over this design. Until then, treat the project root as designed but not
settled.
:::

:::note | Built so far
Reload and rollout are layer L10, the last before telemetry. The frozen kernel has a reload path with host values and
a development freeze, both removed from the design.
:::

# Changing Contracts {#contracts lede="How a contract gets a new version while old tabs, old workers and old plugins are still talking to it."}

Chapter XV ended with a tab that calls into a worker on another revision. That case is short-lived: the rollout
finishes and both sides run the same code. Other cases last longer. A phone kept a tab open overnight with yesterday's
web bundle. A plugin from another author was built against `Notes` version 1 and is not updated yet. In both, a
consumer holds a contract that the provider no longer has. This chapter is about what the provider does then. It is
also the one part of Chord v2 that is built: everything in the sections on `evolve`, `checkAccepts` and fingerprints
runs today in `packages/chord/src/next/contracts/`.

## What has a version

Everything that is stored or crosses a boundary has a version. Each surface handles an old version its own way:

| Surface | Version | When an old one shows up | Chapter |
| --- | --- | --- | --- |
| object type (contract) | `version` plus fingerprint | `evolve` and `checkAccepts` on the provider; otherwise `contract_mismatch` | this one |
| document | `version` plus schema fingerprint | pure `migrate` on access; a schema change without a bump fails the object `broken` | V |
| job | `version` | `accepts` on outcomes and `running`; `blocked` without an adapter | XI |
| registry | `version` | `accepts` adapts contributions; one without a match is left out and reported | XIII |
| native | none | the object restarts on reload | IX |
| Durable tasks and documents | Durable's `version` | Durable's `migrate` | XIV |
| link protocol | protocol version | refused; hosts update together, a web page reloads | XVII |
| UI components, Chord and app APIs | none yet | exposed as they are; an SDK will version them later | |

The rule behind every row is the same as for documents: **every change bumps the version**, additive ones included.
Chord never guesses compatibility from the shape of two schemas.

## A history, not a file of versions

A contract history starts with a **base**: a full `remote()` or `local()` declaration with an explicit `version`. The
`Notes` contract from chapters II and III is a base at version 1. Studio now wants pinned notes: notes get a `pinned`
flag and editors get a `pin` method. Instead of editing the declaration, the plugin continues the history:

```ts
// notes/contract.ts
import { bool, evolve, nul } from "@earendil-works/chord/next";

export const NoteV2 = obj({ id: str(), text: str({ max: 2000 }), by: str(), at: int(), pinned: bool() });
export const PublicNoteV2 = obj({ id: str(), text: str(), at: int(), pinned: bool() });

export const NotesV2 = evolve(Notes, (e) =>
  e.state("editor", "notes", obj({ items: arr(NoteV2) }))
    .state("reader", "notes", obj({ items: arr(PublicNoteV2) }))
    .addMethod("editor", "pin", obj({ id: str(), pinned: bool() }), nul()),
);
```

`evolve(prev, (e) => …)` appends one version to `prev`'s history: `NotesV2.version` is 2, and `NotesV2` still knows
version 1 exactly as it was declared. Every version is **materialized and fingerprinted at declaration**. That is what
makes old code safe: an old plugin bundle that contains its own copy of `Notes` version 1 computes the same
fingerprint as the history inside `NotesV2`. There is no build step, no generated file and no fingerprint copied by
hand.

The edits:

| Edit | Changes | Kind |
| --- | --- | --- |
| `e.state(variant, member, schema)` | one state member of one variant | remote |
| `e.addState(variant, member, schema)` / `e.removeState(variant, member)` | adds or removes a state member | remote |
| `e.state(member, schema)`, `e.addState(member, schema)`, `e.removeState(member)` | the same, flat | local |
| `e.args(name, schema)` / `e.result(name, schema)` | one side of a method | both |
| `e.method(name, args, result)` | both sides of a method | both |
| `e.addMethod(variant, name, args, result)` | adds a method (or an existing one to another variant, same signature) | remote |
| `e.addMethod(name, args, result)` | adds a method | local |
| `e.removeMethod(name)` | removes a method from every variant | both |

Edits chain. The `method(...)` wrapper appears only in base declarations; edits take the schemas directly, so a
method without a result is added with `nul()`. The rules of chapter III still hold across versions: a method has one
signature in every variant, and a member's kind never changes, not even after it was removed and added again.

**What `evolve` cannot do:** change the input or the set of variants. Both change what an object *is* (its identity,
who gets which members), and no adapter can turn one into the other. That needs a new history base, below.

## The provider says what it accepts

`NotesV2` says what changed. It does not say how version 1 consumers are served; the **provider** decides that, with
mappings that live in its own code, never in the contract. The worker facet declares them with `checkAccepts`:

```ts
// notes/worker.ts
import { checkAccepts } from "@earendil-works/chord/next";

const toV1 = ({ pinned, ...note }: Static<typeof NoteV2>) => note;
const toPublicV1 = ({ pinned, ...note }: Static<typeof PublicNoteV2>) => note;

const notesAccepts = checkAccepts(NotesV2, {
  1: {
    state: {
      editor: { notes: (current) => ({ items: current.items.map(toV1) }) },
      reader: { notes: (current) => ({ items: current.items.map(toPublicV1) }) },
    },
    methods: {},                                   // add and remove did not change; pin is new
  },
});
// notesAccepts.versions: [{ version: 1, fingerprint: Notes.fingerprint }]

host.serve(NotesV2, notesFactory, { accepts: notesAccepts });    // working name for the objects-layer option
```

`checkAccepts` is **pure**: it checks the mappings without calling them and returns only the version metadata of the
old versions it lists. A provider that lists nothing accepts only its current version. The objects layer later
compares a consumer's version and fingerprint against this list.

The mappings point in the direction the data flows:

| Member in the old version | Mapping | Direction |
| --- | --- | --- |
| state, changed | `(currentMember) => oldMember` | provider's current value to what the old consumer expects |
| state, removed | `(currentVariantState) => oldMember`, or `"refuse"` | receives the whole current state of that variant |
| method arguments, changed | `args: (old) => current` | old caller's arguments to current ones |
| method result, changed | `result: (current) => old` | current result back to the old shape |
| method, changed or removed | `{ call: async (oldArgs, ctx) => oldResult }`, or `"refuse"` | replaces the method for old callers |
| member added since | nothing | an old consumer never asks for it |

A changed state member cannot be refused: the old consumer still has that member and must get a value. A removed one
can be computed from what the variant has now, or refused. `e.method(name, args, result)` replaces both sides and
therefore needs both mappings, even if one side stayed the same (then an identity mapping).

**Required, at type level and again at runtime.** For every member that exists in the old version and changed or was
removed since, the mapping is required by the type of `checkAccepts`. Because plugins are bundled without type
checks, the same check runs at declaration: a missing mapping, a key for a member that needs none, an unknown version
or a wrong shape throws, naming the member's path (for example `accepts[1].state.reader.notes`). An absent `state` or
`methods` section counts as empty and may be left out only when nothing there needs a mapping.

**Conservative with no-op edits.** An edit that sets a schema to what it already was, or changes a member and then
changes it back, still requires an identity mapping. TypeScript erases constraints such as `{ max: 2000 }` from the
static type, so two schemas that look the same to the compiler may differ; Chord does not try to tell.

### Old versions map straight to the current one

Studio later replaces `remove` with `archive`, which keeps the note in a trash list:

```ts
export const NotesV3 = evolve(NotesV2, (e) =>
  e.removeMethod("remove").addMethod("editor", "archive", obj({ id: str() }), nul()),
);

const notesAccepts = checkAccepts(NotesV3, {
  1: {
    state: { editor: { notes: (c) => ({ items: c.items.map(toV1) }) }, reader: { notes: (c) => ({ items: c.items.map(toPublicV1) }) } },
    methods: { remove: { call: async ({ id }, ctx) => { await archiveNote(id, ctx); return null; } } },
  },
  2: { methods: { remove: { call: async ({ id }, ctx) => { await archiveNote(id, ctx); return null; } } } },
});
```

Each entry maps **one old version directly to the current one**, not through the versions in between. Version 1
needs the state mappings (its notes have no `pinned`) and the `remove` replacement; version 2 needs only the
`remove` replacement, and leaves `state` out because its state is unchanged. A member that an old version never had
needs nothing for that version, even if it was added, changed and removed later. Dropping support for version 1 is
deleting its entry: version 1 consumers then get `contract_mismatch`.

## Binding an old consumer

A hold carries only the consumer's contract **version and fingerprint**, never a description of the contract (R6).
The provider decides with its own schemas:

:::flow wide animate | What a provider does with a hold. The decision uses only the provider's own history; a peer's schema is never an input.
row "The hold arrives"
box hold "hold" "version 1, fingerprint F1" blue
box cur "equal to current?" "version and fingerprint"
box acc "accepted old version?" "F1 from the provider's own history"
row "Outcome" accent
box live "bind" "current members"
box adapted "bind adapted" "through the mappings" accent
box mismatch "`contract_mismatch`" "or updating, during a rollout" muted
arrow hold -> cur
arrow cur -> live "yes"
arrow cur -> acc "no"
arrow acc -> adapted "yes"
arrow acc -> mismatch "no"
note "A mismatch fails only that consumer's binding. The provider object and its other bindings are not affected."
:::

Once a version 1 tab is bound, it is served as if version 1 were current:

:::steps | A version 1 tab on a version 3 worker
+++ Bind
The tab holds `Notes { S1 }` with version 1 and fingerprint F1. The worker's history computes F1 for version 1, and
`notesAccepts` lists version 1, so the hold binds adapted. The tab gets the `editor` variant as version 1 defined it:
`notes`, `add`, `remove`. It never sees `pin` or `archive`.
+++ State through the mapping
Chord serves the adapted state like a derive of the provider's state: it applies the mapping to the current value
and keeps the result per binding. The snapshot the tab receives has no `pinned` fields.
+++ A commit
The owner pins a note from a current tab. The worker sends the current tab the draft's ops. For the version 1 tab,
Chord applies the mapping to the new value and sends the difference to its last adapted value (`diffRevisions`). The
mapping produced nothing new for a pin, so the version 1 tab receives no change at all. A large list is never resent
whole on every commit.
+++ A call
The tab calls `remove({ id })`. Its arguments are checked against the provider's own version 1 schema, then the
`call` replacement runs `archiveNote` on version 3 code. Its `null` result is what version 1 expects. Had the method
only changed, `args` would have mapped the arguments forward and `result` the result back.
+++ The worker moves on
A later revision drops the version 1 entry. When the tab re-holds (or the worker restarts and the tab binds again),
the hold gets `contract_mismatch`, and Studio's panel shows "reload to update" instead of failing silently.
:::

## A new history base

Some changes cannot be adapted. Studio decides that notes belong to a project, not a session: the input changes from
`{ session }` to `{ project }`. That is a new base, written in full, with an explicit version that continues the
published numbering:

```ts
export const NotesV4 = remote("notes", {
  version: 4,                                      // explicit: the published history used 1 to 3
  input: obj({ project: str() }),
  placement: () => Server,
  variants: {
    editor: { state: { notes: obj({ items: arr(NoteV2) }) }, methods: { add: method(…), pin: method(…), archive: method(…) } },
    reader: { state: { notes: obj({ items: arr(PublicNoteV2) }) } },
  },
});
// checkAccepts(NotesV4).versions is empty
```

A new base has no history before its version and **cannot accept older versions**, not even for an additive change.
Every consumer built against versions 1 to 3 gets `contract_mismatch` and must update. Later `evolve` calls continue
from version 4. The same applies to a change of the variant set. Do not spread an older declaration into a new one or
copy its fingerprint; the contract objects are branded and `evolve` and `checkAccepts` reject copies.

## Local contracts

`local` contracts (chapter IV) evolve the same way, with a flat members map and no variants:

```ts
export const SessionInfoV2 = evolve(SessionInfo, (e) => e.state("init", InitV2));
checkAccepts(SessionInfoV2, { 1: { state: { init: (current) => toInitV1(current) }, methods: {} } });
```

Same-host consumers of a `local` type are usually reloaded together with their provider, but not always: another
plugin on the same host may be built against an older version. The rules are identical; only the variant argument is
missing.

## Implementing a contract

`Implementation<typeof NotesV2>` is the type of everything a provider must supply for the current version: one state
getter per member and variant, and one asynchronous method per method, each receiving `(args, ctx)`:

```ts
const impl: Implementation<typeof NotesV2> = {
  state: { editor: { notes: () => list.value }, reader: { notes: () => publicList.value } },
  methods: { add: async ({ text }, ctx) => addNote(text, ctx), remove: async ({ id }) => removeNote(id), pin: async (a) => pin(a) },
};
```

Keep declaration types **inferred** (no annotation on `NotesV2`): the inferred type carries the complete history, and
`checkAccepts` needs it to know what changed.

:::review | Review: L1's implementation shape and the factory's return value
`Implementation<C>` in `src/next/contracts/types.ts` is `{ state: { variant: { member: getter } }, methods }`. The
design's factories (`design.md` §6, used throughout this guide) return `{ variant, member: value, method: fn }`.
The objects layer (L4) has to connect the two, and also define how `serve` receives the checked accepts (this guide
uses the working name `{ accepts }` as a third argument) and what `"refuse"` does at runtime. The natural reading,
used in the stepper above, is that a refused method call and a hold that needs a refused state member end with
`contract_mismatch`; no source says so.
:::

## The fingerprint

The fingerprint is a 64-bit hash (`hash64`, portable across runtimes) of a **normal form** of the contract's
schemas. The normal form decides what counts as a change:

| Ignored | Significant |
| --- | --- |
| order of object keys, `required` and `enum` (sorted) | order of union and intersection branches (`anyOf`, `oneOf`, `allOf`) and of tuples |
| annotations on schema nodes: `title`, `description`, `examples`, `$comment`, `deprecated` | defaults, formats, patterns, bounds, `$ref` names |
| placement | input, variants, member kinds and every member schema |

Union order is significant because it is meaning: TypeBox picks defaults and decodes by the first matching branch.
Annotations are dropped only on schema nodes; an object property that happens to be named `title` is data and counts.

Only data schemas are allowed. One walker copies, validates and normalizes each schema against a **whitelist of
TypeBox keywords**: primitives, arrays and tuples, objects and records, unions and intersections, `$defs` and `$ref`
(use `$ref` for recursive types), constraints and annotations. Conditional and dependent schemas, `not`,
`definitions`, `contentSchema`, `unevaluated*`, `contains`, `propertyNames`, unknown keywords, executable or custom
TypeBox features, arbitrary `Unsafe` and refinements, accessors, symbols and cyclic objects are rejected at
declaration. Bytes are the one special leaf: `bytes({ min, max })` checks a `Uint8Array` and has the data marker
`{ type: "bytes", minLength?, maxLength? }`, so it hashes like any schema; TypeBox's checking still works on it.

Schemas are deep-copied into a private, frozen history; your own schema objects are copied, not frozen.
`NORMAL_FORM_VERSION` is part of every digest, so a change of the normal form is a link protocol change.

**Not a security boundary.** A fingerprint says "we were compiled against the same contract"; it proves nothing. A
hostile client can send any fingerprint it likes. Providers therefore always validate arguments with their own
schemas (chapter IV), whatever the fingerprint says.

## Rules of thumb

- Treat a published contract like a published API: every change is `evolve`, every `evolve` needs a decision about
  old consumers.
- Keep mappings small and pure. A state mapping runs for every commit and every adapted binding; make it a map over
  the value, not a query.
- Accept the versions your users still run (one or two back during a normal rollout), and delete entries when the
  metrics show no old bindings.
- Change the input or the variants only with a new base, and only when updating every consumer is acceptable.
- Contract, document and job versions are separate and each is decided on its own. Pinned notes needed `NotesV2`
  for the wire and `NoteList` version 2 with a `migrate` that adds `pinned: false` (chapter V), but no new
  `ImportJob` version, because its outcome did not change.

:::note | Built so far
This chapter's contract layer is built: `packages/chord/src/next/contracts/` (commit `7d2bb8ea8`, about 1,300 lines
with `remote`, `local`, `method`, `evolve`, `checkAccepts`, `Implementation`, the schema helpers, `fingerprintOf`,
`schemaNormalForm` and `NORMAL_FORM_VERSION`), with nine test files covering evolution, fingerprints, the hash,
local contracts, long chains, schemas, types and review findings. It stands alone: it hosts nothing, calls no
mapping and does not import the frozen runtime. Binding by version and fingerprint, adapted state and calls belong to
the objects and protocol layers, not built yet.
:::

# On the Wire {#wire lede="What travels over a link, what a relay does with it, how big things are kept in check, what each hop costs, and how to see it in traces."}

Most plugin code never thinks about the wire: it declares state, commits transactions and calls methods, and Chord
moves the bytes. You need this chapter when something is slow, when a value is large, when a link misbehaves, or when
you want to read a trace. It also explains why the earlier chapters insisted on small operations, shared structure and
no callbacks: each of those rules removes a cost on some hop.

## What a state member sends

Every exposed document, derive or readable is a **state member**. Over a hold it produces one of these:

| Update | When |
| --- | --- |
| `snap` | on hold and on re-hold: the whole value, once |
| `ops` | per commit: the draft's recorded ops, no diff |
| `ops` from a diff | per change of a derive (and of an adapted binding, chapter XVI) |
| throttled `ops` | job progress |
| `reset` | a migration commit replaced the value (adapted for older consumers) |
| `error` | the member failed |

**Commits are atomic for consumers.** On the same host, subscribers are notified once, after every document of the
commit is adopted. Remotely, one `state` message per hold carries a batch of member updates that is applied before
listeners run, and a commit that touches several holds on one link travels as **one** `state` message on that link.
A consumer never sees half a commit.

## Messages

A message is a **header plus opaque parts** (R1). There is one part per hold the message concerns; the header says
which hold each part belongs to and how large it is.

| Direction | Kind | Parts |
| --- | --- | --- |
| consumer to provider | `hold`, `release`, `call`, `cancel` | `call` has one (the arguments) |
| provider to consumer | `bound` | one: the snapshot |
| | `state` | one per hold the commit touched on this link |
| | `result` | one |
| | `gone` | none |

There are no request ids in application code. Hold ids and call ids exist only inside the protocol, per link.

**One binary format on every link (Q4):** `u32 header length | header JSON | part bytes`, as one `Uint8Array`. A
WebSocket sends it as a binary frame, IPC passes it with `serialization: "advanced"`, a memory link delivers it
asynchronously. Encoding, framing, header checks, id resolution, flow control and size limits are one shared protocol
layer; link adapters only move bytes. Tests on memory links therefore run the production path.

A part is encoded **once, at its origin**, with that hold's own Delta encoder (paths are interned per hold, end to
end between provider and consumer). A JSON part above a threshold (about 16 KiB) is compressed once at its origin,
whatever the link; byte segments stay raw; relays forward compressed parts as they are; the header names the codec.

**The header is a TypeBox schema (R4)**, a union tagged by `kind`; the protocol types derive from it. Headers from
untrusted links (client WebSockets) are checked with the schema compiled once; trusted links (IPC between server and
workers) are not checked. **Unknown ids are ignored on both sides (Q1).** They are normal races: a `result` crossing a
`cancel`, a `call` crossing a `gone`, a state part crossing a `release`. The side that ended a hold or call settles
its own pending work: a consumer that receives `gone(h)` rejects its pending calls on `h`, and the order per
direction guarantees nothing else for `h` follows. Only a header that fails the schema is a protocol error, and it
closes that link.

The link protocol has a version. Hosts with different protocol versions refuse each other; a web page reloads to get
the server's protocol.

## Through a relay

A tab never talks to a worker directly (chapter I). The server **relays**, and a relay reads and rewrites only
headers: it maps hold and call ids between its two links, stamps the principal on `hold` and `call` (a client's
principal field is always overwritten; only a trusted parent link may carry one), and groups parts per destination
link, so each link gets only its own holds' parts. It never parses a payload.

:::sequence animate | The owner adds a note while Ann watches. The commit leaves the worker as one `state` message with two parts; the server splits it by destination without decoding either part.
actor owner "owner's tab" "hold h1" blue
actor ann "Ann's tab" "hold h2" muted
actor server "server" "relay" accent
actor worker "worker S1" "NoteStore, Notes"
owner -> server: call c7 Notes.add (1 part)
server -> server: map ids, stamp owner
server => worker: call c3 (part forwarded as is)
worker -> worker: method runs, self.tx commits
worker => server: state: parts for h1', h2'
server -> server: group parts per link
server --> owner: state (h1 part)
server --> ann: state (h2 part)
worker --> server: result c3
server --> owner: result c7
:::

The `state` message reaches the owner's tab before the `result`, so when `await notes.add(…)` resolves, the new note
is already in `notes.value`. Ann's view is a different variant (reader) and gets its own part from its own derive; the
relay neither knows nor cares.

## Flow control

Each link has **one byte window**, counted from each message's `byteLength` (parts are already encoded bytes; nothing
is measured or stringified to count it). The window covers every message, first snapshots included.

- **Snapshots are always admitted (R19)**, even when larger than the window; they use it up. Whether a hold
  **overflows** is decided on the changes queued after the snapshot.
- **Under backpressure** a commit's ops are collected per hold and encoded into one part when credits return. The
  consumer still gets the commit atomically.
- **After an overflow** the hold is dropped and established again once the previous snapshot's debt has drained
  (credits back at the full window, Q3), and not more often than a minimum interval. So there is at most one snapshot
  in flight per hold: no re-hold storm, and no stall for a snapshot larger than the window.
- **Calls** are throttled by call credits the provider grants (a generous window). Beyond them calls wait locally.
  Nothing is refused for being "too many", and holds are not limited by count; authorization and input validation
  protect them.
- **Byte-heavy traffic** such as terminals uses separate channels (chapter XIII), so a large state message never
  holds up keystrokes.

**Recovery:** after a link drops, the consumer re-holds every hold over the new link and receives snapshots; calls in
flight fail as on any disconnect, calls made meanwhile park. A relay whose window overflows releases the hold and
re-holds; the provider sends a fresh snapshot. After a routed link drops, Chord re-resolves the address (with the
per-address backoff) while holds on it exist, so a passive viewer recovers without anyone pressing anything.

## Size limits

Limits apply **per part** (R2, Q2), both to the compressed and the decoded size, and are checked from the sizes in the
header before anything is decoded; zlib's `maxOutputLength` enforces the decoded limit in the one decode function.

| Situation | What fails |
| --- | --- |
| a part over the limit | only its own hold or call, with `too_large`; the other parts of the message apply |
| a snapshot over the limit | its hold ends `failed`, with no automatic re-hold |
| a WebSocket frame over `maxPayload` (e.g. 64 MiB) | the connection closes (code 1009); this is the transport's hard cap |

Defaults for client WebSockets are 16 MiB compressed and 64 MiB decoded per part, configurable per link kind. The
decoded limit travels with relayed work: the server stamps the admitting link's limit on the header at admission
(never taken from the client), and the host that decodes enforces it. IPC therefore needs no limit of its own.

Large data is never a large state member or a large argument. Files go through chunked transfers or the HTTP
component (chapter XIII); long lists are keyed documents or bounded windows (chapter VIII).

## What each hop costs

Chord v2's goal is as little compute and memory as possible while staying correct: **O(size of the change)** per
commit and per viewer, independent of the size of the value. A 500 KB value is touched as a whole only when a new
viewer takes its first snapshot. Delta, the value library under documents, was built for this, and its own primitives
are almost free: `diffRevisions` on shared subtrees takes 0.018 ms, `applyImmutable` of a small change 0.004 ms.

| Hop | Work |
| --- | --- |
| commit | Delta's `prepare` (copies and checks only the values placed in this commit), adopt by pointer swap; storage writes the delta |
| reads in a transaction | the draft overlay, no copy; an unchanged draft writes nothing |
| subscribers on the same host | the same value and ops, by reference |
| derives | compute plus `diffRevisions`; unchanged parts stay the same objects (`mapShared`, chapter VIII) |
| send | one encoding per hold part at its origin, size taken from the encoded bytes |
| relay | header only: ids mapped, principal stamped, parts grouped; parts never parsed |
| receive | compiled header schema on untrusted links; arguments stripped and validated once at the provider (compiled schema); inputs normalized |
| apply | `applyImmutable`, structure shared |
| new hold | the value encoded once (unavoidable) |
| memory | one authoritative value per document per host; replicas and derived values share structure; one cached value per adapted binding |

These are targets. The frozen kernel measured far worse, which is why the design is so strict here:

:::stats
- 35 ms | one small change to a 500 KB value in the frozen kernel, no viewer
- +13 ms | per viewer on top (10 viewers: 130 ms)
- 17 / 33 / 101 ms | a tiny SQLite commit after 0 / 10 / 50 earlier deltas
:::

Nearly all of that came from layers around Delta: whole-value validation on every access, whole-value freezing,
JSON-ness walks on every received frame, double stringification to measure a frame, snapshots cloned per viewer, and
a SQLite storage that replayed history, and schemas rebuilt for every check (a compiled TypeBox check takes
0.012 ms, an interpreted one 5.6 ms). The redesign removes each of them (chapters V, VIII and this one); the
before/after per hop is in `apps/p2/docs/p3-reviews/v2-cost-model.md`.

:::review | Review: v2-cost-model.md is partly outdated
The measurements and the per-hop "after" targets in `apps/p2/docs/p3-reviews/v2-cost-model.md` are current. Its
closing section "Decisions this needs" is not: items 6 and 7 (validation by the caller's trust; contract descriptions
once per link and fingerprint) were replaced by R7 (validate for every caller) and R6 (no descriptions on the wire),
and §10 still describes the description fetch.
:::

### Cost guards

Chord reports **full-value walks, deep copies, encodes, schema validations and materializations** as ordinary
telemetry metrics, always on; with the NOOP adapter they cost an empty call where such work happens. Tests use the
in-memory adapter and assert them per hop. The reference case: one appended note to a 500 KB document with 10 viewers
does no walks, no copies, one encode per hold part at its origin and none at relays, and no validations. A
`vitest bench` suite measures the hops.

### Ways to make it slow anyway

| Mistake | Why it costs | Instead |
| --- | --- | --- |
| a derive that builds new objects for unchanged data | every commit diffs and sends O(value) | keep unchanged items identical: `mapShared`, `previous` (chapter VIII) |
| one long array that changes often (R24) | sharing is per path; each change copies one slot per element and visits each | keyed documents or a bounded window |
| bytes as base64 strings | inflated, parsed, compressed as text | `bytes()` leaves; chunked transfers for files |
| awaiting I/O inside `self.tx` | the object's line is blocked for every caller | do the I/O first, then a short transaction |
| storing registry entries or references in documents | stale after a reload, not data | look up the current value at use |
| opening natives at module level or in a facet | no owner: never closed, never restarted | `self.open` in an object (chapter IX) |
| callbacks as arguments | cannot cross a link, keep old code alive | registries, jobs, flows |
| one big object that everybody views | one large snapshot per viewer and per reconnect | split by viewer need; views of the same variant share one value |

## Telemetry

Chord reports traces, events and metrics through `@earendil-works/pi-telemetry`. Each host gets **one adapter**,
`createHost({ telemetry })`, NOOP by default; the adapter decides sampling, buffering, export and filtering. Only hosts
hold the adapter, to start root spans. Code sees spans:

- `ctx.telemetry` is the current span (`Ctx` extends `Context`, so it is the same field Durable and pi-ai read). Every
  span carries its adapter's metrics and propagation, so code with a `ctx` can record a metric or inject a carrier.
- `ctx.trace(name, attributes, fn)` runs `fn` in a child span with a child `ctx`.
- App values such as the principal stay out of Durable's context.

**Across links**, `call` and `hold` carry the caller's trace carrier as a bounded header field (R5: limited key count
and string lengths); the provider runs the method under it, and each relay adds a `chord.relay` span. The call from the
sequence above, as a trace:

```text
chord.call Notes.add            [owner's tab]
└─ chord.relay                  [server]
   └─ chord.method Notes.add    [session:S1] principal=owner
      · event chord.commit docs=2 ops=5
```

Adapters trust typed input: no validation of malformed values and no try/catch around recording. Only carriers from
another process are checked (keys present, strings), and a bad one falls back to a new root.

**Shared work** (one activation serving several `get`s, a worker start) is its own root span, linked to the trigger
that started it; each waiting span links to it. Routine runs, job runs, eviction, backoff retries and background
closes are root spans too, linked to their trigger where there is one.

| Tier | What |
| --- | --- |
| spans | calls, methods, relays, holds, activations, opens, closes, loads, revocations, resolves, routine runs, job runs |
| events | commits inside methods, retries, parking |
| metrics | state messages, WebSocket bytes, commit durations, in-flight calls, active holds, open links, park durations, backpressure waits, the cost guards |

Ids are attributes of spans, never of metrics. **Nothing is measured or walked for telemetry**; only sizes the code
already has are reported. Errors carry a fixed category and a message cut to 500 characters; cancelling is not an
error. Chord ships a typed telemetry schema, as pi-ai (`AI_TELEMETRY_SCHEMA`) and Durable
(`DURABLE_TELEMETRY_SCHEMA`) do.

**Storing and reading:** `@earendil-works/chord/telemetry-sqlite` over `chord/sqlite` (Node and Cloudflare) stores one
row per settled span (events and links inline) and metrics aggregated per series per 10 s, flushes in batches every
second, keeps 7 days, and drops (and counts) beyond a bounded queue. The read interface `TelemetryStore` is shared:
`findTraces` (by name, attributes, errors, time window, with limit and cursor) returns complete traces, `getTrace`
one, `findMetrics` metrics. One renderer, `pi-telemetry/render`, prints traces as above; it prints links and never
follows them. The playground's trace viewer reads the same store.

**Durable** already emits submit and phase spans, stores carriers on submissions and tasks (`TaskOptions.trace`),
and pi-ai emits `pi.ai.request` and `pi.ai.poll`. With the harness given the host's adapter (chapter XIV), an agent
tool that calls `Notes.add` through `chord(fn, context)` shows up as one tree from the model request down to the
commit.

:::note | Built so far
Nothing of the protocol is built in v2: messages, relays, flow control and limits are layers L6 and L7, telemetry in
Chord is L11. Built in pi: `pi-telemetry` (propagation, links, metrics, the store interface, the renderer),
`chord/context` with `Context.telemetry`, pi-ai and Durable telemetry, and `chord/telemetry-sqlite`. Delta is built;
`mapShared` and bytes as atomic leaves in `diffRevisions` are still to do. The frozen kernel sends descriptions on the
wire and closes a link on an unknown id; both are replaced.
:::

# Building p2: the Core {#p2-core lede="From a list of what the app must do to a set of owners: the base code every p3 plugin builds on."}

The notes plugin used every Chord concept. A real app is the same concepts many times over. This chapter and the
next two assemble **p3**, the Chord v2 version of p2, from the parts the guide introduced. p3 is built next to p2 in
`apps/p3`, fully isolated with its own data directory, and **without migrating p2's data** (no import of
`catalog.sqlite`, `shares.sqlite` or the subagents table). Its plugins are derived from what the app must do, not
ported one to one from p2's plugin layout.

:::review | Review: p3 is not designed yet
The design fixes the rules (`design.md` §25) and lists the p3 decisions still open (#17, #18, #20 to #23); the
per-domain design of p3 has not started. What these three chapters show is one construction that follows the rules,
derived from the functionality map in `apps/p2/docs/p3-functions/`. Object names are working names. Where a domain
has an open decision, the text says which.
:::

## Start from functions, not from plugins

The functionality map in `apps/p2/docs/p3-functions/` lists what p2 does, in plain words, with four facts per
function: the data and its size, how durable it is, who may see or do it, and where it must be available. It groups
the functions into 22 domains:

| # | Domain | # | Domain |
| --- | --- | --- | --- |
| 1 | sessions | 12 | access |
| 2 | session workers | 13 | models, credentials, settings |
| 3 | conversations and agent | 14 | prompt resources |
| 4 | shell commands | 15 | status and presence |
| 5 | chat mode | 16 | search |
| 6 | agents (subagents, one-shots, peer messages) | 17 | remote access and forwards |
| 7 | code mode | 18 | logs and notices |
| 8 | session files | 19 | dev and reload |
| 9 | environments and execution | 20 | web shell |
| 10 | workspace | 21 | TUI shell |
| 11 | terminals | 22 | transport |

The four facts answer the four questions every Chord object needs, in order:

:::flow wide animate | From a function in the map to code. Each fact in the map answers one question Chord needs answered.
row "The map says"
box data "data" "what, how big"
box dur "durability" "ephemeral · until restart · persisted · transcript-bound"
box who "who" "owner · guest read · guest write · worker"
box where "where" "server · worker · web · TUI · environment"
row "Chord needs" accent
box owner "the owner" "smallest object it belongs to" accent
box store "where it is kept" "Durable, persisted or in-memory document, tab"
box variant "variants" "and revocation" blue
box host "host and code" "placement; core or plugin"
arrow data -> owner
arrow dur -> store
arrow who -> variant
arrow where -> host
note "Durability decides storage: transcript-bound data is Durable's; persisted app data is a persisted document with a stable identity; until-restart data is an in-memory document or a native; tab-scoped UI state stays in the client."
:::

**One owner per thing, the smallest object it belongs to.** A guest's grant belongs to the access owner, not to the
session; a draft belongs to one (conversation, author) pair, not to the chat plugin as a whole. Ownership nests, and
rules set at creation are written in the creating commit (Durable's `createConversation({ init })`).

**Core or plugin.** Core owners are what the app always needs and everything builds on; they are always present, so
other code may depend on them directly. Plugin owners may be missing; anything that depends on an optional feature
does so through a registry it owns itself (chapter XIII). The risk to avoid is a **core god object**: each core owner
owns only what belongs to it.

## The ownership map

The result of that procedure for p3, as a starting point:

| Domain | Owner object(s) | Host | Code |
| --- | --- | --- | --- |
| access | `Access` (grants, devices, share links), `authenticate` | server | core |
| sessions | `Catalog` (session records), lifecycle jobs | server | core |
| session workers | the supervisor (`route(Session)` + idle stop) | server | core (app code) |
| session location | `SessionLocation { session }` | worker | core |
| conversations and agent | `Harness`, `ConversationStore`, `Conversation` views | worker | core |
| status and presence | `SessionStatus` (server copy), reporters on workers | both | core |
| shell commands | `ShellJob` in the chat plugin | worker | plugin |
| chat mode | chat plugin | worker | plugin |
| agents | subagents plugin (Durable child conversations) | worker | plugin |
| code mode | code mode plugin (sandbox native) | worker | plugin |
| session files | `SessionFiles { session }` (proposed, #17) | server | core or plugin, open |
| environments | envs plugin (config, SSH pools #20) | server and worker | plugin |
| workspace | workspace plugin | worker | plugin |
| terminals | terminal host process (#23), terminals plugin | separate process | plugin |
| models, credentials | models plugin, login job + flow | server | plugin |
| settings | `Settings` (single writer, #21) | server | core |
| prompt resources | prompt plugin (watchers in the session's environment) | worker | plugin |
| search | search plugin (index on the server, feed on workers) | both | plugin |
| remote access, forwards | radius plugin, ports plugin | server | plugin |
| logs and notices | `Notices` (one channel), log capture | server | core |
| dev and reload | the reload control, `reload_plugins` tool | server | plugin |
| web and TUI shells | UI facets over the objects above | clients | shells |

The rest of this chapter builds the core rows. Chapters XIX and XX build the plugins.

## The base code

```text
apps/p3/
  src/
    hosts.ts           Server, Session host kinds
    principal.ts       P, Revocation, principalKey, revokedBy, can()
    server/main.ts     createHost, load, route(Session), WebSocket and Radius entry points, supervisor
    worker/main.ts     createHost with the start data, connect to the parent
    core/              the core facets: Access, Catalog, SessionStatus, Settings, Notices (server);
                       SessionInfo, SessionLocation, Harness, ConversationStore (worker)
  plugins/             chat, subagents, codemode, envs, workspace, terminals, models, login,
                       prompt, search, ports, radius, files, dev
```

`hosts.ts`, `principal.ts`, the `SessionInfo` start data and the `Harness` object are the ones the guide already
built for Studio (chapters I, III, IX and XIV). Base code restarts the hosts when it changes; everything in
`plugins/` reloads.

## Who is calling: authentication

Chord stamps principals; the app produces them. p3's server has four ways in, each turned into a principal by
`authenticate(req)` when a WebSocket connects (chapter III):

| Way in | Principal |
| --- | --- |
| loopback without a cookie (TUI, CLI, first page load) | `{ kind: "owner", access: "local" }` |
| loopback owner browser cookie (a per-port secret file) | `{ kind: "owner", access: "local" }` |
| a device cookie (HMAC-signed, per port, 30 days), obtained with a one-time sign-in token | `{ kind: "owner", access: "device", device }` |
| a guest cookie from a share link | `{ kind: "guest", session, mode, grant, revision }` |
| the Radius relay channel | `{ kind: "owner", access: "relay" }` |

The checks that are not Chord's stay in this function: origin checks and Fetch Metadata (a browser request from
another site gets no principal, except a top-level navigation), proxy trust, the sign-in token rules (10 minutes,
single use, at most 32 outstanding, memory only), cookie expiry and revocation lists. A failed check closes the socket
before Chord sees it.

**One permission matrix.** Every function in the map names who may use it, and p2 checks those rules in several
places. p3 writes them once, in `principal.ts`, and every factory and `authorize` uses it:

```ts
// src/principal.ts
type Action = "read" | "send" | "upload" | "stop" | "workspace" | "terminal" | "manage";

export function can(p: P, action: Action, session?: string): boolean {
  if (p.kind === "owner" || p.kind === "server") return true;
  if (p.kind === "worker") return action !== "manage" && p.session === session;
  if (p.kind !== "guest" || p.session !== session) return false;
  if (action === "terminal" || action === "manage") return false;     // terminals: owner only
  if (p.mode === "read") return action === "read";                     // no workspace for guest read
  return true;                                                         // guest write: send, upload, stop, workspace
}
```

Factories pick variants from it (`can(p, "send", session) ? "writer" : "reader"`), so the matrix is visible in one
file and the members a caller lacks are simply not there.

## Access: grants, devices, share links

`Access` is the core owner of everything that lets someone in: share links per session and mode, guest records, the
device list and the signing key. It lives on the server as the chapter IV pattern: a `local` store that persists the
documents (only stable identities may), and a `remote` view for the owner's settings screen:

```ts
// src/core/access.ts (server, in the core server facet)
const Links = defineState("access.links", { schema: map(ShareLink), version: 1, persist: true,
  initial: () => ({}), checkpointWhen: (_v, _o, info) => info.deltasSinceBase > 64 });
const Guests = defineState("access.guests", { … });         // same shape: map(Guest), persisted
const Devices = defineState("access.devices", { … });       // map(Device), persisted

host.serve(AccessStore, (_input, self) => {                 // local: may persist, acts for the host
  const links = self.state(Links), guests = self.state(Guests), devices = self.state(Devices);
  return {
    links, guests, devices,
    removeGuest: async ({ grant }, ctx) => {
      await self.tx(async (tx) => { (await tx.draft(guests))[grant].blocked = true; }, ctx);
      host.revoke({ grant });                                 // live access ends now
    },
    resetLink: async ({ session, mode }, ctx) => {
      const blocked = await self.tx((tx) => rotateLink(tx, links, guests, session, mode), ctx);
      for (const grant of blocked) host.revoke({ grant });
    },
    signOut: async ({ device }, ctx) => {
      await self.tx(async (tx) => { (await tx.draft(devices))[device].revoked = true; }, ctx);
      host.revoke({ device });
    },
    …                                                         // shareLink, join, signOutAll
  };
});

host.serve(Access, (_input, principal, self) => {           // remote view: owner only
  if (!can(principal, "manage")) throw forbidden();
  const store = self.get(AccessStore, {});
  return {
    variant: "owner",
    guests: self.derive("guests", [store.guests], ([g]) => publicGuests(g)),   // names, modes; no tokens
    removeGuest: (args, ctx) => store.removeGuest(args, ctx),
    resetLink: (args, ctx) => store.resetLink(args, ctx),
    signOut: (args, ctx) => store.signOut(args, ctx),
  };
});
```

`authenticate` is base code on the same host and checks `AccessStore`'s current documents on every new connection
(it holds a reference to the store, taken with `server.root` at start). Live access and lasting denial stay separate, as chapter VII explained:

| Event | Lasting effect (data) | Live effect |
| --- | --- | --- |
| remove a guest | guest record blocked | `revoke({ grant })` |
| reset a share link | new token; its guests' grants blocked | `revoke({ grant })` for each |
| archive a session | grants of that session void while archived | `revoke({ session })` |
| restore a session | grants valid again; revision bumped | none: guests reconnect |
| sign out a device | device revoked until its expiry | `revoke({ device })` |
| sign out all devices | signing key rotated, tokens cleared | `revoke({ device })` for each |

A guest who rejoins with the same browser keeps its identity; a removed guest cannot mint a new one, because the
block is in `Guests` and `authenticate` refuses it. Names are unverified, cleaned, at most 40 characters, unique per
session ("Ann (2)").

## The catalog

`Catalog` owns the session records: id, title (and whether it was edited), location, model default, pinned,
archived, timestamps. It lives on the server, persisted, and it **never starts a worker**: listing sessions, showing
their status or their unread marks reads server-side copies only.

```ts
export const Catalog = remote("p3.catalog", {
  version: 1,
  input: obj({}),
  placement: () => Server(),
  variants: {
    owner: {
      state: { sessions: obj({ items: arr(SessionRow) }) },
      methods: {
        create: method(CreateArgs, str()), rename: method(RenameArgs), pin: method(PinArgs),
        archive: method(obj({ id: str() })), restore: method(obj({ id: str() })),
      },
    },
    guest: { state: { sessions: obj({ items: arr(SessionRow) }) } },     // only the guest's own session, if not archived
  },
});
```

Behind it sits a persisted `local` `CatalogStore`; the guest variant is a derive over it, as in chapter IV. The lifecycle operations (archive, clone, fork,
relocate, delete) are chapter XIX; here only the rule that keeps the catalog small: **the catalog does not know which
plugins exist.** Archiving a session writes `archived: true` and revokes the session; every plugin that keeps
per-session things reconciles from `catalog.sessions` with a routine (chapter X), as the notes plugin did. The ports
plugin closes forwards of archived sessions that way, also after a crash.

## On the worker: start data, location, harness

Three core objects exist on every worker from its start:

- **`SessionInfo`** (chapter IX): the start message as `constant(init)`, with the session id, data directory and the
  location the server chose at start.
- **`SessionLocation { session }`** (working name), lifetime host: the current cwd and environment, with a location
  revision. Relocation changes it while the worker runs (chapter XIX); natives that depend on the location follow it
  with a routine and a generation (chapter IX), and conversations that follow the session's cwd are listed in the core
  per-conversation policy document.
- **`Harness`** (chapter XIV): the Durable harness for the session's store, one SQLite database per session, opened
  under an exclusive lock keyed by the real data directory and session id. It refuses to start when the saved root
  model is not configured, and resumes interrupted Durable work on start.

`ConversationStore` and the `Conversation` views in front of it are chapter XIX.

## Workers: start, keep alive, stop

Starting, supervising and stopping workers is app code (chapter I); Chord only routes and counts. p3's supervisor is
`server.route(Session, { authorize, resolve })` plus a small server object that keeps per-session worker state:

:::steps | A worker's life, as the supervisor sees it
+++ Authorize, then start
A tab gets `Notes { S1 }`. `authorize` checks `can(p, "read", "S1")` and that the session exists and is not archived
(an archived session refuses, except an index rebuild that starts the worker without resuming work). `resolve` forks
`worker/main.ts` with the start data from the catalog, bounded by a 60 s readiness timeout.
+++ A start failure sticks
If the worker fails to start (an unconfigured environment, a missing model), the error is kept per session and
every `get` fails at once with it, until the owner presses Retry. That clears the error and the related notices.
Guests see that the session is unavailable, not the error text.
+++ Counting
The core facet on the worker reports `host.activity` (`{ references, calls, jobs, lingering }`) and the harness's
running Durable task count to the supervisor object, from a routine whenever either changes. The call carries
`ctx.incarnation`, so a report from an older worker incarnation is ignored (chapter X).
+++ Idle stop
When everything has been zero for five minutes (checked every second, as in p2), the supervisor stops the worker:
the worker closes its host (routines stop, natives close, storage flushes) and exits. Durable work stays persisted
and resumes on the next start. Detached work that must keep the worker alive (a shell command whose caller left) is
a job, so it counts.
+++ Crash
If the worker exits on its own, the link drops. The supervisor records the exit code and a redacted stderr tail
(at most 4,000 characters) for that incarnation and posts one notice. References that still exist make Chord call
`resolve` again with backoff; a passive viewer recovers without a click.
+++ Shutdown
On server shutdown the supervisor stops every worker, with a forced exit after three seconds. Durable work remains
persisted.
:::

## Status without a worker

The session list shows per session whether it is running, busy (which conversations), its task count, usage and cost,
and an error. None of that may start a worker. The pattern is chapter X's pub/sub: a reporter on each worker (a
routine over the harness's state) calls `SessionStatus.report(summary)` on the server; `SessionStatus` keeps the latest
value per session and ignores calls whose `ctx.incarnation` is older than the newest it has seen; clients read
`SessionStatus`, which lives on the server. Children lists, unread marks, search index rows and artifact lists use the
same pattern (chapter XIX).

## Settings and notices

**Settings** (default model and thinking, run settings, compaction, queue modes, code mode switch, owner name) have
**one writer**: a core `Settings` object on the server owns the file, validates writes and serializes them; every
other process follows its state through a reference instead of watching and rewriting the file itself. p2 watches
settings, models and auth in every process and writes them from two, which is decision #21.

**Notices** are one channel: one core `Notices` object on the server, written by everything that fails or finishes
(worker crashes, reload results, model errors, login outcomes, grants), keeping one latest notice per source, at most
50. The owner's shell reads one list; dismissing is a method. p2 has five notice channels for the same thing.

:::review | Review: settings and file formats (#21, #22)
Single writer for settings, models and auth (#21) and versioning on-disk formats such as `envs.json` like documents
(#22) are open p3 decisions in `design.md` §26. The construction above assumes "one owner on the server, others
follow its state" for #21.
:::

:::note | Built so far
Nothing of p3 exists. The functionality map is complete (`apps/p2/docs/p3-functions/`, five area files plus the
condensed `README.md`), and the design's app rules (`design.md` §25) are decided. p3 starts after the layered rebuild
and the playground's first real proof.
:::

# Sessions and Conversations {#p2-sessions lede="The session lifecycle, status without a worker, chat, shell commands, subagents and search, each mapped to an owner and the Chord parts it uses."}

This chapter builds the domains a person touches most: the session list and its operations, the conversation view
and composer, shell commands, chat mode, subagents, messages between sessions, search and unread marks. Each section
names the owner, the host, and the Chord parts it uses; code appears only where it shows something new.

## The session lifecycle

The catalog (chapter XVIII) owns the session records. Its operations, by the Chord part each needs:

| Operation | Owner and form | Notes |
| --- | --- | --- |
| create | `Catalog.create`, a method | absolute directory, `~` expanded, must be a directory; on an environment, resolved there through the envs plugin; refuses an unknown model; model and thinking default to the last used |
| rename, pin | methods on `Catalog` | title 1 to 120 characters, whitespace collapsed; an explicit title is never replaced automatically |
| automatic title | a routine on the search feed | the first user message, line breaks to spaces, 100 characters |
| agent rename | an agent tool on the worker calling `Catalog` | root conversation only |
| archive, restore | methods; revocation; reconciling routines | below |
| clone, fork, relocate | jobs on the catalog store | outlive the call, cancellable, one outcome |
| delete | a job; decision #18 | below |

### Archive and restore

Archiving must stop the worker whatever it is doing, end guest access, and close the session's port forwards, while
keeping its storage. The catalog does none of the plugin-specific parts:

:::steps | Archiving S1
+++ One write
`Catalog.archive({ id: "S1" })` sets `archived: true` in the session record, in one transaction.
+++ Revoke the session
The catalog calls `host.revoke({ session: "S1" })`. Every guest principal of S1 has `{ session: "S1" }` in its
`revokedBy`, so their objects end and their links close on the server and on the worker (chapter VII). New
connections are refused by `authenticate`, because grants of an archived session are void.
+++ Stop the worker
The supervisor reconciles from `catalog.sessions` with a routine: an archived session's worker is stopped, and
`authorize` refuses to start it again.
+++ Plugins reconcile
The ports plugin's routine on `catalog.sessions` closes forwards of archived sessions. The search plugin marks the
session's rows archived. If the server crashed between the write and these steps, the routines run again with the
current value at the next start: nothing is a notification that can be lost.
+++ Restore
`Catalog.restore` clears the flag. Grants are valid again, so guests reconnect and authenticate as before; forwards
stay closed.
:::

### Clone, fork, relocate

Each is work that outlives its call, can be cancelled and has one outcome, so each is a **job** (chapter XI) on the
catalog's local store, keyed by the owner's request id. They differ in what they pause:

- **Clone** copies the session's store, uploads, downloads and artifacts under a new id, with the source worker
  paused (refused while work runs) and title "(copy)"; directories `0700`, files `0600`, no links, no overwrite; a
  partial copy is removed on failure.
- **Fork** before a user message copies the active context as of the entry before it into a new session (title
  "(fork)"), with the message waiting in the new session's editor. It needs two workers: the source reads history,
  the new one is seeded empty. A failure archives the copy.
- **Relocate** (cwd, environment or both): refused while the session is busy (naming the running subagents) or when
  a subagent has its own cwd and the move crosses machines. The job fences the worker (new admissions wait), updates
  the record, and moves the running worker in place by updating `SessionLocation`: natives that follow the location
  switch with a generation (chapter IX), and conversations that follow the session's cwd are rewritten in one Durable
  commit before work resumes. After 60 s it restarts the worker instead; on failure it releases the fence.

:::review | Review: jobs as objects (#9)
The design defers whether a long relocation or a login is a record inside its owner (watched through `running`) or an
object of its own (`Relocation { id }`). The construction above uses records. Decide when login is ported
(`design.md` §15, §26).
:::

### Delete

p2 has no session delete. p3 needs one that removes the session everywhere: every document tagged with the session
(`store.retireByTag(SessionTag, id)`, chapter V), the worker's databases (the Durable store), the session's files, the
search rows, read marks, children copies, forwards, guest records, and finally the catalog entry. The design commits to
this outcome (`design.md` §25); how plugins take part is open.

:::review | Review: session delete (#18)
Options in `design.md` §26: per-session objects plus `SessionTag` plus one session directory (delete is retire by tag
and remove a directory, plugins need do nothing), or owner hooks contributed through a catalog registry. Also open:
whether the search index is per session (deleted with it) or global with a hook. Who holds the store for
`retireByTag` is not specified either.
:::

## Status, children, unread: reports to the server

The session list must show status, subagents and unread marks for sessions whose workers are not running, and must
not start them. All three follow chapter X's pub/sub pattern: a routine on the worker calls a server object with the
current summary, the server object keeps the latest value per session (persisted where it must survive a restart),
ignores calls from an older `ctx.incarnation`, and clients read the server object.

| Summary | Source on the worker | Kept on the server |
| --- | --- | --- |
| status: running, error, task count, busy conversations, usage and cost | the harness's task graph and usage | `SessionStatus`, in memory: a stopped worker is "not running" |
| children: name, model, thinking, tools, cwd, last entry, archived | the subagents plugin's child list | `Children`, persisted |
| latest root answer | the search feed | `Unread`: compared with the owner's read mark, persisted, shared by all owner devices |

Guests see their own session's status without the error text. The owner's read mark is written when the root
conversation is visible, and a new session starts as read.

## Conversations

The harness (chapter XIV) owns the Durable store. The UI needs, per conversation: a live window of entries, older
pages, usage numbers, the working indicator, the inbox (queued inputs), and the actions. Two core objects provide them:

- **`ConversationStore { conversation }`** (local, on the worker): opens the Durable watch as its native, reaching
  the harness through the core-private `HarnessRuntime` registry entry, and exposes a **window** as a derive: the
  newest entries (at most 100 or 512 KiB, at least 20) plus the conversation's documents. The window's start stays
  put while it is within 1.5 times the limits, so new entries arrive as small appends instead of a shifted list
  (chapter VIII's window pattern).
- **`Conversation { session, conversation }`** (remote, placement `Session`): the per-principal view. Variants by
  `can()`: `owner` (everything, including model, thinking and handoff), `writer` (guest write: send, steer, stop,
  compact, shell), `reader` (the window only).

```ts
host.serve(Conversation, ({ session, conversation }, principal, self) => {
  const store = self.get(ConversationStore, { conversation });
  const policy = self.get(ConversationPolicy, { conversation });         // core: readOnly, followsSessionCwd
  const author = authorOf(principal);                                    // structured: kind, id, display name
  if (!can(principal, "send", session)) return { variant: "reader", view: store.window, page: store.page };
  return {
    variant: can(principal, "manage") ? "owner" : "writer",
    view: store.window,
    page: store.page,                                                    // older history: returns data
    send: ({ text, attachments, mode, requestId }, ctx) => {
      if (policy.value.readOnly) throw forbidden("read-only conversation");
      return store.submit({ type: "input", content: text, attachments, author, whenBusy: mode, requestId }, ctx);
    },
    stop: (_args, ctx) => store.stop(author, ctx),                       // allowed even when read-only
    …
  };
});
```

What each function becomes:

| Function | How |
| --- | --- |
| send, retried send | Durable `submit` with the author's `requestId`: a retry with the same id is admitted once (Durable dedupes, chapter XIV) |
| steer or queue while busy | `whenBusy: "steer"` or a follow-up; the inbox is `docs["pi.inbox"]` in the window |
| attribution | the view derives the author from the principal; the entry stores it structured, the model sees a speaker block; nothing parses text |
| wait for prompt resources | the first input of a fresh worker waits until the prompt plugin's resources are loaded (a registry readable the store follows) |
| stop, dequeue | withdraw queued inputs, abort the run; the caller's texts return to its editor, other authors' to their **restored drafts** |
| restored drafts | a keyed document per (conversation, author), tagged `SessionTag`, persisted in the store; claimed once, first tab wins |
| read-only conversations | the core per-conversation policy document, written at `createConversation({ init })` by whoever creates the conversation; send, dequeue, configure, compact and shell refuse; stop is allowed |
| history pages | a method returning a page (100 entries, 1 MB, 2,000 scanned); compaction and reset markers always included |
| model and thinking | owner variant only; validated against the models plugin's catalog; the root conversation's model is also reported as the session default |
| compaction, handoff | Durable operations through the store |

**Drafts in the composer** are UI state, not Chord state: the web shell keeps one draft in `sessionStorage`, the TUI
keeps one per conversation across UI replacements, and pending sends keep their request id until acknowledged
("Sending when connected"). Only restored drafts, which the worker produces, are documents.

## Shell commands

`!cmd` runs a command in the conversation's cwd on its environment and records the result as an entry; `!!cmd` does
the same but keeps the output out of the model's context. One command at a time per conversation; the live tail is
at most 50 KB or 2,000 lines, sampled every 200 ms; the full output spills to a file; the result entry is placed at the
run's next boundary while the agent is busy and never starts a run. This is the design's job example almost as is:

```ts
const ShellJob = defineJob("chat.shell", {
  version: 1,
  args: obj({ command: str({ max: 100_000 }), include: bool(), author: Author }),
  progress: obj({ output: str() }),
  result: ShellResult,
  concurrency: 1,                                                   // one per conversation
});

const results = self.state(ShellResults);                           // keyed by run id: dedupe after completion
const shell = self.job(ShellJob, {
  run: async ({ command, include, author }, ctx) => {
    const out = new OutputBuffer({ maxBytes: 50_000, maxLines: 2000, retain: "tail" });
    const env = await environmentFor(ctx);                          // the conversation's environment, chapter XX
    const r = await env.exec(command, { cwd: env.cwd, signal: ctx.signal, spill: spillPath(ctx.jobId) },
      (chunk) => { out.push(chunk); ctx.progress({ output: out.snapshot().text }); });
    const data = { command, output: out.snapshot().text, exit: r.code, cancelled: ctx.signal.aborted };
    await conversation.submit(
      { type: "write", entry: shellEntry(data, author, include), requestId: `shell:${ctx.jobId}` }, ctx);
    return data;
  },
  finish: async (done, tx) => {
    (await tx.draft(results, done.id)).outcome = done.kind === "done" ? done.result : { error: done.error };
  },
});
```

The request id `shell:${ctx.jobId}` makes the entry idempotent: an attempt interrupted after the write cannot write
it twice. Cancel is `shell.abort(id)`, allowed for the command's author and the owner. A retried `runShell` with the
same request id returns the running job (dedupe of unsettled runs), or the stored result (the owner's own dedupe after
completion, chapter XI). p2's "cancel when nobody watched for 30 s" is dropped: a job keeps its owner alive and does
not depend on viewers.

## Chat mode

Chat mode is a per-conversation switch that everyone in the session sees and only the owner changes; forks and new
subagents start with it off. Because it must fork and rewind with the conversation, it is **transcript-bound**: a
Durable conversation document, not a Chord document. Messages without `@pi` become display-only Durable `write`
entries (author, text, attachments, reply quote); a message with `@pi` becomes an input with a digest of the chat
since the last mention (at most 100 messages, 20 files, 4 images), recording which entries it passed on. The reply
quote is derived on the worker from the entry id the client names: the client never supplies author or quote text.

## Subagents and one-shot agents

Subagents are Durable child conversations owned by tasks, as in Durable's own background-subagent example: one
`subagent` tool spawns, steers, waits for, stops and lists them; each child is owned by a background anchor task, and
each message is delivered by a reporter task that posts the answer back to the parent once, with request ids so a
restart sends nothing twice. Chord adds only three things:

- the **child list** for the sidebar is reported to the server (`Children`, above), so it shows without a worker;
- a child that follows the session's cwd, or a read-only one-shot agent created by a code-mode script, is marked in
  the core **per-conversation policy document** when it is created, so chat and relocation enforce it without knowing
  the subagents plugin (`design.md` §25 porting guideline);
- archive and restore of a child from the UI are methods on the subagents plugin's view, refused for one-shots.

Subagents cannot spawn subagents; thinking levels are clamped to what the model supports, in one helper shared with
the session's model choice.

## Messages between sessions

The root agent can list other sessions and send one an attributed message. The tool runs on the sender's worker and
calls a server object through `chord(fn, context)` (chapter XIV):

```ts
const peerSend = defineTool({
  name: "session_send",
  execute: (args, api, context) => chord(async (ctx) => {
    const peers = await ctx.get(Peers, {});                       // server, worker variant
    await peers.send({ to: args.session, text: args.text, mode: args.mode, requestId: `peer:${api.taskId}` }, ctx);
    return { output: [{ type: "text", text: "sent" }] };
  }, context),
});
```

`Peers` checks that the sender is a root conversation of a non-archived session, refuses sending to itself and
archived recipients, then gets the recipient's `Conversation` (which starts its worker) and submits with the
sender as a structured author and the same request id (the tool task's id, stable across restarts), so a retried
tool call delivers once. The sender's
incarnation is `ctx.incarnation`; a call from a replaced worker is refused. Only owner-initiated turns may use the
tool; guests never.

## Search

The search plugin indexes user and assistant messages of root and subagent conversations (no shell output, no
Durable internal inputs) for title, cwd and message search across sessions, active or archived.

:::flow wide animate | The search feed. The worker pushes pages from a cursor; the server owns the index and never starts a worker to answer a query.
row "Worker S1" blue
box commit "Durable commit" "in any conversation"
box wake "wake" "a routine on the harness's commit signal"
box page "read from cursor" "200 entries per page"
row "Server" accent
box index "SearchIndex" "native: SQLite FTS" accent
box cursor "cursor per conversation" "moves after the whole range"
box query "query" "terms, scope, at most 41 hits"
arrow commit -> wake
arrow wake -> page
arrow page -> index "report(page)"
arrow index -> cursor
note "Reports carry ctx.incarnation. Indexing is idempotent: a page sent twice changes nothing."
:::

The index is a native owned by a host-lifetime object on the server; cursors live with the index, so after a crash
the worker asks for the cursor and continues. Rebuilding one session's index drops its rows and rescans, starting
an archived session's worker without resuming its work. Queries are methods returning data: at most 41 hits,
snippets of 300 characters, queries up to 500 characters. The same feed sets automatic titles, moves "updated at"
forward and supplies the latest root answer for unread marks.

## Presence

Viewers per session are `host.references(Conversation)` on the worker, counted per client (chapter VIII), and
reported with the status. Connected guests (name and mode) are the references whose principal is a guest. Presence
is not keep-alive: the supervisor uses `host.activity`, which also counts calls and jobs.

:::note | Built so far
None of this exists in p3. The parts it relies on are Durable (built: submit with request ids, steer and queue,
child conversations, background tasks) and the Chord layers L3 to L9 (not built).
:::

# Machines, Files, Models {#p2-machines lede="Environments, workspace, terminals, session files, ports and Radius, models and logins, prompt resources, logs, reload and the shells: the rest of p3."}

The last domains are the ones that touch the outside world: other machines over SSH, the file system and git,
terminals, the relay, model providers and their credentials. Most of them are native objects, and most of them are
places where p2 has the same thing several times (four SSH connections to one environment, five notice channels,
three copies of the environment config parser). The rule that fixes that is the one from chapter XVIII: one owner per
thing.

## Environments

The **envs plugin** owns the environment configuration: name, host, user, port, identity file, shell and its
variables, plus a managed ed25519 key per environment and its own `known_hosts` (kept apart from the user's, aliased
per environment name).

| Function | Owner and form |
| --- | --- |
| list, add, edit, delete (refused while a session, archived too, uses it) | `Envs` on the server: a persisted document behind an owner-only view |
| validation (no leading `-`, no whitespace or control characters in host and user) | the view's methods, before the write |
| a hand-edited `envs.json` is picked up; an invalid file keeps the last valid set and shows an error | a native file watcher (poll fallback) in the envs store; one writer (#21) |
| environment revision: a hash of the config, part of its identity | a derive |
| connection test (connect, deploy the daemon, platform, latency, warnings) | a job; the result per revision in a document |
| unknown or changed host key: fingerprints, trust after confirmation, forget | a flow (chapter XII) on the server |
| browse directories (`~`, relative paths, at most 10k scanned, 1,000 shown) | a method with a **call-scoped** SSH session (chapter IX) or the pooled connection |
| a changed environment restarts its sessions' workers once idle | a routine on the envs store and the status reports |

**Execution in the agent.** The worker's harness asks `HarnessEnvironments` for an environment per target (chapter
XIV). The envs plugin contributes it from its worker facet: local execution at the session's cwd, or a remote one over
SSH through the `pi-env` daemon, deployed per platform and connecting at the first operation. A remote session never
falls back to local tools. The environment follows `SessionLocation`: after a move, the old connection closes once
the move has committed and watchers reopen at the new location.

```ts
// envs/worker.ts
export default defineFacet((host, self) => {
  const location = self.get(SessionLocation, { session });
  const pool = self.get(EnvPool, {});                              // one owner of SSH connections (#20)
  self.contribute(HarnessEnvironments, (target) =>
    target.env === "local" ? localEnv(target.cwd) : pool.environment(target.env, target.cwd));
});
```

:::review | Review: connection pools (#20)
SSH connections to one environment exist four times in p2 (worker environment, browse connection, test connection,
terminal host). `design.md` §26 asks for one owner with a pool or deliberate per-use connections. `EnvPool` above is
the first option: a native object that closes idle connections after 10 minutes and invalidates them on a config or
key change. Reloading the plugin that owns the pool kills running remote commands (chapter XV), so it should change
rarely.
:::

## Workspace and file index

The **workspace plugin** serves the viewed conversation's working tree (a subagent's own cwd included) on the worker:
list a folder (at most 2,000 entries, `.git` hidden), read a file (1 MiB, binary detected), git status, diff, log and
single commits, literal text search, and all paths for name filtering. Every query is a **method returning data**, not
state: results are bounded and requested by the UI. Only change notifications are state: a counter in a document,
bumped by a native watcher of the tree, `HEAD`, the index and config (debounced 100 ms); viewers reload what they show
when it changes.

Two rules live in one place each instead of three:

- **Confinement:** path rules, a canonical root, no `.git`, the app's private data directory denied (also excluded
  from search). One helper used by listing, reading, uploads and the file index.
- **Git hardening:** no optional locks, no fsmonitor, filters disabled, no prompts or pager, no system config, 10 s
  timeout, output caps.

Downloads (25 MiB, byte ranges for media) go through the HTTP component (chapter XIII) with a route on the server that
reads chunks from the worker; uploads into the project use the chunked protocol of chapter XIII (1 MiB chunks, temp
file then rename, never overwrite, writes serialized). Guest read gets no workspace: the view has no variant for it.

The **file index** for `@` completion belongs to the same owner, so completion consumes the index instead of scanning
on its own: built from the environment's listing (else git or a walk, at most 50k paths), rebuilt at most once per
second while files change, discarded after a move. Review comments drafted on files and diffs are browser state until
sent; sending them is an ordinary `Conversation.send`.

## Terminals

Terminals must survive server and worker restarts, so their PTYs live in a **detached terminal host process**, one per
data directory, with its own process lock; it exits after 10 minutes with no terminals and no clients. The terminals
plugin on the server is the owner the UI talks to: list (title, cwd, environment, size, exit status), open at the
session's cwd and environment (refused for archived sessions), attach, close (asking first if a foreground job runs).
Terminals are **owner only**.

Bytes do not go over object links. Attaching opens a **channel** (chapter XIII) with a single-use token (30 s): JSON
control on the object, bytes on the channel, with its own acknowledged window (256 KiB, acknowledgements per 64 KiB; a
viewer that falls behind gets a fresh screen snapshot; an 8 MiB backlog disconnects). Attaching gets the current
screen from a headless emulator with 10k lines of scrollback.

:::review | Review: the terminal host process (#23)
The terminal host runs its own code. Is it part of the revision, reloaded or restarted with it (and running terminals
end), or deliberately outside it with a "host runs older code" notice as in p2? Open in `design.md` §26.
:::

## Session files

Attachments (25 MiB, at most 20 per message), sent-file snapshots made by the agent's `send_file` tool, versioned
artifacts (HTML, SVG, Markdown, text; 2 MiB; each update a new immutable version) and shell spill files are all
per-session bytes with caps, immutable ids and range reads; p2 has two upload routes, two caps and two directory
layouts for them. The proposal is one owner:

```ts
export const SessionFiles = remote("p3.session-files", {
  version: 1,
  input: obj({ session: str() }),
  placement: () => Server(),                                  // readable without a worker
  variants: { writer: { … }, reader: { … }, worker: { … } },
});
```

`SessionFiles { session }` on the server holds the index (per kind, readable without a worker), the chunked upload
and read protocol, the caps per kind, copying on clone and fork, and deletion with the session. Attachments are copied
into a remote environment before an input is admitted, with no fallback on failure. Artifact previews run in a
sandboxed frame with its own CSP and no app identity; ordinary file previews allow only safe types.

:::review | Review: session files (#17)
Proposed in `design.md` §26, not decided. Open sub-points: one preview limit (p2 has 256 KiB for sent files and
512 KiB for artifacts), what a fork copies of the artifact list, and how attachments are copied into remote
environments. Related: #22, whether on-disk layouts such as downloads and uploads get versions like documents.
:::

## Ports and Radius

The **radius plugin** keeps the outbound relay connection, a native in a host-lifetime object on the server: sign-in
by device code from the CLI (credential in a private file), token refresh, a heartbeat in the link adapter (20 s ping,
60 s timeout; TCP does not notice a sleeping laptop), backoff from 1 to 30 s, a disable switch. The relay delivers two
kinds of channels:

```ts
// radius/server.ts (the entry point: one line, as in chapter I)
radius.onChannel((ws) => host.accept(webSocketLink(ws), { principal: { kind: "owner", access: "relay" } }));
radius.onForward((channel) => proxyToForward(channel, host.registry(RadiusForwards).value));
```

Object links become owner principals with `access: "relay"`: owner, but treated as remote (no localhost-only
powers). p2 had to fake a loopback request with a secret header for this; with `accept` that is gone.

Forward channels go to `localhost:<port>` (Host, Origin and Location rewritten; 502 when nothing listens; anonymous
visitors only to public forwards). Which forwards exist is not radius's business: it owns a registry,
`radius.forwards`, and the **ports plugin** contributes its forwards (at most 50, random ids, a public toggle that
needs confirmation, an agent tool `ports` for top-level owner-initiated conversations). Without the ports plugin the
table is empty and radius still works: an optional dependency is a registry owned by the dependent (chapter XIII). The
ports plugin closes forwards of archived sessions with a routine on `catalog.sessions` (chapter XIX).

:::review | Review: may a plugin call `accept`?
`design.md` §3 shows the Radius line in the server's start code and calls entry points "app or adapter code". If
radius is a plugin, its facet needs the host's `accept`, which no other part of this guide gives a plugin. The
alternative is that the start code keeps the entry point and gets channels from the radius object. Not specified.
:::

## Models and credentials

The **models plugin** owns the model runtime (pi-ai's models with custom providers and the model cache) in a
host-lifetime object, and the credentials. It contributes the runtime to `HarnessModels` (chapter XIV), so after a
models reload the next request uses the new runtime while a running stream finishes on the old one. **Credentials
never go to clients**: the views expose providers, login methods and which type is signed in, never tokens. Every
secret is registered for redaction in one place, the log capture.

Views: a model catalog for pickers (names, ids, context windows, thinking levels; at most 300 matches in the web),
logout (refused during a login), refresh a provider's model list. The default model and the cycling scope are
settings (chapter XVIII).

### Login

A login is the guide's flow example (chapter XII): a **job** on the server that runs pi-ai's login, and a flow that
shows its steps to the starting owner.

```ts
const LoginJob = defineJob("models.login", {
  version: 1, args: obj({ provider: str(), type: AuthType }), progress: LoginState, result: obj({ ok: bool() }),
  concurrency: 1,                                                    // one login at a time on the server
});

const login = self.job(LoginJob, {
  run: async ({ provider, type }, ctx) => {
    await runtime.value.login(provider, type, {
      signal: ctx.signal,                                            // 10 minute deadline, cancel, leaving
      prompt: (prompt) => steps.ask(prompt, ctx),                    // text, secret, select, manual_code
      notify: (event) => steps.notice(event, ctx),                   // info, auth_url, device_code, progress
    });
    return { ok: true };
  },
  finish: async (done, tx) => { /* record the outcome; refresh the model list */ },
});
```

`prompt` is a promise-based callback inside the work; the resolver stays in the job (`steps.ask` records the step in
the flow state and waits for `answer`), and nothing crosses an object boundary. On a relayed connection the device
code method is selected automatically. The flow is visible only to the owner principal that started it; others are
refused. Leaving ends it: when the starting owner's references are all gone (presence, not an unmount), a routine
aborts the job. Codes, URLs and typed secrets are redacted from logs.

## Prompt resources

`AGENTS.md`, skills and templates are read in the session's environment, watched (poll fallback, last valid state),
and expanded on the worker before sending. The **prompt plugin** owns them per session on the worker, contributes the
system prompt section and skills to `HarnessExtensions` as readable contributions (a change recomposes), and exposes a
readiness readable: the first input of a fresh worker waits until it is ready (chapter XIX). After a move the watchers
reopen at the new location.

## Code mode

Code mode is a plugin (chapter XIV): its `pi-codemode` sandbox is a native; scripts call tools as nested Durable calls
and replay after a restart; the tool entry looks up the current sandbox when it starts. A reload seals and drains the
old sandbox for at most 30 s. The on/off switch is a setting.

## Logs and notices

**Log capture** tees stdout and stderr of the server, workers and detached hosts without changing their behaviour,
redacts known secrets and credential patterns, and keeps bounded rings (at most 128 sources, 1,000 lines or 256 KiB
each). Detached hosts publish redacted snapshots to a private file. Logs are read without waking a stopped worker.
**Notices** are the one channel from chapter XVIII; dismissal stores only notice ids.

## Dev and reload

The dev plugin is chapter XV's reload control for p3: a source watcher marks plugins dirty and never applies anything;
the `reload_plugins` agent tool and a control in the owner's shell reload the changed plugins, or restart all hosts for
base code (through the supervisor, reopening the sessions that were running). UI bundles are published only after a
successful backend change; a web page detects a new manifest and reloads with its drafts and navigation state saved;
the TUI swaps its sandboxed UI code with a snapshot of its state. A local Unix socket (`0700`) accepts development
commands without a network admin port.

## The shells

The web and TUI shells are UI facets over the objects above. Two rules matter for Chord:

- **UI state survives navigation, reload and reconnect on purpose.** Composer drafts, pending sends with their request
  ids, reading positions and review drafts are kept in tab storage or the TUI's replacement snapshot. A reconnect
  re-holds and gets snapshots; nothing is lost that was not in flight.
- **Leaving is never derived from an unmount.** A plugin reload remounts components (chapter XV). Cancelling a login,
  closing an overlay or giving up a lease is an explicit action or a dropped reference.

The TUI launcher keeps downloaded UI code in a permission-dropped worker with no access to files, network or
credentials; local side effects (copy, upload, download, open a URL, an external editor) need a real user gesture or a
confirmation. That is app code around Chord, not part of it.

## Transport

The last domain, transport, is chapter XVII: one message format, per-part limits (16 MiB compressed and 64 MiB decoded
on client WebSockets, instead of p2's 1 MiB input cap and 32 pending calls), one byte window per link, re-holds with
snapshots after a reconnect, and a protocol version that makes an outdated web page reload.

:::note | Built so far
None of p3 exists. pi-ai's login API, pi-codemode and the `pi-env` daemon exist and are used by p2 today; the HTTP
component and channels are deferred until after the kernel's first real proof (chapter XIII).
:::

# Other Ways to Do It {#compared lede="Cordis and DeepSeek Harness attack the same problem, plugins that come and go while an agent runs, inside one process. What that buys, and what it costs."}

Chord v2 is not the only answer to "replace plugin code while the app keeps running". The closest relative is
**Cordis**, a TypeScript plugin framework by Shigma that has been the plugin kernel of the Koishi chatbot framework
since 2019, and its most visible user, **DeepSeek Harness** (`dsh`), DeepSeek's open-source agent harness, whose
motto is "everything is a plugin". This chapter compares them with Chord v2 on the questions the guide cared about:
who owns side effects, how plugins depend on each other, what a reload keeps, what a crash keeps, and how far the model
reaches beyond one process.

:::note | Sources and status
DeepSeek Harness at commit `687f282` (release 0.2.1-rc.2), which vendors Cordis as `@deepseek-ai/cordis` 4.0.5 (Cordis
RC7 with local changes, `vendor/README.md`): its Cordis tutorial (`docs/cordis-tutorial/`), `docs/architecture.md`,
`docs/subsystems/persistence.md`, `docs/subsystems/core.md` and `packages/boot/hmr/README.md`; the Cordis paper "A
Programming Paradigm for Spatiotemporal Composability" (arXiv 2608.25512). Cordis and dsh are built and in use; Chord v2
is the design this guide describes. The comparison is between a working system and a design.
:::

## Cordis in one example

A Cordis plugin is a function (or an object with `apply`, or a `Service` subclass) that receives a **context**. It may
declare the services it needs with `inject`, and everything it does to the world goes through the context:

```ts
export const name = "greeter";
export const inject = ["tools"];                       // activate only while a `tools` service exists

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({ name: "greet", /* … */ }));   // a registration is an effect: undone on unload
  ctx.on("session/start", (s) => log(s.id));                     // an effect-bound listener
  ctx.effect(() => {                                              // any other side effect, with its disposer
    const timer = setInterval(work, 200);
    return () => clearInterval(timer);
  });
}
```

Each plugin instance is a **fiber** with states `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED` (or `FAILED`).
Every effect, registration, listener, child plugin and provided service is recorded on the fiber, and unloading runs
the disposers. The paper calls this **temporal composability**: a component can be removed at any time and reverses its
own effects. Its counterpart, **spatial composability**, is the dependency side: `inject` is live, so a plugin starts
when its services appear, and unloads (and later reloads) when a service it depends on goes away or is replaced. The
paper's claim is that independently written components can therefore be combined and replaced without disturbing each
other. The next sections check how far that holds.

**Services** are named capabilities on the context (`ctx.provide("x", value)` or `class X extends Service`). Names are
runtime strings in one flat namespace per application; TypeScript declaration merging makes `ctx.x` typecheck, but
nothing checks the service's shape at runtime, and optional dependencies are probed with `ctx.get("x")`. Scopes come
from the context tree: `ctx.extend()` derives a child context, `ctx.isolate(name)` gives one subtree its own binding of
a service, so two parts of an app can use two different `shell` providers.

**Hot reload** follows from the two halves: the reload plugin unloads the old fiber (unwinding all its effects) and
loads the new module with the same config. Nothing held in the old instance's closures or fields survives; a plugin
that needs state across reloads must keep it in a service or on disk. Config edits are diffed by entry id and
mount, unmount or reconfigure only what changed; config fields declared volatile update in place without a remount.

## DeepSeek Harness on Cordis

dsh applies "everything is a plugin" to an agent: the model adapters (`ctx.llm`), the tool registry (`ctx.tools`), the
session log (`ctx.sessions`), the agents (`ctx.agents`) and the agent loop itself (`ctx.agentLoop`) are plugins and
services. A running dsh is a plugin tree composed at boot from a **profile** (`web`, `headless`, `sdk`, `acp`) that
stacks **bundles** of Cordis config rows, with user patches on top. There is no privileged core: replacing the agent
loop is a config patch.

| Concern | How dsh does it |
| --- | --- |
| sessions | a durable, append-only event log per session (JSONL backend, single writer, `flush` as the durability barrier); model history is derived from the events |
| crash mid-turn | the log keeps everything appended; on resume the agent loop closes the open turn by appending missing tool errors and a synthetic `turn/end { reason: "interrupted" }` |
| tools | `ctx.tools.register(defineTool(…))`, an effect of the registering plugin; calls go through pre/execute/post policy waterfalls |
| approval | closed by default; `allowed-once` is the only grant; plugin installation needs full access or per-call approval |
| reload | a source watcher evicts changed modules; Loader entries running affected plugins stop and start again with the new code; a failed replacement is an activation failure, its previous code no longer runs |
| processes | one plugin tree in the Host process; the browser client and Electron's renderer talk to it over RPC streams |
| distribution | a Plugin Manager installs and enables bundles per profile; plugin markets are optional indexes |
| subagents | local subagents with their own durable sessions, and external ones |

## What the guarantees are in practice

Reading the Cordis source vendored in dsh and dsh's own documentation, the guarantees are narrower than the paper's
framing. An earlier review for p2 came to the same result (`apps/p2/docs/p3-reviews/dsh-compare.md`).

- **Reversal is cooperative and unordered.** `_unload` runs all of a fiber's top-level disposers concurrently
  (`Promise.all` in `vendor/cordis/src/fiber.ts`); order holds only inside one effect, and the primer tells authors to
  "keep the related work in one effect" when teardown order matters. A disposer that throws is logged and skipped. A
  disposer that never settles stalls the teardown; dsh's jobs service works around this by force-failing a job whose
  cancel throws and warning that "the work may be orphaned" (`packages/jobs/jobs-local/README.md`). Reversal is as
  good as every disposer, and nothing checks that a plugin registered all its effects.
- **Behaviour depends on registration order, and a reload changes it.** `emit`, `waterfall`, `serial` and `bail`
  listeners run in registration order (`docs/cordis-primer.md`). Registering appends the listener (`push` in
  `vendor/cordis/src/events.ts`, unless `prepend`), so when a plugin reloads, its listeners move to the end of the
  list. A tool-policy listener that ran first runs last after its own plugin reloads; a waterfall that short-circuits
  now sees a different decision first.
- **Dependencies are strings, and every provider reload restarts its dependents.** A fiber's activation key is the
  concatenation of its injected providers' fiber ids (`_refresh` in `fiber.ts`), so replacing a provider unloads and
  reloads every plugin that injects it, with their in-memory state. Service APIs are "pre-stable; update every
  consumer" (`AGENTS.md`): there is no versioned contract between a provider and its consumers.
- **Reloading a core service ends live work.** Unloading the agent provider "stops and drains every live handle it
  made" (`packages/core/agent/README.md`), so running agents stop; reloading the session persistence backend under
  live sessions invalidates their write handles, and "writes fail loudly until the sessions restart"
  (`.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md`).
- **Registrations leave a gap.** A reloading plugin's tools and other registry entries are removed with its old fiber
  and added again by the new one; anything that looks them up in between does not find them.

None of this is a bug in the narrow sense: each point is documented, and dsh is built around it. But "components
interleave without disturbing each other" holds only for plugins that own nothing other plugins depend on, register
every effect, order nothing by registration, and hold no state that must outlive a reload.

## Side by side

| | Cordis and dsh | Chord v2 |
| --- | --- | --- |
| unit | a plugin instance (fiber) in one context tree | an object per (type, input, principal), placed on a host (chapters II, III) |
| side effects | recorded on the fiber with `ctx.effect` and friends; on unload the disposers run concurrently, each as good as its author made it | declared through `self` (documents, natives, routines, jobs, contributions); Chord activates and undoes them (chapters V, IX to XI) |
| dependencies | service names as strings in one flat namespace, via `inject`; a provider reload restarts every dependent | typed contracts via `get(Type, input)`; a reference parks and recovers through restarts (chapter VI); optional dependencies are registries (chapter XIII) |
| ordering | listeners run in registration order, which changes when a plugin reloads | registries compose with a declared `compose` function; nothing depends on load order (chapter XIII) |
| where code runs | one process; remote UIs over RPC to the Host | a tree of hosts (server, workers, tabs); objects reachable across links, relayed by the server (chapters I, XVII) |
| who is calling | not a framework concept | principals stamped by links, variants per caller, revocation (chapters III, VII) |
| state | the plugin's own business; dsh's session log is a service | documents written in transactions, persisted, versioned and migrated (chapter V) |
| reload | unload the old instance, load the new one: in-memory state and running work of that plugin end | pure objects swap their code in place with their documents and running work kept; only objects with natives restart (chapter XV) |
| a running agent turn during reload | entries of changed plugins stop; unloading the agent provider stops its live agents | the harness is base code; Durable pins tools per task phase, so a running call finishes on old code and the next phase uses the new (chapter XIV) |
| crash recovery of a turn | the turn is closed as `interrupted` | pi-durable continues the turn's tasks from their checkpoints; replay-safe tools rerun (chapter XIV) |
| contracts and versions | TypeScript types only, pre-stable APIs, every consumer updated together; config validated with a schema | contract versions with fingerprints and provider-side mappings for old consumers (chapter XVI) |
| status | in production in Koishi since 2019; dsh released | a design with the contract layer built |

## What the comparison says

**The core idea is the same.** "Factories declare, Chord activates" (chapter II) and Cordis' reversible effects are
two forms of one rule: a plugin may only change the world through its runtime, so the runtime knows what to undo.
Both reject the module-level timer and the stored callback for the same reason.

**The difference is what survives a reload.** Cordis reloads at plugin granularity: the old instance unwinds and the
new one starts from nothing, together with every plugin that depends on it. That is simple, but a plugin's in-memory
state and its dependents' state and work in flight end with it, and correctness rests on every disposer and on
registration order. Chord v2 keeps state out of closures on purpose (documents, references, jobs as
records) so that it can swap the code of a pure object while its data and running work stay, and restarts only what
holds OS handles. That is more machinery: transactions, a store, versions on every document and contract.

**The other difference is reach.** Cordis composes plugins inside one process, and dsh adds RPC to its own clients.
Chord v2 makes the process boundary part of the model: objects live on the host their placement names, callers are
principals, and a reload rolls out across the server, the workers and every tab. An app like p2, with a process per
session and guests in other browsers, needs that; a single-process agent does not.

:::review | Review: what a reload does to a running tool call in dsh
The sources say that Loader entries running affected plugins stop and that unloading the agent provider stops its live
agents (`packages/boot/hmr/README.md`, `docs/subsystems/core.md`). They do not say what happens to a tool call in
flight when only the tool's plugin reloads; the comparison above does not claim either way.
:::

# What's Next {.epilogue lede="Where Chord v2 stands, what is still undecided, and where the written sources disagree with each other."}

The guide built Studio from one object to a p2-sized app. Every piece used the same few rules: one owner per thing,
factories that only declare, state that changes only in transactions, long-lived behaviour in declared forms, and
mappings and migrations owned by the provider. Those rules are what let Mario press Reload on his phone in the
preface while the agent keeps running. This last chapter says how much of that exists and what is still open.

## Status

:::stats
- ~10k | lines in the frozen first kernel (steps 1 to 6, 443 tests), kept as a reference only
- 1 of 11 | layers of the rebuild started: L1 contracts, built and reviewed
- 6–7k | target size of Chord v2 without tests
:::

- **The design is decided** except the points marked below. `packages/chord/docs/next/design.md` is the target;
  `packages/chord/docs/next/decisions.md` is the log and wins where they differ.
- **The rebuild** goes layer by layer, each with a one-page spec the owner approves, a minimal build with counting and
  garbage-collection tests, the cost-guard metrics, and a cleanup loop: L1 data and contracts; L2 readable and
  derive; L3 documents and store; L4 objects; L5 references and `ctx`; L6 protocol and links; L7 relay, routes,
  revocation; L8 routines and jobs; L9 registries; L10 reload and rollout; L11 telemetry in Chord.
- **Built:** the contract layer (`src/next/contracts/`, commit `7d2bb8ea8`, chapter XVI). In pi: Delta,
  `pi-telemetry`, `chord/context`, `chord/telemetry-sqlite`, pi-ai and Durable telemetry, Durable's required
  `checkpointWhen`.
- **Next, in order** (`apps/p2/docs/p3-handoff.md`): decide Q12 and Q15, which the L1 spec needs; write the spec for
  the rest of L1 (values, inputs and identity, argument checks, principals, errors; draft in
  `packages/chord/docs/next/layer-1.md`); then Q11, Q13, Q14 and the cuts C3 to C17 before the layers they affect.
- **In pi:** `mapShared` and bytes as atomic leaves in Delta's `diffRevisions`.
- **Then** the playground web shell (React, esbuild) with the reload control and a preview at `p3.mariozechner.at`,
  and the first real proof: the harness, one tool with an approval pause, a code mode reload. Then the HTTP and
  channel components, then p3, domain by domain.

## Deferred decisions

Kept with stable numbers in `design.md` §26, each waiting for a concrete case:

| # | Topic | When | Chapter |
| --- | --- | --- | --- |
| 9 | jobs as objects: a record inside the owner, or an object addressed by its id | when login is ported | XI, XIX |
| 11 | where a flow lives: a keyed document of its owner, or an object `LoginFlow { id }` | when login is ported | XII |
| 14 | project plugins: per-directory plugins with trust prompts and snapshots | own pass over `plugin-loading.md` | XV |
| 16 | a Durable Object profile | when a DO target becomes concrete | |
| 17 | session files: one `SessionFiles { session }` owner on the server (proposed) | p3 design | XX |
| 18 | session delete: retire by tag plus a session directory, or owner hooks | p3 design | XIX |
| 20 | connection pools: one owner of SSH connections per environment, or per-use connections | p3 design | XX |
| 21 | config files with a single writer: one owner on the server, others follow | p3 design | XVIII |
| 22 | file formats (`envs.json`, downloads, uploads) as versioned interfaces | p3 design | XX |
| 23 | the terminal host process: inside the revision or deliberately outside | p3 design | XX |

## Open from review round 3

Decisions (`apps/p2/docs/p3-reviews/v2-review3-summary.md`; Q1 to Q10 are decided):

| # | Problem | Proposal |
| --- | --- | --- |
| Q11 | a singleton that does not exist yet: `undefined` or `initial()`? | singletons read `initial()`; `undefined` only for absent keyed documents |
| Q12 | stripping arguments (R7) against "nothing is copied" | copy on change: a new object only when the argument had extra fields; never mutate the caller's value (proposed in the L1 draft) |
| Q13 | `ctx.incarnation` on relayed calls | relays stamp the origin host's incarnation, as they stamp the principal |
| Q14 | a writable holding functions exposed as a state member | only members with a JSON schema in the contract are exposable, checked at serve |
| Q15 | arguments of `local` methods: validated or not | apply R7 to `local` too, or keep `local` as the one exception |

Cuts the owner may choose (each removes a primitive this guide teaches):

| # | Cut | What it costs |
| --- | --- | --- |
| C3 | shrink jobs to a runner over documents (no versions, `accepts`, `blocked`, `persist`), or move jobs out of the kernel | job versioning, or `self.job` for core-only users |
| C4 | routines: `on` and `loop` only | `every`'s due time across reloads |
| C5 | merge `lifetime: "host"` objects into the facet | a plugin's always-on natives share one failure domain |
| C6 | remove `broken()` for opens and `retryOn` | nothing; reload and Retry still work |
| C7 | remove provider-side `linger` | ten lines of app code |
| C8 | remove `state: false` (method-only references) | a method-only consumer pays one snapshot |
| C9 | remove `previous` from derives | derives that used it move to `mapShared` |
| C10 | one `cell(initial)` for `constant` and `writable` | nothing |
| C11 | remove `ctx.trace` (use `traceIn(ctx, …)`) | nothing |
| C12 | remove call credits (the byte window covers calls) | nothing |
| C13 | two timeouts (`closeTimeout`, `readyTimeout`) instead of eight | per-thing overrides |
| C14 | remove the `handle.change` and `handle.retire` shorthands | nothing |
| C15 | remove `inVariant` and `expectVariant` (keep `RefIn`) | nothing |
| C16 | remove facet-owned mutable documents and their transaction exception | atomic writes across an object and its facet move to one owner |
| C17 | no harness-specific start-barrier exception | factories before the barrier cannot depend on the harness |

## Where the sources disagree

This guide follows the decision log where it is newer than the design, and the design where it is newer than
everything else. The places that need a fix in the sources:

:::review | Review: drift in the written sources
- `design.md` §26 lists only the deferred decisions; it omits the open review-3 items Q11 to Q15 and the cuts C3 to
  C17.
- `design.md` §3 has a garbled sentence, "Values are method arguments are stripped".
- `apps/p2/docs/p3-handoff.md` §3 is stale: it says all R items are decided and, two lines later, that R2 to R5 and
  R7 to R26 are open, and "resume R6 next".
- `kernel.md` and `step-*.md` describe the frozen code: host values, a development freeze, consumer-side linger,
  JSONL storage, descriptions on the wire, and a link closed on an unknown id. None of these is the target.
- `chord-next-walkthrough.md` lags the log: validation by trust (now R7, every caller), dev mode and freeze (removed
  by R9), descriptions once per link (gone with R6), an IPC frame-count window (now one byte window, Q4), job outcome
  `{ ok }` (now `{ kind }`), harness activation as the start barrier (R17), registries "newer refused at load" (Q8),
  and hooks using `host.root` (now `chord(fn, context)`, Q6).
- `apps/p2/docs/questions.md` uses `self.resource` and `replace` (both rejected) and `host.root` in hooks.
- `apps/p2/docs/p3-reviews/v2-cost-model.md`: the measurements are current, its "Decisions this needs" section is
  not (chapter XVII).
- L1's `Implementation<C>` shape differs from the factory return value used in the design (chapter XVI).
:::

# API Reference {.appendix #api lede="Every name the guide uses, grouped by where you meet it. Working names; only the contract layer is built."}

## Hosts

| Call | Meaning | Chapter |
| --- | --- | --- |
| `createHost<P, R>({ address?, principal?, storage?, principalKey?, revokedBy?, telemetry?, onError?, timeouts })` | a host; with an address it is addressable and its own code acts as `principal`; without, a client | I |
| `host.load([{ name, facet }])` | load facets by plugin name; base code passes its core facet the same way | I |
| `host.connect(link, { principal })` | the link to the parent (at most one) | I |
| `host.accept(link, { principal })` | a link from a client; every request on it acts as `principal` | I |
| `host.route(Kind, { authorize, resolve })` | how to reach hosts of a kind; `resolve` returns `{ link, principal }` | I |
| `host.revoke(r)` | end matching objects and links here and below | VII |
| `host.root(fn, { principal?, signal?, telemetry? })` | a call scope with a `ctx` for code outside objects | VI |
| `host.get(Type, input, { signal, state?, parkTimeout? })`, `host.hold(…)` | a reference from outside objects; `release()` ends it | VI |
| `host.serve(Type, factory, { lifetime?, linger? })` | serve an object type (in a facet) | II |
| `host.registry(Registry)` | the composed value of a registry, a readable | XIII |
| `host.references(Type)` | who holds references to objects of a type on this host (presence) | VIII |
| `host.activity` | `{ references, calls, jobs, lingering }`, for keep-alive | I |
| `host.close()` | end the host: objects, natives, links | I |

## Inside a factory: `self`

| Member | Meaning | Chapter |
| --- | --- | --- |
| `self.state(Definition)` | a document handle | V |
| `self.tx(async (tx) => …, ctx)` | a transaction on the object's line | V |
| `self.derive(name, [sources], fn)` | a derived readable | VIII |
| `self.get(Type, input)` | a reference held for the object's life | VI |
| `self.open(open, close, { closeTimeout? })` | a native; `.value` once open | IX |
| `self.routines.on(readable, fn)`, `.every(interval, fn)`, `.loop(fn)`, `.custom(…)` | standing behaviour | X |
| `self.job(Job, { run, finish? })` | owned work that outlives its call | XI |
| `self.contribute(Registry, value)` | a contribution (facets and `lifetime: "host"` objects only) | XIII |
| `self.writable(initial)` | a host-local readable of any in-process value, with `set` | XIII |
| `self.retryOn(readable)` | a trigger that retries a broken activation | VI |

**Document handles:** `value`, `get(key)` (keyed), `keys`, `change(fn, ctx)` / `change(key, fn, ctx)` and `retire(ctx)` / `retire(key, ctx)` (shorthands for
one-document transactions). **Transactions:** `tx.draft(handle, key?, { tags? })`, `tx.retire(handle, key?)`,
`tx.start(job, args, { key? })`. **Jobs:** `job.start(args, ctx, { key? })`, `job.abort(id)`, `job.running`,
`run.outcome(ctx)`.

## References and `ctx`

| Member | Meaning |
| --- | --- |
| `ref.<member>` | a state member (readable: `.value`, subscribe) or a method |
| `ref.state`, `ref.onState(fn)` | `loading`, `live`, `failed` (cause, `retryAt`), `released` |
| `ref.retry()` | retry a failed reference now |
| `ref.release()` | end a reference taken outside objects |
| `ref.members` | the variant's members |
| `ctx.signal`, `ctx.principal`, `ctx.incarnation`, `ctx.get` | cancellation, caller, calling host's incarnation, call-scoped references |
| `ctx.telemetry`, `ctx.trace(name, attributes, fn)` | the current span; a child span with a child `ctx` |
| `ctx.jobId`, `ctx.progress(value)` | in a job's `run` |

## Definitions

| Name | What it declares | Chapter |
| --- | --- | --- |
| `hostKind(name, input?)` | a kind of host and its address | I |
| `remote(name, { version, input, placement, variants })` | an object type reachable across links | II |
| `local(name, { version, input, members })` | an object type on its own host | IV |
| `method(args?, result?)` | a method in a base declaration | II |
| `evolve(prev, (e) => …)`, `checkAccepts(contract, accepts)` | the next contract version; the provider's mappings (**built**) | XVI |
| `Implementation<typeof C>` | the type of a provider for the current version (**built**) | XVI |
| `str num int bool nul lit oneOf union obj arr map opt bytes unknown`, `Static` | schema helpers (**built**) | II |
| `defineState(name, { schema, version, initial, checkpointWhen, persist?, keyed?, ordered?, migrate? })` | a document | V |
| `defineTag<T>(name)` | a tag; `store.retireByTag(tag, value)` | V |
| `defineJob(name, { version, args, progress, result, concurrency?, persist?, accepts? })` | a job type | XI |
| `defineRegistry(name, { version, compose, accepts? })` | an extension point | XIII |
| `bindFacet<P>()` | base code's `defineFacet`, with factories' principals typed as the app's `P` (working name) | III |
| `defineFacet((host, self) => …)` | a plugin's setup for one kind of host; imported from base code (`@studio/core`) | II, III |
| `constant(value)` | a readable that never changes (start data) | IX |
| `broken(error)` | a failure that is not retried by the backoff | VI |
| `inVariant(ref, …)`, `expectVariant(ref, …)`, `RefIn<…>` | narrowing a reference by variant | III |
| `mapShared(fn)` | an array map that keeps unchanged items identical (planned in Delta) | VIII |
| `OutputBuffer`, `Progress` | bounded output and throttled progress (`@earendil-works/chord/output`) | XI |
| `memoryLinkPair()`, `ipcLink(child)`, `webSocketLink(ws)` | link adapters | I |
| `DocumentStorage`, `registerDocumentStorageConformance` | the storage port and its shared test suite | V |

# Timeouts and Defaults {.appendix #defaults}

| Timeout or default | Bounds | Default | Override |
| --- | --- | --- | --- |
| `closeTimeout` | a native's `close`, then reported as a possible leak | 30 s | per native |
| call drain | an ending object's own call handlers | = `closeTimeout` | per type |
| `readyTimeout` | activation; an awaited `get` | 60 s | per `get` |
| park deadline | parked calls (link drop, loading, rollout) | 60 s | per `get` (`parkTimeout`); per type |
| routine handover | a new routine waiting for the old handler on reload | 10 s | per routine |
| `finish` retry | backoff of a throwing job `finish` | 1 s to 60 s | per job |
| rollout install | one host installing a revision | 60 s | none |
| linger | an object kept alive after its last reference | per type | per type |
| backoff | retries of transient failures, per address | 1 s doubling to 60 s | none |
| eviction | keyed persisted documents idle in memory | 10 minutes | |
| client WebSocket limits | per part | 16 MiB compressed, 64 MiB decoded | per link kind |
| compression | JSON parts compressed at their origin | above about 16 KiB | |
| worker keep-alive (p2, app code) | idle time before the supervisor stops a worker | 5 minutes | app |

# Versions {.appendix #versions}

| Surface | Version | On change | Chapter |
| --- | --- | --- | --- |
| object type | `version` plus fingerprint | `evolve` and `checkAccepts`; otherwise `contract_mismatch` | XVI |
| document | `version` plus schema fingerprint | pure `migrate` on access; no bump fails `broken` | V |
| job | `version` | `accepts` on outcomes and `running`; `blocked` without | XI |
| registry | `version` | `accepts` on contributions; unmatched ones left out and reported | XIII |
| native | none | restarts on reload | IX |
| Durable tasks and documents | Durable's `version` | Durable's `migrate` | XIV |
| link protocol | protocol version | refused; hosts update together | XVII |
| UI components, Chord and app APIs | none yet | exposed as they are | |

# Errors and States {.appendix #errors}

`ChordError` has a stable `code` and a finer `reason`; on the wire it is `{ code, reason?, message, details? }`
(specified in `layer-1.md`, not built).

| Code | Meaning |
| --- | --- |
| `invalid` | input, arguments or placement rejected (`invalid/input`, `invalid/args`, `invalid/placement`) |
| `contract_mismatch` | the consumer's version and fingerprint are neither current nor accepted |
| `forbidden` | the caller may not do this |
| `gone` | the object or hold ended |
| `not_ready` | not activated in time |
| `released` | the reference was released |
| `too_large` | a part exceeded its size limit |
| `unavailable` | could not be reached before the deadline (`unavailable/locked` and others) |
| `aborted` | cancelled by a signal |

| Type | Values |
| --- | --- |
| `FailureCause` | `{ kind: "transient"; error }` (retried with backoff) or `{ kind: "broken"; error }` (retried only by a trigger) |
| reference state | `loading`, `live`, `failed` (cause, `retryAt`), `released` |
| job outcome | `{ kind: "done"; result }` or `{ kind: "failed"; error: "threw" \| "aborted" \| "lost" }` |
| job phase | `running`, `finishing`, `blocked` |
| rollout status of a provider | `updating` (calls park), rejected (fail at once), same revision (`contract_mismatch`) |
| host install report | `installed`, `installed_failed`, `rejected` |

# Rejected Designs {.appendix #rejected}

From `design.md` §31, grouped. Each was considered and is not coming back without a new reason.

| Area | Rejected |
| --- | --- |
| reload | drain-based handover; object restart for state changes; a factory trial; a migrate dry run; a consumer contract check during staging; reload votes; per-plugin rollback within a host; keeping natives across reloads by name; `restart_required`; host values and a development freeze |
| state | version fences without transactions; volatile documents; per-group lines; optimistic transactions; `tx.get`; a JSONL document storage; validating state and documents on commits or reads; copying values on same-host calls; op-rewriting projections and a view algebra; Durable's Session as the object store |
| objects and references | resources replaced in place (`replace`, `deps`, stale handles); revoking proxies on `.value`; consumer-side linger; detached references counting toward presence; an `optional` flag on references; `opaque` members; callbacks as method arguments; generic call or request ids; a stream type in Chord |
| registries | registries created at runtime; entries resolved through mutable indirection; generic registry keys with a `conflict` flag; numeric middleware priorities; registry composition as a staging check |
| principals and placement | principal field patterns and re-stamping for revocation; `storeKey`; placement as data naming an input field; host-name strings in app code; "magic" input-field matching for delete |
| wire | an outbox for transient delivery errors; cross-relay reset coordination; count limits that refuse calls or holds; contracts taken from the running app |
| process and tooling | a topology layer above the host API; loader variants A and B; Chord ending the process on a storage failure; `defaultProjectTrust: "always"`; ceremony (`native/` directories, `defineNative`, lints); weakening type checking |

# Glossary {.appendix #glossary}

**Adapted binding:** a consumer bound at an older accepted contract version, served through the provider's mappings.
**Base code:** the app's own code, imported statically; a change restarts the hosts. **Client:** a tab or TUI host,
not addressable. **Contract:** an object type's declaration (name, input, placement, members, version).
**Contribution:** a value a plugin adds to a registry. **`ctx`:** what every call receives. **Derive:** a value
computed from readables. **Document:** a named JSON value an object owns. **Facet:** a plugin's code for one kind of
host. **Factory:** the synchronous function that declares an object. **Fingerprint:** a hash of a contract's or
schema's normal form. **Flow:** input into running work, kept as state by its owner. **Host:** one participant of the
app, with an identity and an incarnation. **Incarnation:** the id a host gets on every start. **Input:** an object's
key among objects of its type; with the type and the caller's principal key it identifies the object. **Job:** owned work that outlives its call. **Link:** an ordered connection between
two hosts. **Local type:** an object type reachable only on its own host, without principals. **Native:** an OS-level
value opened with `self.open`. **Park:** a call waiting for a reference to become live again. **Placement:** the
function from input to host address. **Plugin:** a directory with a `package.json`, reloadable. **Principal:** who
calls, stamped by the link. **Principal key:** the string that identifies a principal in object identities. **Pure
object:** an object without natives; swapped in place on reload. **Readable:** a value plus its ordered changes.
**Reference:** what `get` returns. **Registry:** an owner's extension point. **Relay:** a host forwarding messages
between two links, rewriting only headers. **Reload:** swapping a plugin's code in running hosts. **Restart:** ending a
process. **Revision:** the complete code set the hosts should run. **Revocation:** ending live access for principals
matched by `revokedBy`. **Routine:** standing behaviour of an object. **Server:** the addressable root host. **Shared
store:** a local object that holds data once behind per-principal views. **Tag:** a typed label on documents, used to
retire them together. **Transaction:** an atomic set of document writes on the object's line. **Variant:** the set of
members a principal gets. **View:** a per-principal remote object in front of a shared store. **Worker:** a host the
server starts for one session.

# Sources {.appendix #sources}

| Source | Used for | Weight |
| --- | --- | --- |
| `packages/chord/docs/next/decisions.md` | every decision, review rounds 2 and 3 | wins where newer |
| `packages/chord/docs/next/design.md` | the target design, all chapters | authoritative otherwise |
| `packages/chord/src/next/contracts/` and its `README.md` | chapter XVI | built code |
| `packages/chord/docs/next/layer-1.md` | errors, inputs, argument checks | draft spec |
| `apps/p2/docs/p3-reviews/v2-review3-summary.md` | open Q11 to Q15, cuts C3 to C17 | current |
| `apps/p2/docs/p3-reviews/v2-cost-model.md` | measurements, per-hop costs | current except its last section |
| `apps/p2/docs/p3-functions/` | chapters XVIII to XX | current |
| `apps/p2/docs/p3-handoff.md` | status and order of work | §3 partly stale |
| `packages/durable/README.md` | the harness, submit, tasks, subagents | current |
| `chord-next-walkthrough.md`, `kernel.md`, `step-*.md`, `apps/p2/docs/questions.md` | background only | lag the decisions (see What's Next) |
| DeepSeek Harness at `687f282` (its Cordis tutorial, architecture, persistence, core and HMR docs), the Cordis paper (arXiv 2608.25512) | "Other Ways to Do It" | external, built systems |
