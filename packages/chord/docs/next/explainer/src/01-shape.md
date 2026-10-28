
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
