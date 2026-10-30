# Chord v2: target design

The design of Chord v2 (`packages/chord/src/next`, export `@earendil-works/chord/next`) and of how apps (the
playground, p3) use it: **the one current statement of every rule** (owner, 2026-10-24). Every decision is recorded in
the decision log `packages/chord/docs/next/decisions.md` (the history and the reasons, kept complete) and folded into this
document in the same commit. Where a rule is built, the slice is named (`slices.md`); the code follows this document.
It replaces `apps/p2/docs/target-design.md`.

Marks: everything is decided unless marked **Decision needed** (problem with an example, then options; nothing in such
a block is settled; section 26 lists them all). **(carried over)** marks behaviour of today's Chord that v2 keeps
without a new decision. API names are working names.

Contents: 1 goals · 2 concepts · 3 hosts and links · 4 principals · 5 object types · 6 objects · 7 references · 8 ctx ·
9 documents · 10 store and storage · 11 kinds of state · 12 derives · 13 natives · 14 routines · 15 jobs · 16 the facet
· 17 registries · 18 start data and platform bindings · 19 presence · 20 input into running work · 21 reload and rollout
· 22 wire · 23 optional components · 24 Durable integration · 25 apps: ownership and porting · 26 decisions needed · 27
versions and adapters · 28 building: slices · 29 telemetry · 30 cost model · 31 rejected

---

## 1. Goals and principles

1. **Reload without restarts.** A plugin's new code takes over inside the running app: hosts keep running; data, open
   connections and running work survive where they can. Reloads are explicit (a button or a command), never on save.
   Base code (Chord, the app runtime) restarts the hosts.
2. **Ownership.** Every thing has exactly one owning object, the smallest it belongs to. The owner holds the data,
   enforces its rules in its methods and offers the operations others need. Nobody reaches past it.
3. **Factories declare, Chord activates.** A factory is synchronous and only declares; Chord performs activation.
   Handles a factory gets are valid for the object's whole life.
4. **Natives only in objects.** OS-level values are opened and closed by the object that owns them, and reach other
   plugins only through that owner's methods, state or registry entries.
5. **Errors look like disconnects.** No request-id framework; consumers handle a failed call as they handle a dropped
   link. References re-hold by themselves.
6. **Tagged unions, always.** States, results and outcomes are discriminated by `kind`; each state carries exactly its
   own fields.
7. **Portable kernel.** A host is a logical identity plus an incarnation; facets may come pre-imported; values are
   JSON plus bytes independent of the transport. Node first; Cloudflare Durable Objects and similar stay possible.
8. **Context last.** Parameters are the required arguments, then the context (`ctx` or a Durable `Context`), then
   optional arguments: `self.tx(fn, ctx)`, `handle.change(key, fn, ctx)`, `chord(fn, context)`, `job.start(args, ctx,
   { key })` (owner, 2026-10-21).
9. **Few concepts, no ceremony.** No special directories, no `defineNative`, no lints standing in for design.
10. **Aligned with Durable** (owner, 2026-10-27): where Chord and Durable solve the same problem (commits, lines,
   loads, storage errors, watches), they use the same rules and mechanisms.

---

## 2. Concepts

| Concept | What it is |
| --- | --- |
| host | one participant (a process, a tab, a DO): a logical identity plus an incarnation |
| link | a connection between two hosts |
| host kind / address | typed description of addressable hosts / one host of a kind (`Session({ id })`) |
| facet | a plugin's declarations for one host kind: the types it serves, its contributions; no state or behaviour of its own |
| object type | a contract: name, params (which instance), host address, members, version |
| object | one instance per (type, params, principal key); `local`: per (type, params) |
| principal | who calls; stamped by links, typed by the app |
| reference | what `get` returns; keeps its object alive; live and hydrated when awaited |
| document | a named JSON value an object owns, written in transactions |
| derive | a value computed from watchables |
| native | an OS-level value opened with `self.open`; only in objects |
| routine | standing behaviour of an object: `self.on(source, fn)`, `self.onLive(fn)` |
| job | owned work a call starts that outlives it: intent, run, finish; optional state document per run |
| registry | an owner's extension point: one contribution per contributor, composed by the owner |
| shared store | a `local` object holding shared data once, behind per-principal `remote` views |
| `ctx` | per call: cancellation, principal, call-scoped references |
| revision | (server incarnation, sequence): the complete code set a host runs |

---

## 3. Hosts and links

### Roles

A Node app has one shape:

```
client client client      browsers, TUIs: not addressable
   └──────┼──────┘
        server            exactly one, addressable
   ┌──────┼──────┐
worker worker worker      addressable by a typed address, started on demand
```

| Role | Addressable | Principal comes from | Lifecycle |
| --- | --- | --- | --- |
| client | no | authentication of its link | connects by itself |
| server | yes, one | its own declaration | runs |
| worker | yes, many | stamped by the parent | started on demand by the app |

Clients serve only `local` types (they are not addressable): a host without a principal or without an address refuses
to serve a remote type (a declaration error: `load` leaves that plugin out and reports it, a reload keeps it on its
old code; a remote object is owned by a principal of the host serving it, owner,
2026-10-24; and placed by its host address, owner, 2026-10-29). No client providers for now (owner,
2026-10-28): client-side capabilities (a camera, WebMCP tools) go through an owner's requests that clients answer
(section 20, the Questions service). A client's local
calls have no principal; what a client calls on the server is stamped with the client's authenticated principal.
Clients reach workers only through the server, which relays; workers reach each other through the server too. A
detached process (e.g. a terminal host) would be another child kind of the server. Things that are not hosts: a code
mode sandbox (a worker thread inside a worker), remote environment daemons (their own protocol, owned by an object),
the TUI sandbox behind its launcher (the launcher only passes frames). A Durable Object deployment is a mesh routed by
the edge (section 24 and the research note).

### Host kinds and addresses

```ts
export const Server = hostKind("server");
export const Session = hostKind("session", { id: str() });      // params like a contract's

export const Notes = remote("notes", {
  version: 1,
  params: { session: str() },                                   // flat record of required scalars
  hostAddress: ({ session }) => Session({ id: session }),       // a typed function of the params
  variants: { … },
});
export const Catalog = remote("catalog", { hostAddress: () => Server(), … });
```

- `hostKind(name, params?)` declares a kind of addressable host; its params follow the params policy of contracts
  (section 5). `Session({ id: "S1" })` is an **address**: `{ kind, params, key }`, the key built like an identity key
  (`session|S1`); two addresses are equal when their keys are. No host-name strings appear in app code.
- **`hostAddress`** (owner, 2026-10-21 as `placement`, renamed 2026-10-29) is a typed function of the params returning
  the address of the host that serves the object, required on every `remote` contract (owner, 2026-10-29); `local`
  contracts have none. It is not part of the contract fingerprint; a changed rule surfaces as a refusal (below).
- **`params`** (owner, 2026-10-21; was `input`) select the instance among objects of its type and are part of its
  identity (section 5).
- **The caller computes the address** and sends it in the `hold`; a host that relays routes by that address alone and
  never needs the contract or parses params. **The provider computes it again** from the params: a hold naming this
  host whose params the provider's code places elsewhere (code skew) waits unbound `version` (`failed { waiting }`,
  `invalid/host_address`, dependency model §1; slice 7a); a hold naming another host's address is relayed, never served
  here (misrouted holds are never captured by a relay that serves the same name).
- **Every reference is a request** (dependency model, slice 7a): it has one holder (an attempt, a call, outside code,
  a link's peer) and ends only when its holder ends it (release, a call settling, a getter giving up, the peer's link
  or origin closing, revocation, the host closing), never because its provider is missing, went away or does not fit.
- **Where a reference made on a host, or a hold arriving on one of its links, goes**, by address alone (slice 4a;
  slice 7a: no same-name check on the consumer's host):

  | Case | Goes |
  | --- | --- |
  | a `local` type | here |
  | a `remote` type whose host address (computed here from the params) is this host's address, served here or not | here |
  | an arriving hold naming this host's address | here |
  | the address (computed, or named by the hold) is of a kind this host has a route for | over that route's link (the address's params checked against the kind, then `authorize`) |
  | otherwise (a remote type) | over the parent link; a hold that arrived *on* the parent link is never sent back to it: `unavailable` |
  | no parent link: the host never had one | `unavailable` |
  | no parent link: it is down (a drop) | waits on the parent path, `loading`, until the next link (design audit, 2026-10-27) |

  A `hostAddress` or `authorize` that throws fails the request broken with that error; an address whose params fail
  the kind's check is broken `invalid/host_address`.
- **The publication gate** (slice 7a): a request made on this host, or a hold arriving on its links, before the
  host's first publication (`load`'s batch of declarations) is not placed yet: it is `loading`, and the publication
  places it. The gate lasts only for the synchronous setups, never for activation, so it cannot deadlock.
- **Then the selected provider is checked** (here: served, the version and fingerprint, the params, the provider's
  own host-address check; over a path: at the provider host). Version checks never look at a same-name registration
  elsewhere. What the check finds:

  | The check finds | The request |
  | --- | --- |
  | a fitting provider | bound (to the object here, or to the hold over a path) |
  | not published yet | unbound `unpublished`: `loading` |
  | nobody serves the name at its address (or serves it as the other kind) | unbound `not_served`: `failed { waiting }` (`unavailable` "X is not served here") |
  | no fitting version, a fingerprint that differs at the same version, a host address the provider computes elsewhere | unbound `version`: `failed { waiting }` (`contract_mismatch`, `invalid/host_address`) |
  | a registry served, but its first `compose` (or the reader's version mapping) threw | unbound `compose`: `failed { waiting }` (§17) |
  | the path has no link (a drop, a route resolving) | on the path: `loading` |
  | `authorize` refused, invalid params, a cycle | `failed { broken }`, never indexed |

  The unbound reasons that wait for a name are indexed under it on the host that decided them: the consumer's host
  for a request made there, the provider's host for a hold that arrived over a link (kept refused there; a `retry`
  re-runs its start). A publication serving a name (`load`'s, or a reload's commit, which wakes only the requests of
  the names it serves, slice 7b) wakes its requests, which run their check again
  (a refused hold sends `loading`, then `bound` or `failed`); no new message kind. Index entries go when their request
  ends (GC-tested). The consumer never re-holds a request by itself: no backoff, no polling.

### The low-level host API

```ts
// server.ts
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError });
server.route(Session, {
  authorize: (p, address) => p.kind === "owner" || p.kind === "server" || (p.kind === "guest" && p.session === address.params.id),
  resolve: async (address, context) => {
    const child = fork("worker.ts", [], { serialization: "advanced" });   // no `signal`: see below
    child.send({ id: address.params.id, init: await initFor(address.params.id) });   // the app's own start message
    return { link: ipcLink(child), principal: { kind: "worker", session: address.params.id }, trusted: true };
  },
});
await server.load([{ name: "@app/core", facet: coreServerFacet(config) }, ...serverPlugins], ctx);

wss.on("connection", (ws, req) => {                     // an entry point: app or adapter code
  const principal = authenticate(req);
  if (!principal) return ws.close(4401);
  server.accept(webSocketLink(ws), { principal }, ctx);
});
radius.onChannel((ws) => server.accept(webSocketLink(ws), { principal: { kind: "owner", access: "relay" } }, ctx));
```

```ts
// worker.ts: connect first (W6), then load; start data through the core facet (section 18)
const { id, init } = await startMessage(process);
const worker = createHost<P>({ address: Session({ id }), principal: { kind: "worker", session: id }, onError });
worker.connect(ipcLink(process), { principal: { kind: "server" }, trusted: true }, ctx);   // stores may reference server types
await worker.load([{ name: "@app/core", facet: coreWorkerFacet(init) }, ...workerPlugins], ctx);   // serves SessionInfo
await (await worker.get(Harness, {}, ctx)).resume(ctx);              // tasks run only after every plugin loaded

// a browser tab
const tab = createHost<P>({ onError });
await tab.load(webPlugins, ctx);
tab.connect(webSocketLink(new WebSocket("/chord")), { principal: { kind: "server" } }, ctx);
const notes = await tab.get(Notes, { session: "S1" }, ctx);   // tab → server → route(Session) → worker
```

```ts
// a test: everything in one process
server.route(Session, {
  authorize: () => true,
  resolve: async (address) => {
    const [up, down] = memoryLinkPair();
    const principal = { kind: "worker", session: address.params.id } as const;
    const worker = createHost<P>({ address, principal, onError });
    worker.connect(up, { principal: { kind: "server" } }, ctx);          // W6: connect, load, resume
    void worker.load([{ name: "@app/core", facet: coreWorkerFacet({ id: address.params.id }) }, ...workerPlugins], ctx);
    return { link: down, principal };
  },
});
```

Do not pass `context.abortSignal` to `fork`: `host.close` aborts it, which kills the worker and makes Node emit an
`error` event that crashes an app without a handler. Chord closes the link at `host.close`; the worker exits when its
parent link closes. `resolve` returns the link before the worker has loaded (the worker connects first, W6): a
`resolve` waiting for the worker's `load` while the worker's facets hold server types would deadlock.

| Call | Meaning |
| --- | --- |
| `createHost<P>({ address?, principal?, ...options })` | with an address: addressable, serves only objects placed there, acts as `principal` on its own host; without: a client. `P` is the app's principal type |
| `load([{ name, facet }], context)` | facets with their plugin names (the plugin's `package.json` name, npm style; duplicates and invalid names are refused); runs every facet's setup, publishes all of them in one batch (types and registries served, registries composed once, contributions; requests waiting for the publication are placed after it), then waits for the start barrier (section 21: the first outcomes of its host-lifetime objects, slice 7a); a plugin whose setup throws is left out and reported (`load` resolves with `{ failed: [{ plugin, error }] }`, decision "Per plugin at startup and reload"); runs once. Loaders are adapters; base code passes its core facet the same way |
| `reload([{ name, facet }], context)` | the complete new plugin set after `load` (a facet passed as the same object is an unchanged plugin): staging, then one commit, then every object of a changed or removed plugin takes its fate; resolves with a report (a plugin whose new code fails keeps its old code, listed in `failed`); one at a time (section 21, slice 7b) |
| `connect(link, { principal, trusted?, codec? }, context)` | the link to the parent, at most one open; once it closed (a drop), `connect` takes the next, and every remote reference over the parent is held again on it. `principal` = who the parent is |
| `accept(link, { principal, trusted?, codec? }, context)` | a link from a child; holds and calls on it act as `principal` |
| `route(Kind, { authorize, resolve }, context)` | how to reach hosts of a kind (below); called before `load`, once per kind; work arriving on its links runs under `context`; returns a `RouteHandle` whose `retry(address)` ends that address's backoff (slice 10 D10b) |
| `get(Type, params, context, { readyTimeout? })` | a reference once its object is live, waiting through `loading`, `failed { transient }` and `failed { waiting }` up to its `readyTimeout` (section 7) |
| `hold(Type, params, context, { readyTimeout? })` | a reference at once that follows its object until released (section 7) |
| `close(context)` | closes the links (children, routes, then the parent), then ends every object at once and tears them down, the last to go live first (reason `close`); rejects with an `AggregateError` of the native closes that threw |
| `revoke(r, context)` | revocation (section 4; slice 4b) |
| `root(fn, context, { principal? })` | a call scope for code outside objects (a Durable hook, a CLI): `fn` gets a handler's `ctx`, sealed when `fn` settles, `context` aborts or the host closes (slice 8 D3, section 8) |
| `registry(R, context, { readyTimeout? })` | registry `R`'s composed value for code outside objects once it is usable; waits for the publication, then while it has none up to its `readyTimeout`, then rejects with the last error (slice 8, 7a, section 17) |

**Options of `createHost`:** `address`, `principal`, `principalKey` (section 4; the same function on every host),
`telemetry` (section 29), `onError`, `closeTimeout`, `readyTimeout`, `heartbeat: { ping?, close? }`; later `revokedBy`
(section 4, slice 4b) and `store` (section 10, slice 6a: the store, opened by the app with `openStore(backend, ctx)`
and closed by the app with `store.close(ctx)` after `host.close`; the host never closes it). **`onError`** receives everything that fails in the
background, as a tagged `HostError`: `listener_error` (a watch listener threw), `delivery_failed` (a frame delivery
threw), `activation_failed { object, failure }`, `close_failed { object, native, error }`, `close_timeout { object,
native }`, `drain_timeout { object }`, `protocol_error { error }`, `resolve_failed { address, error }`; later routine
errors (slice 5), `derive_failed { object, member?, error }` (a derive's compute threw, once per failure episode, slice 6a), the registries' `registry_conflict { registry, message, plugins }`, `registry_failed { registry, error }`, `contribution_failed { registry, plugin, type?, error }` and `contribution_refused { registry, plugin, type?, version }` (each once per episode, slice 8), `object_failed { object, failure }` (a live object failing, slice 6a, `broken`; `transient` when a `self.follow` source failed, slice 6b R4; `failure` where the value is a `FailureCause`, `error` otherwise, 2026-10-27), `job_interrupted { object, job, id, restarts }` (a persisted run ended at the restart limit, slice 6b D6), `parked_long { object, waitingFor, state, since }` (an attempt parked longer than its `readyTimeout`, whatever its blocker, once per parking episode: a diagnostic of a ring across hosts started at the same moment or a long wait, slice 7a, audit A11, §6) and `storage_failed { error }`
(slice 6a), which every app must handle: Chord never ends the process,
the app exits with its own code for its supervisor or reopens.

**Timeouts** are host options; no fixed numbers in the code. Two host timeouts (C13, owner, 2026-10-22):

| Timeout | Bounds | Host default | Override |
| --- | --- | --- | --- |
| `closeTimeout` | a native's `close` (then reported as a possible leak; the rest continues); the drain of an ending object's running handlers (callers are rejected at once) | 30 s | per native: `self.open(open, close, { closeTimeout })` |
| `readyTimeout` | an activation attempt's own steps (its wait for the previous instance's teardown included; paused while the attempt is parked on its dependencies, slice 7a); a getter's whole wait; how long a call made while its reference is loading waits (the park deadline) | 60 s | per `get`/`hold`/`registry`: `{ readyTimeout }` |

The park deadline's per-type override is not built (only if a real case needs it). Timeouts of later slices belong to
their mechanisms: the routine handover uses `closeTimeout`, a job `finish` backs off 1 s to 60 s, provider-side
`linger` is per type; a reload has no install timeout (it takes the app's context, slice 7b); a per-type drain
override only if a case needs it (section 26). A route's `resolve` is bounded by the app.

- **Incarnations** are minted by Chord (uuidv7, code copied from pi-ai, no dependency), never passed in, and carried
  in the link handshake (`hello`): the other side sees a restart as a new incarnation of the same identity;
  references to it re-hold.
- **Entry points vary** (loopback or tunnel WebSocket servers, Radius dialing out and delivering channels, a DO edge,
  memory), so the kernel has no `listen`; each entry point authenticates and calls `accept`. Radius no longer needs to
  pose as a loopback request with a secret header.
- **App code, not Chord:** starting processes, init data, authentication, keep-alive decisions. Helpers come only when
  apps repeat the same code.
- Compared with today's Chord: same shape (`createHost`, `connect`, `accept`, `route`, `load`); gone are string host
  names and prefix parsing, app-managed generations, the duplicate `upstream` option, `opaque` runtime objects and the
  loader inside the kernel.
- **Worker keep-alive** works as in p2: the worker counts, the app's supervisor decides. **`host.activity`** (slice 4b;
  owner, 2026-10-24) is a JSON `Watchable` of `{ references, calls, jobs, lingering }`: holds arriving over links,
  method calls running on this host, running jobs, provider-side lingering objects. Counters are kept where the work
  happens; a change marks it dirty and it is published at most once per microtask turn with changes. A hold placed
  here counts from its arrival to its end, bound or not (one waiting for a missing provider keeps the worker alive;
  slice 7a); a hold this host relays counts at its destination; `host.references` lists bound references only. Core code
  reports it plus Durable tasks (the core `Harness`); the server's supervisor stops the worker when all are zero for
  the idle time (p2: 5 minutes, checked every second). Chord provides the counts, no idle logic.

### Routes

```ts
host.route(Session, {
  authorize(principal: P, address: Address<typeof Session>): boolean;
  resolve(address: Address<typeof Session>, context: Context):
    Promise<{ link: Link; principal: P; trusted?: boolean; codec?: Codec }>;
});
```

- **`authorize`** runs for every hold routed over the route, with the hold's principal (section 4), before anything
  starts; `false` fails the hold broken `forbidden`.
- **`resolve`** runs at most once at a time per address: the first hold starts it, later holds wait for the same
  link. The returned principal is stamped on that link; `trusted` and `codec` as for `accept`. Its `context` is
  aborted only when the host closes; a link it returns after that is closed at once. A `resolve` whose holds were all
  released meanwhile finishes and its link is kept (a worker start that produced a link finishes even if its first
  requester left). A `resolve` that never settles is the app's (it bounds its own `fork`); getters still time out.
- **Failure and re-resolve:** a rejected `resolve` (reported `resolve_failed`), a returned link already closed, or the
  address's link closing while holds over it exist, starts the **per-address backoff** (1 s doubling to 60 s; a map
  keyed by address, separate from objects' identity backoff). Meanwhile the holds are `loading`. Only a link that
  completed its handshake resets the backoff. Without holds for the address nothing is resolved again, so passive
  viewers recover without a user action while they hold. `RouteHandle.retry(address)` (slice 10 D10b) ends an
  address's backoff, so `resolve` runs at once if it has holders (a Retry button for a worker that failed to start).
- Chord never closes a route link itself except at `host.close`; stopping idle workers is the app's (`host.activity`).
- Work arriving on a route's links runs under the context given to `host.route(Kind, options, context)` (slice 4b).

### Links

- **A link is delivery only:** an ordered, bidirectional channel of `Uint8Array` messages; adapters only move bytes
  and close both ends. Session recovery is the adapter's policy. Implementations (slices 3a, 4a):
  - `memoryLinkPair()`: delivers with `queueMicrotask` (no Node APIs); closing one end closes the peer a microtask
    later.
  - `ipcLink(port)` over a Node IPC channel (`fork` with `serialization: "advanced"`, or `process` in the child),
    typed structurally (no Node import in Chord). A `Uint8Array` crosses as one message; other messages on the
    channel (the app's start message) are skipped. It listens from the moment it is made and queues until its
    listener is set. `send` returning `false` is backpressure, not failure; a thrown `send`, an error callback or
    `disconnect` closes the link once; listeners are removed on close.
  - `webSocketLink(socket)` over a WebSocket (`ws` in Node, the browser's), typed structurally: one binary frame per
    message, `binaryType = "arraybuffer"`; messages sent while the socket connects are buffered until `open`; a socket
    closing or closed already gives a closed link; `close`, `error` and a text frame close it. The transport's
    `maxPayload` stays its hard cap (code 1009 closes the connection).
- **One link object per link carries both directions** (slice 4a): the channel (handshake, codec, checks,
  heartbeat), a **provider side per origin** (holds and calls the peer sent, its own or those of a relay's downstream
  link, by the peer's ids) and a **consumer side** (holds and calls this host's own references sent, by its own
  counters). Message kinds are directional, so each goes to its side. A link carries nothing until a hold or call
  (W6).
- **Roles:** `parent` (made by `connect`), `child` (`accept`), `route` (`resolve`). The role decides whose principal a
  hold acts as (section 4). **Trusted links** are an explicit option (`trusted: true` on `accept`, `connect` and in
  `resolve`'s result; default untrusted; never inferred from the link kind; owner, 2026-10-23): they skip only the
  `MESSAGE` schema check; framing, the codec's decode, `checkParams`, `checkArgs` and Delta decoding still run. Trust
  never grants the principal fields (they are read only on the parent link).
- **Remote objects belong to a path:** the parent, or a route address. Each new link of a path holds every remote
  object of that path again (with new hold ids); a closed link drops its tables and the objects go `loading`.
- **Heartbeat on every link kind, in the protocol layer** (owner, 2026-10-23): each link keeps a `lastReceived`
  timestamp (every received message; sends do not count); the host runs one interval timer for all its links (none per
  message). A link silent for 15 s sends `ping` (after its handshake); the peer answers `pong` at once, never queued
  behind the window. A link silent for 30 s, the handshake included, is closed (its references go `loading`). Both
  numbers are host options (`heartbeat`). The heartbeat detects a silent transport (TCP does not notice a sleeping
  laptop), not a peer that answers pings but withholds acks (bounded by the window and the pending cap instead). A
  handler that blocks the event loop longer than 30 s gets its links closed (documented).
- **Flow control: an ack-clocked window per origin** (owner, 2026-10-23; per origin 2026-10-24). Per (link, origin), at
  most **K = 2** of the provider's own `bound` and `state` messages are unacknowledged; only these two kinds count
  (everything else is control, never queued behind them). The consumer sends `ack` (with the message's origin) after
  applying each, after its batch; an `ack` crossing nothing in flight is ignored. While the window is full:
  - each touched hold member keeps its ops in its **pending queue** (section 11: raw, never mutated, folded through
    the leaf index, at most 10,000 ops, then only "replace with the current value"); when an `ack` frees a slot, one
    `state` message carries every waiting hold's entry, its members' pending ops encoded once (or `[["r", value]]`
    after an overflow), all reflecting the latest commit, still atomic for the consumer. So a slow consumer gets
    coarser updates, never stale ones (measured: a `bufferedAmount` cap alone left state 9.4 s old behind kernel and
    proxy buffers; acks kept it 0.0 s old);
  - a hold that binds waits for a slot; its snapshot and subscription are taken in one synchronous step when its
    `bound` is sent; bindings and waiting state take turns when both wait, so neither starves;
  - a hold whose object leaves `live` while its `bound` waits goes back to pending (D1, owner, 2026-10-24; built in
    slice 7b with the reload, which makes a live object leave `live`); so does a bound one, unbound (§7, §22).
  Not built, by decision: a byte window, credit messages, snapshot admission or debt, an adapter `backlog()` API,
  `reset` from anyone.
- **Calls: a call window N** (default 256, the same on every host) announced in `hello`: how many concurrent calls a
  side accepts **per origin**. A side sends no call before the peer's `hello`. A host sends at most N of its own calls
  per link in flight; further calls wait in the link's **call queue**, one FIFO, sent in order as replies free slots;
  nothing is refused for being "too many" (K16). A slot is freed once per call: by its `result` or `error`, its
  `abort` (when sent, at the caller; when received, at the provider), its hold's `release`, `gone`, its origin's
  `closed` or the link closing. A call still queued when its hold rebinds (`loading`) is rejected `unavailable` (it may
  name a method of the old variant). A provider seeing more than N running calls of one origin closes the link
  (protocol error); a call naming a hold it does not know is ignored before it is counted (Q1). A per-link N, if ever
  needed, must bound a relay's forwarding too.
- Holds are not limited by count (authorization and params checks protect them); size limits are a separate check
  (section 22). Byte-heavy traffic (terminals) uses separate channels (section 23), so a large state message never
  holds up keystrokes.

### Relays (slice 4a; decision "Relay flow control per origin", owner, 2026-10-24)

A host that receives a hold it cannot serve (the table above: a route or the parent) **relays** it: it holds
it again on that link (upstream) with the arriving hold's principal and incarnation, and forwards between the two
without parsing payloads. The provider keeps the window, the pending queues and the calls per origin; the relay never
drops, folds or resets.

- **Origins:** the relay gives each downstream origin (a downstream link, and the origin its messages carry when that
  link is itself a relay's) a number, one counter per host, never reused; 0 is a host's own work. Every message
  upstream for that origin carries `origin`; the provider keys holds, calls, windows and acks by (link, origin, id), and
  its answers carry the origin back. `origin` is honoured on every link (a worker may relay a child's hold to its
  parent); principals and incarnations stay parent-only.
- **Ids are not renumbered:** an upstream hold has the downstream hold's id under the origin's number; calls the same.
  Two tabs (two holds) of one principal are two upstream holds, each with its own encoders (R1).
- **Nothing is parsed:** the relay routes by the hold's address and authorizes it; params, arguments, results,
  snapshots and ops travel as opaque parts. Cost per message: decode the envelope, swap the origin, encode the
  envelope; parts copied once into the outgoing buffer.
- **What the relay keeps:** per relayed hold, its upstream link and its original `hold` message (params copied once),
  which routes `call`, `abort`, `retry` and `release` upstream at once and holds again on the next link; per
  downstream origin, the FIFO of the sender of each `bound`/`state` message in flight and the set of upstream links it
  relayed to.
- **Forwarding up:** `hold`, `call`, `abort`, `retry`, `release` with the origin's number; a hold waiting for its
  route is sent when the link exists; a `release` before that drops it. A call is forwarded at once; with no upstream
  link it is answered `unavailable` (it crossed the `loading` notice). Each downstream consumer is bounded by its own
  N, so the upstream sees at most N per origin.
- **Forwarding down:** a message from upstream with an origin goes to that origin's provider side, which forwards it
  with its own origin (none for a tab), ids and parts unchanged. **A link answers only for what was relayed over it**
  (owner, 2026-10-24): every entry of a `bound` or `state`, every `failed`, `loading` and `gone` by its hold, every
  `result` and `error` by its call is checked against the relay's table; an answer for a hold or call not relayed over
  the link it came from is dropped (Q1: also one crossing a release). A `bound` or `state` left with some entries is
  forwarded with those; left with none, it is acknowledged to that link at once. A message for an origin from a link
  the origin relayed nothing to is ignored whole.
- **Acks:** the relay forwards each upstream `bound`/`state` at once and returns its `ack` to the upstream link that
  sent it when the downstream acknowledges it (the senders FIFO). A tab served by W workers may have 2W messages in
  flight (plus the relay's own 2), each worker's window bounding its own. A slow tab stalls only its origin at each
  worker; other tabs are other origins. Measured: a slow tab through the relay catches up like a direct one (a 60 s
  stall: 0.38 s, 23.7 KiB at 64 KiB/s; before the rework, 24 s and three full snapshots).
- **Upstream drop:** the relay sends `loading { hold }` downstream for every relayed hold on the dropped link, fails
  their relayed calls in flight `unavailable` (never resent), re-resolves and holds again upstream from the kept
  message (same id, same origin); the new `bound` is forwarded. Acks for messages of the dropped link still in flight
  downstream go nowhere.
- **Downstream drop:** the origin's provider side ends: its served holds are released, its relayed holds forgotten,
  and every upstream link it relayed to gets one `closed { origin }`, which releases the origin's holds and aborts its
  calls there; the origin's number is never used again; messages crossing it are dropped.
- **`gone`** from upstream is forwarded; the relayed hold is forgotten. Relays never make a `gone`.

### Recovery

- After a drop the consumer re-holds every hold of the path over the new link and receives snapshots (a `bound` on a
  bound hold replaces its replicas in one batch, another variant allowed); calls in flight fail like on a disconnect;
  calls made meanwhile park (section 7).
- A slow connection never ends an object: nothing releases a hold for falling behind (the reference count is unchanged).
- A link drop is a departure (section 19).

### Values

- **JSON plus `Uint8Array` leaves**, with a bytes schema type, defined independently of the transport. Every link
  carries the same `Message` through its codec (section 22); parts are encoded at their origin; byte segments travel
  raw, never base64. Same-host calls (no link) pass values by reference.
- Schemas are TypeBox and must describe data (no callbacks, no native types, no runtime codecs). Method arguments are
  validated at the provider for every caller against closed schemas (section 5, R7, Q12, Q15); results and state are
  never validated (section 30). Values are immutable by convention once handed over (Delta's rule): nobody mutates a
  value it got, and nothing is copied or frozen to enforce it. There is no development mode (R9): one behavior
  everywhere.

---

## 4. Principals

- The app defines its principal type `P`: JSON, every variant with a `kind`, a type alias (not an interface),
  unversioned (owner, 2026-10-22): Chord never persists principals, base code changes every host at once, links stamp
  them. Objects persist a projection with its own schema, never the principal (p2: chat's `Author { kind, id, name }`).
  p2/p3: `owner` (`access: "local" | "relay" | "device"`), `guest` (`session`, `mode`, grant revision), `server`,
  `worker` (`session`).
- **Links stamp principals.** A caller's own data never sets its principal.
- **The principal key** maps a principal to its object identity (`principalKey`, default canonical JSON; cached per
  principal object; the same function on every host). It should include connection provenance and grant revision, so
  a revoked grant's objects are distinct from a new grant's **(carried over)**.
- **Principals on holds** (slice 4a; owner, 2026-10-23): a `hold` carries `principal?` and `incarnation?`. The receiver
  uses them **only on its parent link**; everywhere else they are ignored and the link's principal and peer
  incarnation apply (a tab cannot claim to be the owner; a relay overwrites what a client sent). Calls carry neither: a
  call runs as its hold's principal and with its hold's incarnation (refines R1/Q13, which stamped calls too). What a
  host sends in those fields when it holds over a route link (towards a child that honours them):

  | The reference was made by | `principal` | `incarnation` |
  | --- | --- | --- |
  | `host.get` / `host.hold` | the host's own | this host's |
  | `ctx.get` in a handler | the handler's `ctx.principal` (the caller's) | the handler's `ctx.incarnation` |
  | `self.get` in a remote object | that object's principal | this host's |
  | `self.get` in a local object or a facet | the host's own | this host's |
  | a relayed hold | the arriving hold's principal | the arriving hold's incarnation |

  So a guest's call on the server whose handler `ctx.get`s a worker type reaches the worker as the guest and gets the
  guest's variant; two references with different principals are two remote objects.
- **Upward is a boundary:** a worker's hold of a server type goes over its parent link, and the server ignores
  principal fields from a child, so it acts as the worker, whoever the worker's handler serves. A worker that acts for
  a user towards the server passes the user as data and the server object decides.
- **The caller's incarnation** (R20, Q13): `ctx.incarnation` is the incarnation of the host where the call started
  (from the handshake, or from the hold's field on a parent link), next to `ctx.principal`, not part of the principal
  or its key, never sent as data by apps; it is this host's own for local calls (section 25 uses it as a fence).
- **Revocation** (slice 4b) is a typed app function, not field matching:

  ```ts
  type Revocation = { grant: string } | { device: string } | { session: string };
  const server = createHost<P, Revocation>({
    address: Server(), principal: { kind: "server" }, onError,
    revokedBy: (p): Revocation[] =>
      p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }]
      : p.kind === "owner" && p.access === "device" ? [{ device: p.device }]
      : [],
  });
  server.revoke({ grant: "g1" }, ctx);
  ```

  `host.revoke(r)` ends every object and closes every child link whose principal `p` has `r` in `revokedBy(p)` (compared by
  canonical JSON of each value `revokedBy` returns, computed once per principal; never the host's own principal), and propagates `r` to the children as a `revoke` message on its route links,
  honoured only on a child's parent link, where each applies its own `revokedBy` (the same app code; nothing is
  replayed to a child connected later). Holders of a revoked object get `gone` with `forbidden/revoked` (owner,
  2026-10-24: a reason of its own, so a UI can say "access revoked"); holds still waiting for `load` are ended too.
  Order: the `revoke` message goes out on the route links before the revoked child links close, so a worker's objects
  end `forbidden/revoked`, not `released` by the tab's `closed`. Revocation ends a principal's objects at
  once, whatever references or jobs remain (R11); their jobs get the abort signal and the normal `closeTimeout`.
  There is no re-stamping: a changed grant (mode `write` → `read`) is a revocation of the old one; the client
  reconnects and authenticates anew, and its references re-hold. Reconnecting never restores revoked authority. Work
  started on behalf of a revoked principal in a shared store stops when its reconciling routine runs (R10's window,
  accepted; section 25); there is no revocation hook.
- `local` objects have no principal in their identity; their handlers and references act as the host (section 5).

---

## 5. Object types

```ts
export const Notes = remote("notes", { version, hostAddress, params, variants });
export const NoteStore = local("notes.store", { version, params, members });
```

| | `remote` | `local` |
| --- | --- | --- |
| reachable from | any host, across links | its own host only |
| identity | (type, params, principal key) | (type, params) |
| principals, variants | yes | no |
| factory | `(params, principal, self)` returning `{ variant, members }` | `(params, self)` returning the members |
| arguments | validated once at the provider for every caller (compiled closed schema, R7, Q12); unknown fields rejected; passed by reference on the same host | validated the same way (Q15), never copied |
| results | not validated; passed by reference on the same host | not validated, not copied |
| members | state (JSON) and methods (JSON plus bytes) | plain-data state and methods; no `opaque`, no callbacks |
| `ctx.principal` in methods | the caller | the host's principal (none on a client); references a local object makes act as the host |

```ts
variants: {
  editor: { state: { notes: NotesSchema }, methods: { add: method(AddArgs, NoteId), remove: method(RemoveArgs) } },
  reader: { state: { notes: PublicNotesSchema } },
},
// the factory chooses one variant per object (slice 3a, C15):
host.serve(Notes, ({ session }, principal, self) =>
  principal.kind === "owner" ? { variant: "editor", members: { notes, add, remove } } : { variant: "reader", members: { notes: publicNotes } });
```

- **Names** (owner, 2026-10-27): object type names, host kind names, document (`defineState`) and job (`defineJob`)
  names use `[a-z0-9@/._~-]`, lowercase, checked at declaration (they become SQL table names in the store, joined with `:`).
- **Keyed state members** (owner, 2026-10-26; `local` contracts only): `members: { notes: keyed(NoteSchema) }`; the
  provider returns a keyed document handle; a consumer on the same host takes `ref.notes.at(key)` in its factory (a
  counted pin: the key stays loaded while the consumer lives) or `ref.notes.watch(key, ctx)`/`get(key, ctx)` anywhere;
  an absent key reads `initial()`, a retirement arrives as the `retired` flag (a derive over it carries the flag on).
  Across links, a view per entity (`NoteView { session, id }`) is held as an ordinary remote object.
- **Methods:** `method()` (no arguments, no result), `method(args)`, `method(args, result)`, `method(undefined,
  result)`. A method without arguments omits them in the API (`ref.bump(ctx)`, implemented as `bump: async (ctx) =>
  …`); `null` is their internal and wire form (owner, 2026-10-22).
- **Implementations** (owner, 2026-10-22): a state member is a JSON `Watchable` the factory returns (a document handle,
  a derive, a reference member, `constant(...)`), never a getter; a method is a function `(args, ctx)` or `(ctx)`.
  Activation checks what the factory returned (plugin code): exactly the variant's members, methods as functions,
  state members as JSON watchables (a `NativeWatchable` or anything else fails the object `broken` naming the member,
  Q14).
- **Reserved member names:** `then`, `release`, `state`, `retry` and `variant` are refused at declaration (a reference
  has them; `then` would make an awaited reference thenable).
- **Compatibility (strict, like documents; R6):** a hold carries only the consumer's contract `version` and
  fingerprint, never a description. The provider binds when both equal its current ones, or (slice 7b) when the
  version is one it accepts and the fingerprint equals the one computed from its own history (section 27). Every
  contract change, additive ones included, bumps `version`. Anything else leaves the request unbound `version`:
  `failed { waiting }` with `contract_mismatch` (slice 7a: not the consumer's fault; a publication that fits wakes it,
  §3). The fingerprint covers params, variants and members, not the host address. A consumer whose contract does not
  fit waits on its own request; the provider object and its other bindings are not affected.
- **Variants:** a member name has the same kind (state or method) in every variant that has it, and a method the same
  signature (arguments and result) in every variant; state schemas may differ per variant (redaction). Enforced at
  the type level in `remote(...)` and at declaration at runtime. A remote factory returns one variant, `{ variant,
  members }`; `ref.variant` is the discriminant (section 7). Calls are checked against the binding's variant
  (`invalid/member` outside it).
- **Params** (owner, 2026-10-21/22): a flat record of required fields, each `str()`, `int()`, `bool()` or `oneOf(...)`
  of string literals, constraints allowed (`str({ pattern })`, `int({ min: 0 })`); no defaults, optional, nested or
  unknown fields. Checked for every caller with one compiled closed-object TypeBox check (a missing or extra field
  fails `invalid/params`). The identity key is the field values in declared order, each escaped, joined with `|`.
  Params are never copied or frozen: the object keeps the caller's object, immutable by convention.
- **Arguments (R7, Q12, Q15):** always validated with the provider's schema, whoever the caller is (trusted code is
  not type-checked code: plugins are bundled without type checks), never with a schema a peer sent; object schemas are
  closed (`obj()` sets `additionalProperties: false`), so an unknown field fails `invalid/args` instead of being
  stripped; nothing is copied or mutated; arguments have no defaults (optional fields are `opt()`, handlers write
  `args.limit ?? 50`). Same-host arguments are not checked for plain data (no prototype or getter checks): callers pass
  plain data by convention. Provider schemas compile lazily at first use, cached in `WeakMap`s keyed by the schema
  owner; accepted versions' validators also on first use. Bytes are leaves (`instanceof Uint8Array`, optional length
  bound), never walked. Results and state are not validated.
- **Providers** (`bindProvider(Type, accepts)`, L1): runs `checkAccepts` once per load and reload and keeps the
  validated mappings; per call `checkArgs(provider, method, raw, boundVersion, context)` returns a tagged value,
  `{ kind: "method"; args; result? }` (current-shape arguments and, for an old-version caller, the result mapping back)
  or `{ kind: "call"; args; call }` (the provider's own replacement of a removed method, invoked by Chord, slice 7b). The
  binding is held only by the served type's registration and by calls in flight (GC-tested; no global strong cache).
- **Errors** (L1, slice 3a): `ChordError` with a code and, for some codes, a reason, a closed union that is part of the
  link protocol (adding one bumps the protocol version; a receiver rejects unknown reasons; a test pins the list):
  `invalid` (`args`, `params`, `member`, `host_address`, `reentrant`, `read_after_bulk`, `cycle`), `contract_mismatch`
  (`updating`), `forbidden` (`revoked`), `gone`, `not_ready`, `released` (`ended`, `closed`, `settled`, `version`, `discarded`; none for a holder's own release), `too_large` (`part`), `unavailable` (`locked`,
  `park_timeout`, `busy`, `storage_failed`, `undeclared`: a registry no plugin serves here, slice 8), `aborted`. A failed check names TypeBox's instance path ("unknown field", "missing", else TypeBox's
  message; keys containing `/` or `~` make the path ambiguous, documented). Plugins throw `PluginError(code, message,
  details?)` for codes of their own; anything else crosses a link as the plugin code `internal` with its message, never
  a stack or a cause; plugin errors never use Chord's codes. An error rebuilt from the wire is not copied and only its
  envelope is checked; a malformed envelope is a protocol error.
- **Methods return data,** never objects; an object is handed out as its address and the receiver does `ctx.get`.
- **No callbacks as arguments,** on either kind: behaviour goes through registries, multi-step work through jobs,
  input through flows, runtime services through core objects. Real schemas instead of `Type.Unsafe`.

---

## 6. Objects

### Lifecycle

```
(get) → activating (parked on its dependencies → own steps) → live → ending → ended
              └→ failed (backoff) → activating …
                     live → failed (a runtime failure of the owner, slice 6a: broken, by reload or retry only)
```

- **One object per identity.** The first `get` runs the factory; later gets share the object.
- **Lifetime follows from kind and params (Q-A, owner, 2026-10-21):** there is no `lifetime` option and no lazy flag.
  A `local` type with empty params lives as long as the host: started eagerly at host start, never ended by reference
  count (it may hold persisted data, P3, and contribute to registries, R21). Every other `local` type and every
  `remote` type lives while referenced (`linger` keeps it briefly after the last reference). No remote object has host
  lifetime: its identity includes the principal, and long-lived parts belong in a local shared store. Below,
  "host-lifetime object" means a `local` object with empty params. Running and finishing job runs keep their
  object alive as a count, not as references, while an attempt is live or activating ("Slice 6a small items" (12)); when
  the count reaches zero with no holders, the object ends (§15).
- **Activation** (one fresh attempt each time, bounded by `readyTimeout`, its wait for the previous instance's
  teardown included): the factory runs; singleton documents take `initial()` and, on the object's first activation,
  persisted documents load and its tables' definitions are checked and migrated (slice 6a; the deadline paused during
  eager migration work); its requests are made (`self.get`, `self.registry`, keyed pins), and the attempt is
  **parked** until every one is live and hydrated (below; the deadline paused); then its own steps run under the
  deadline: natives open one after another, followed sources attach, the returned members are checked (section 5),
  derives compute; routines start (slice 5). The object goes live when all of that succeeded. Calls wait behind its
  **gate** until then.
- **The seal fence** (owner, 2026-10-26): every attempt has a seal token (a job run invocation its own, for its state
  changes and outcome). After the seal, new work through the attempt's handles is refused at use (`self.tx`, `ctx.get`,
  a job or routine start); commits are checked when they enter the store's commit step (sealed: rejected `released`,
  nothing written) and at adopt (sealed during the SQL: durable, adopted into the object's documents, its staged job
  changes adopted into the object too: decision "Second spec review: the majority" (3)); at the seal a transaction not yet in the step is aborted and the line released, a started step
  finishes before teardown completes; cleanup (references, presence, activity counts) still runs. A pure swap is not a
  replacement.
- **Ending** (slice 1, 2): new calls are rejected; every caller of a running call gets `released` at once; the
  handler keeps running in the background under an aborted context and its `self.tx` throws `released` (a running
  method can change nothing after the end). Each call runs under a context aborted by its caller and by the object's
  end (one controller per attempt, linked until the call settles; a caller's cancellation aborts only its own call); a
  call whose caller context is already aborted is rejected before its handler runs. Then the **drain** waits for the
  handlers' own promises, bounded by `closeTimeout` (`drain_timeout` reported), natives close in reverse order,
  documents are dropped, derives detached, and references released last (closes may use them). Routines stop and jobs
  follow their rules (slice 5).
- **A live object can fail** (owner, 2026-10-26): a runtime failure of the owner (a `migrate` failing on access, a
  stored version newer than the code) seals the live attempt and makes the object `failed` (`broken`): calls reject
  with the cause, state members keep their last values, natives close, documents stay on the object; recovery by
  reload or `ref.retry()`; live dependents stay live. Its references keep following every member (its own and
  re-exposed ones) until the commits admitted before the seal adopted and published once, then take their last values
  (audit A10, 2026-10-30: one rule, as restarts), and a retry's factory waits for that.
- **Parked on its dependencies** (dependency model §3, slice 7a; supersedes R18's dependency deadline and backoff): a
  dependency is what an attempt declares and needs before it goes live: `self.get` (local or remote), `self.registry`,
  keyed pins (`at(key)` on another object's keyed member); `self.follow` is the attempt's own step, not a dependency.
  While any dependency is not live (and hydrated), the attempt is parked and its object shows:

  | Its dependencies | The object shows |
  | --- | --- |
  | any `loading`, none failed | `loading` |
  | any `failed` | `failed { waiting }`, `retryAt` undefined, error `unavailable` "waiting for X: <root cause>" (X the first failed one in declaration order, the root cause found through its message's "waiting for …: "; always these two, so a ring of waiting attempts settles after one round; within 500 characters, X's label clipped first, fix round 1) |
  | one failed with `invalid/cycle` (a dependent off the ring) or `forbidden` (an `authorize` that refused it: authority, M§3.6) | `broken` with that error: nothing heals it but `ref.retry()` or a reload |
  | one `ended` (revoked, its host closed) | `broken` with that error: the request cannot come back |

  **Nothing times out while parked:** no dependency deadline, no backoff (only `parked_long`'s diagnostic report, below); the attempt's `readyTimeout` deadline is paused
  (as eager migrations pause it) and resumes with the budget left; the identity backoff stays for the object's own
  `transient` failures only. **Wakes:** the parked attempt checks again at every change of a dependency (live,
  loading, failed, a new cause compared by value, ended, and its first outcome, below), coalesced per object after the
  batch that caused them (a change while it checks or loads pinned keys is remembered); it never re-runs its factory.
  A parked attempt keeps its documents, declarations, requests and seal token, and holds no natives. **The dependency
  check is the boundary:** once all are live (and the pinned keys loaded), the own steps run; a dependency that leaves
  `live` afterwards changes nothing (R18 after live: the object goes live; its calls through that reference meet its
  state). **Retry passes on:** `ref.retry()` (or a `retry` message) on an object parked `failed { waiting }` passes on
  to its failed dependencies (audit A5, 2026-10-30): on one host one retry's walk keeps a visited set, so a diamond
  retries a shared dependency once; across links the `retry` message carries a hop budget (`hops`, 16 from the first
  host, one less per host, dropped at 0), so a waiting ring across hosts passes it round until the budget runs out
  (starting no attempt) and a diamond across hosts may retry a shared dependency twice (harmless). A `broken` or
  `transient` one starts an attempt, a parked one passes it on, a request waiting unbound in an index is left as it is
  (an event wakes it), a refused hold over a link re-runs its start. A `retryOn` wake while parked does nothing. When
  a parked object's last reference goes, it ends at once (it is not live: no `linger`) and releases its requests.
  `broken` is only for an object's own code, cycles and authority; no failure keeps references (the R18 retry trigger
  is gone: parking replaces it).
- **Dependency cycles are rejected (Q5):** every object instance has a uuidv7 instance id, minted at its first
  attempt; an object that restarts gets a new one, so an old chain never matches (slice 4b, the first user; D4,
  owner, 2026-10-24). On one host, at
  `self.get(B)` during A's activation Chord follows the waiting edges of activating objects from B; reaching A is a
  cycle. Across hosts, a hold made during an activation carries the activation chain of instance ids in its header
  (bounded; ignored from untrusted links): the provider rejects the hold when the instance being activated is in the
  chain (slice 4b; on one host slice 1; at most 32 entries; locally created objects inherit the activating chain). A
  cycle fails the activation `broken invalid/cycle` with the cycle as cause ("A → B → A"), and every other activating
  object on it the same way; no references are kept. A dependency failing with `invalid/cycle` makes its dependent
  **broken** with the same error (owner, 2026-10-24: it would wait on a ring that never heals); dependents that are not
  on the cycle break too, and a reload or `ref.retry()` recovers them. The walk on one host follows the waiting edges
  of activating and parked attempts (exact). Checked again after a reload. Cost: O(chain) per declared reference,
  only during activation.
  **The gap: rings across hosts started at the same moment** (owner, 2026-10-29: no probe): a chain is fixed when its
  object is created, so a cycle entering an object already activating is not detected. Example: A on the server and B
  on a worker start at the same moment, A declares B and B declares A; the holds carry `[A]` and `[B]`, neither finds
  the other, and without a dependency deadline both stay parked. It is made visible: an attempt parked longer than its
  `readyTimeout`, whatever its blocker (audit A11, 2026-10-30), is reported once per parking episode as
  `parked_long { object, waitingFor, state, since }` (`waitingFor` the blocker's label, `state` `loading` or `failed`); nothing fails or retries. A cycle is a plugin bug; **the guide's four
  rules** for plugin authors and agents (host README): (1) a factory declares only what the object needs, never a type
  that needs it back; (2) back-references and occasional lookups go into methods and routines (`ctx.get`); (3) data
  flows up through state and registries, not mutual `self.get`; (4) host-lifetime objects on the server never declare
  worker types in their factory.
- **Failed:** a broken part fails the whole object: a throwing factory, document hydration or `migrate`, a failed
  open, a derive that throws on its first computation during activation. After the object is live, a throwing derive
  fails only its own member (`broken`, W1). The cause is tagged and decided by Chord from where it failed:

  ```ts
  cause: { kind: "transient"; error: ChordError }   // the object's own effect failed (an open, a follow): backoff
       | { kind: "broken"; error: ChordError }      // its own code (factory, derive, hydration, migrate), a cycle, authority
       | { kind: "waiting"; error: ChordError }     // not its fault (slice 7a): no provider, no fitting version, a
                                                    //   dependency failed; retryAt undefined, woken by an event
  ```

  Only an `open` may choose `broken` itself (`throw broken(error)`, e.g. invalid configuration). **Transient** causes
  get a **backoff per identity** (1 s doubling to 60 s; a map holding no object, so a failed object is collected after
  its last reference while its window runs; concurrent gets share one attempt; success resets). **Broken** ones are
  retried only by a trigger. Triggers (for both): `ref.retry()`, a plugin reload (slice 7b, §21) and wake signals the factory
  declares with `self.retryOn(...readables)` (slice 8; anywhere in the factory: the factory specifies, Chord installs
  the watches before natives open, so a failed open still has them). Every trigger works like `ref.retry()`: the
  backoff window is skipped, an attempt starts now, holders are told `loading`. `retryOn` sources must live independently of the
  attempt (registry values); a reference's member is a type error. A facet cannot fail
  after `load`: its setup only declares (a throwing setup leaves its plugin out of `load`, reported in `load`'s
  `failed`; decision "Per plugin at startup and reload"; owner, 2026-10-26, 2026-10-30).

### The factory principle

```ts
host.serve(NoteStore, ({ session }, self) => {
  const notes = self.state(NoteDoc);                                    // section 9
  const index = self.state(Index);
  const count = self.derive([index], ([i]) => i.ids.length);           // section 12
  const watcher = self.open(async (context) => watch(dir, { signal: context.abortSignal }), (w) => w.close());   // section 13
  self.onLive(async (ctx) => { for (;;) { await sleep(HOUR, ctx); await cleanup(ctx); } });   // section 14
  const imports = self.job(ImportJob, { run, finish });                 // section 15
  self.contribute(Http, { routes: { … } });                             // section 17
  const info = self.get(SessionInfo, {});                               // start data, section 18
  const catalog = self.get(Catalog, {});                                // section 7
  return { index, count, add: …, startImport: … };
});
```

- Synchronous and declarative: no awaits, no side effects; async work happens in activation (opens), in calls, in
  routines and jobs.
- Handles stay valid for their attempt's life (owner, 2026-10-26: documents and the line belong to the object; each
  attempt's handles carry its seal token and definition version); nothing is "read at use" or re-fetched.
- On a reload the factory runs again: in staging against a recording `self` (declarations only), then for real; pure
  objects swap in place (new methods and derives, same documents), native objects restart after their drain,
  objects of a removed type end and their holders wait (section 21).

### Pattern: shared store, per-principal views

```
NoteStore {S1}          local shared store: the stored notes, once
   ▲ self.get                 ▲
Notes {S1} as owner      Notes {S1} as read-only guest
 variant "editor"         variant "reader": derives a filtered view
```

Heavy or shared parts (a Durable watch, a prompt watcher, a sandbox, a store) live once in a `local` shared store;
per-principal `remote` views get it and expose what their principal may see. Authority is the view's; the store is
trusted and acts for the host. Views of the same variant read one value from the store (a redaction is computed once,
not per guest; section 12). Any plugin uses this pattern with the same primitives; base code is not special.

**Worker-wide native owners:** the facet cannot `self.get` a type it serves, so an owner of a per-session native (an
inbox watcher, a sandbox) is a `local` object with empty params (host lifetime) that reads its session from the core's start
data (`self.get(SessionInfo, {})`, read in its opener). Paths are derived by the plugin from generic start data (the
data directory), never provided per plugin.
Such an object cannot `self.get` a session-scoped object in its factory (the session is known only after activation):
it gets one with `ctx.get` in a routine or method (R22). A `get` with params computed after activation is added only
if a real case needs it.

**Natives that follow a relocation:** the native is a stable manager (`self.open` once); a routine on the session
location switches its internal resource (the watched directory) and bumps a generation, so late events from the old
location are dropped.

---

## 7. References

| Where | API | Released |
| --- | --- | --- |
| a factory | `self.get(Type, params)` | when the object ends |
| a call | `await ctx.get(Type, params, { readyTimeout? })` | when the handler settles |
| outside | `await host.get(Type, params, context, { readyTimeout? })` / `host.hold(Type, params, context, { readyTimeout? })` | `release()` |

- **`host.get`** (and `ctx.get`, `host.registry`) resolves with a reference once its object is live and **hydrated**
  (every state member of its variant has a value). It waits while the reference is `loading`, `failed { transient }`
  or `failed { waiting }`, up to its `readyTimeout` (default 60 s, the caller's choice), then rejects with the last
  cause; only `failed { broken }` rejects at once (owner, 2026-10-29, decision "Getters wait through `waiting`"). A
  getter that gives up releases its reference. **`host.hold`** returns a reference at once that follows its object
  until released (loading, live, failed and retried as its object is, loading again while its link is down) and never
  rejects; only invalid params throw (checked at once, also before `load`: design audit 7, 2026-10-27). A type not
  served where it goes is `loading` before the host's publication and `failed { waiting }` after it, before and after
  `load` alike (§3; slice 7a). Its `variant` is `undefined` until its first binding (slice 3b). A UI holds and shows
  `ref.state`; code that needs the object now gets it, with the patience it passes. There is no `state: false` option
  (C8) and no `optional` flag.
- **Narrowing by variant:** `ref.variant` is the discriminant (C15: no `inVariant`/`expectVariant`); `RefIn<C, V>`
  narrows to some variants (strict unions, never weakened).
- **References are the only indirection** (owner, 2026-10-29; supersedes 6a's member source per object and 7b's
  hand-over): a consumer's watches and derives over `ref.member` attach through the reference's member, which passes
  the subscription straight through to the object's own document or derive (no extra hop, no copy: the commit's value
  and ops by reference). When what the reference points at changes (a new object instance after a factory re-run:
  reload, retry, restart; a new object after its type was removed and served again; another variant), the reference
  moves its subscriptions to the new one and sends one frame, a diff from the last value (consumers' derives recompute,
  a failed one heals; a member the new variant lacks fails `invalid/member`). While it points at nothing, its members
  keep their last values (a pointer, no copy): while loading (a restart, a retry, a swap whose new instance is not live
  yet) its watches get no call (`ref.state` says `loading`); while failed (a live failure, its version refused, its type
  removed, a failed dependency) they get one `failed` call with the cause's error and stay open (decision "Failures are
  watch calls"); a reference that never had a value reads `not_ready` while loading and its failure's error while failed, and its
  watches wait for its first values. A member the new variant lacks is not a failed reference: it fails `invalid/member`
  (reads throw it, watches get one `failed` call) until a later variant brings it back. Keyed watches and pins
  re-pin on each new instance the same way (a key keeps its last value until the new instance has loaded it); a
  dependent's factory pin is still loaded before the dependent goes live. Once hydrated, a reference has last values for every state member of its bound variant, read or not: when it
  detaches it takes them at its version from the outgoing instance (through that instance's mapping for an older
  version), keeping no node of it. After a `failed` call, the next good value arrives as `[["r", value]]` even when
  unchanged; a watch opened while failed starts at the last value and gets the failure once. No source, mapping,
  document handle or pin of an instance outlives it through a reference: a detached reference keeps only plain last
  values and its failure; releasing it drops them and its bindings; stopping a keyed watch drops its pin. Derives over a failed reference member compute on its last value (a contribution built on it stays); only the
  member's own watches get the `failed` call, and `ref.state` shows the failure (owner, 2026-10-29). A re-exposed member is
  the re-exposing object's reference member, followed the same way. Over a link the same rule: the replica keeps its
  last values readable while its hold is failed. Nothing outlives its object instance and nothing is handed between
  objects.
- **References across a reload** (slice 7b §6): a reference is never ended by a code change. Its object swapped in
  place or restarted: it follows the new instance (above; a hold over a link gets a fresh `bound`, §22). Its version no longer accepted, or a member of it refused (`contract_mismatch`): it leaves the object and waits
  unbound (`failed { waiting }`) with its last values; the object and its other holders stay. Its type removed: it
  waits unbound `not_served` with its last values; a publication that serves the name again binds it to the next
  object (a new object: its in-memory documents start over from `initial()`, persisted ones load again). On a removal
  the references take their last values at the seal: a commit admitted at that moment is stored and loaded by the next
  object, but not in the last values they show while they wait (accepted: deferring it would need new state on the
  waiting path, owner, 2026-10-29) (one frame, watches and derives heal, keyed pins re-pin, parked calls flush or reject, presence lists it
  again). A reference of an older version a provider accepts reads its state members through the object instance's
  shared mapping for its version (and keyed members per key), and its calls are mapped forwards and their results
  back, or run the provider's replacement of a removed method (`checkArgs`). A reference knows its version from the
  contract token it was made with; one made by outside code keeps the token its caller passed (Chord reloads no caller
  code).
- **Members:** each state member of a reference is a watchable of the provider's member (a replica over a link);
  watches taken through a reference belong to it and end when it is released. Methods are functions (`ref.add(args,
  ctx)`, `ref.bump(ctx)`).
- **`ref.state`** is a `NativeWatchable` (slice 3b) of a tagged value; watches get each new state:

  ```ts
  | { kind: "loading" } | { kind: "live" }
  | { kind: "failed"; cause: FailureCause; retryAt: number | undefined }   // retryAt: a transient cause's backoff;
                                                                         //   undefined for broken and waiting
  | { kind: "ended"; error: ChordError }                                   // released by its holder, or its object ended
  ```

| Situation | Calls | Values |
| --- | --- | --- |
| link drop | park until reconnect | readable (`loading`) |
| object loading or restarting | park until live | readable (`loading`) |
| unbound (not served, another version) or parked on a failed dependency | reject at once with the cause | `failed { waiting }` (slice 7a) |
| object `failed` | reject at once with the cause | `failed` with cause and `retryAt` |

- A failed reference stays alive: while held, Chord retries a `transient` failure per the backoff and wakes a
  `waiting` one at the event it waits for; `ref.retry()` tries at once (a Retry button; over a link the `retry
  { hold, hops }` message, which also re-runs a refused hold's start: the host address, binding; design audit 2026-10-27;
  on a parked object it passes on to the failed dependencies, §6); success goes `loading`, then `live`. A provider
  tells a pending hold's consumer each failure (`failed`, with the rest of its backoff window for a transient one),
  each new cause of an object parked on a failed dependency, and the next attempt (`loading`).
- **Parked calls** (slice 3b): calls made while the reference is loading are queued in order, each waiting at most the
  reference's `readyTimeout` from the moment it was made (never renewed), then fail `unavailable/park_timeout`; they
  are sent in order when it goes live (a new call never overtakes them) and rejected with the cause when it fails.
  Otherwise a call ends only through its caller's signal; there is no per-call deadline.
- Calls already sent when a link drops fail `unavailable` and are not resent; calls running on an instance that ends
  fail and are not resent. **Releasing a reference rejects the calls made through it** (`released`), locally and over
  links (slice 3a). A consumer receiving `gone(h)` rejects its own pending calls on `h` (Q1).
- References survive link drops: one owner of a host's remote references holds them again on every new link of their
  path; a re-hold may bind another variant (slice 3b).
- **Consumers** handle a failed call as they handle a disconnect (error shown, user retries); Chat's own submission
  `requestId` stays an app concern.

- **Optional dependencies** are registries owned by the dependent, not optional references: ports contributes its
  forwards to `radius.forwards`; without ports the table is empty and radius works.

- **Authority checks** live in the per-principal view's methods (and in `route.authorize` before a host starts);
  there is no async activation guard. An object for an address that carries authority (`LoginFlow { id }`) may exist;
  what a caller can see and do is decided by its view.

---

## 8. `ctx`

Every handler gets a `ctx` (a `Context`): `telemetry` (the current span, section 29), `abortSignal` (the caller
cancelled or the object ended; there is no per-call deadline), `principal` (the caller as its link stamped it; on a
local object's handler the host's principal, none on a client), `incarnation` (the calling host's, section 4), and
`get(Type, params, { readyTimeout? })` (references as the caller sees them, released when the handler settles; a
`get` after that throws `released`). Later: `ctx.trace(name, attributes, fn)` gives `fn` a child `ctx` under a child
span (slice 9, cut C11 to decide); in a job's `run` also `jobId` and `state` (slice 5). Pass `ctx` to everything you wait
on. Code outside objects gets a `ctx` from `host.root` (slice 8). Durable's `Context` is the same module
(`../context`); bridging is explicit. No code versions, no request ids.

**Contexts are required** (owner, 2026-10-22): every function that takes a context requires it, as the parameter after
the required ones (context last); optional only on error-reporting paths. A getter that cannot take one (a lazy derive
read) uses its owner's.

**Call-scoped natives** (a native that lives exactly as long as one call: a temporary SSH session for a directory
listing, a file handle for a download) are opened and closed inside the method with `try/finally`; there is no
`ctx.open`:

```ts
list: async ({ path }, ctx) => {
  const session = await ssh.open(config, ctx.abortSignal);
  try { return await session.readDir(path, ctx.abortSignal); }
  finally { session.close(); }
},
```

---

## 9. Documents

### Definition and handles

```ts
const Settings = defineState("settings", {
  schema: SettingsSchema,
  version: 1,
  initial: () => ({ theme: "dark" }),
  persist: true,                                   // default: in memory
  checkpointWhen: () => true,                      // required for persisted documents; small: a base per write
});
const Draft = defineState("draft", {
  schema: DraftSchema,
  version: 2,
  migrate: (old, from) => ({ body: old.text }),    // pure
  initial: () => ({ body: "" }),
  keyed: true,                                     // many per object
  persist: true,
  checkpointWhen: (value, ops, info) => info.deltasSinceBase > 50,
});

host.serve(DraftStore, (_, self) => {               // local, empty params: may persist (P3)
  const settings = self.state(Settings);          // THE settings document
  const drafts = self.state(Draft);               // all Draft documents of this object
  return {
    settings,                                      // a singleton handle is an exposable Watchable
    get: ({ conversation }, ctx) => drafts.get(conversation, ctx),
    save: ({ conversation, body }, ctx) =>
      self.tx(async (tx) => {
        const d = await tx.draft(drafts, conversation);
        d.body = body;
        return d.body.length;
      }, ctx),
    drop: ({ conversation }, ctx) => self.tx(async (tx) => tx.retire(drafts, conversation), ctx),
  };
});
```

- **Ownership:** a document belongs to exactly one object identity, and so does its line (owner, 2026-10-26: across the
  object's attempts, retries, failures and native restarts; an attempt keeps only its natives, routines, derives and
  seal token) (persisted ones across restarts; in-memory ones for
  the object's life, across reloads and native restarts). Facets have no documents (owner, 2026-10-26: C16).
  Others see it only through exposed members. References to other objects are stored as data (addresses).
- **Singleton** (no `keyed`): loaded at activation, kept in memory while the object lives; `handle.value` is
  synchronous; the handle is an exposable `Watchable`.
- **Keyed:** addressed by a short key local to the object, loaded on demand; `await handle.get(key, ctx)` reads (creates
  nothing); `for await (const key of handle.keys(ctx))` pages keys (both take a context, owner, 2026-10-26) (indexed per owner and definition, also in memory). No
  live key list: a collection shown live is a singleton (an object holding a list or map); large collections are
  methods returning pages.
- **Values are immutable by convention** (Chord Delta's rule, as in Durable): `handle.value` and published values
  are shared, never mutated by their readers, and never copied or frozen; a draft belongs only to its transaction.

### Writes and transactions

- **Only `tx.draft`** (as Durable's `tx.doc`): `await tx.draft(handle, key?)` inside `self.tx(fn, ctx)`
  returns a draft of the current document, or a draft over `initial()` if it is absent. Reading is drafting (Delta's
  overlay: no copy). An unchanged draft (empty ops) commits nothing, so an absent document is never stored by being
  read. `tx.retire(handle, key?)` removes a document. `keyed` makes the key mandatory at the type level. There is no
  `tx.get` for documents (tables have one, section 10).
- Drafts record ops (assignment, `push`, `Object.assign`); the same document returns the same draft within one
  transaction. **Drafts are revoked when the transaction settles (R12, as in Durable):** a transaction writes and
  returns at most plain values (an id, a count), never anything taken from a draft. To return data, read after the
  commit from the document (`handle.value`, `handle.get`), which then holds the committed revision; a later commit
  may slip in between, and the reader gets that newer value.
- **No existence check inside a transaction (R13, as in Durable):** `tx.retire` of an absent document is a no-op (it
  never creates); `tx.draft(handle, key)` creates a missing document when the draft changes;
  whether a keyed document exists is read outside the transaction (`handle.get(key, ctx)` gives `undefined` for an absent
  one). **A singleton always has a value (Q11):** `handle.value` is the written value or `initial()`, never
  `undefined`, so an exposed singleton is typed `T`; singleton existence has no API (unlike Durable's `snapshot()`).

  Patterns:

  ```ts
  // Return data: write in the transaction, read after the commit.
  await self.tx(async (tx) => { (await tx.draft(notes)).items.push(note); }, ctx);
  return notes.value.items;                       // the committed revision (or a newer one)

  // Remove if present: retire is a no-op for an absent document.
  await self.tx((tx) => tx.retire(drafts, conversation), ctx);

  // Create if missing: the draft creates it (only if it changes).
  await self.tx(async (tx) => {
    (await tx.draft(drafts, conversation)).text = text;
  }, ctx);

  // Branch on existence (keyed documents): read first, outside the transaction.
  if ((await drafts.get(conversation, ctx)) === undefined) { … }
  ```
- Document roots are `JsonObject` (as in Durable; lists live in a field); documents hold JSON only (bytes are a value
  and wire type). A singleton that does not exist yet reads `initial()` through its handle; retiring resets it to
  `initial()`. Handles may be used only in transactions of their own object.
- **Commit sequence** (Durable's): wait for the object's line (per object, never across objects; reads outside a
  transaction do not take it exclusively); run the callback; an error or an abort before the storage write discards
  everything; prepare every draft (Delta copies and checks only the placed values); write persisted documents in one
  storage batch through the store's commit step, `await store.commit(writes, adopt, ctx)` without the caller's abort
  signal (deltas, or a base when `checkpointWhen` says so; the line held until the step returned, as Durable's
  `#runCommit`, owner, 2026-10-26); adopt by pointer swap and mark dependents in the step, persisted and in-memory
  documents and staged changes in one `host.batch.commit` (errors as Durable's Storage, owner, 2026-10-27: a step that
  fails before `COMMIT` rolls back and rejects that commit only, nothing adopted, the store goes on; plugin mistakes are
  refused when a write is staged; a seal-fenced commit is rejected `released` before `BEGIN`); then the owner's synchronous flush recomputes dirty derives, sends one message
  per link and queues watch callbacks (W1); drafts then throw if touched. In-memory-only commits take no store seq and never
  enter the commit queue (W12). No
  revalidation of the whole document, no copy, no freeze.
- **Nothing leaves a transaction before it commits (S2):** ids and data reach other owners only after the commit;
  reference what is committed (a reference to a later commit dangles on every replica that stops in between).
- **Durable's rule:** inside the callback only `await tx.*`: no other objects, models, processes or network, no second
  `self.tx`, no reads past `tx` (otherwise a hang, not an error). Fetch first; decide and write inside.
- A transaction covers only its own object's documents and tables: one line, no transactions across owners (facet
  documents were removed, owner, 2026-10-26; shared plugin state is a `local` store object's, reached by methods).
- **Shorthands:** `handle.change(fn, ctx)` (keyed: `handle.change(key, fn, ctx)`) (one document, loaded before the synchronous `fn`),
  `handle.retire(ctx)` (keyed: `handle.retire(key, ctx)`); several steps atomically: `self.tx`.

### Versions

- A shape or meaning change raises `version` with a pure `migrate(old, from)`. A document migrates on access by the
  new definition (in memory too); the migrated base is persisted with the next commit.
- **Schema fingerprints instead of value validation:** `defineState` computes the fingerprint of its structural schema
  once (descriptions and titles ignored) and keeps it on the token; every document record stores the fingerprint it was
  written with (at creation, and with the new base after a `migrate`). On access Chord compares the token's fingerprint
  with the record's: the same version with a different fingerprint fails the object `broken` ("schema changed without
  a version bump"). Always on, O(1). Every structural schema change needs a version bump (an additive change gets a
  trivial `migrate`). Values are not walked against the schema in production, with two exceptions (R8):
  - the result of `migrate` is validated against the new schema once, when it is produced (per document per version
    change, off the commit path); a failure refuses the access, keeps the old data and fails the object (slice 6);
  - `initial()` is checked once per definition, at its first value (D3, owner, 2026-10-24: `initial()` takes no input,
    so a wrong shape is wrong at its first call; checking every call would cost one validation per created document
    and catch nothing more). A failing singleton `initial()` fails its object's activation (`broken`); a failing
    keyed one fails only the transaction that drafts the absent document, naming the definition (slice 1).
- Old code whose definition is older than the document throws on access. Without `migrate` the access is refused and
  the data kept. A changed meaning without a bump cannot be detected.
- Singleton documents migrate during activation and after reload (hydration counts as access). A hydration or
  migration failure keeps stored data and fails the whole owning object, not only the exposed member. Keyed
  documents migrate on their next access; a migration failure there also fails their owner. A migrated base is written
  back by the next commit that changes the document (owner, 2026-10-27); until then a load migrates again (once per
  object, since documents stay on the object).

### Lifetime, persistence

- **No tags (owner, 2026-10-21):** deleting a session deletes its store and directory; instance data on the server that
  refers to a session is a table with a `session` column, cleaned up by its owner (`deleteWhere`, reconciling from the
  catalog).
- **In-memory documents are instance state (P2, owner, 2026-10-21):** attached to the live object, with no storage, no
  address, no seq and never in the outbox; their commit is prepare and adopt (inside the store's commit step when the
  transaction also writes persisted data).
- **Lifetime:** in-memory documents end with their object (last reference released, linger expired, a params change on
  reload) and survive reloads and native restarts of a live object; long-lived objects creating many keyed in-memory documents retire
  them themselves. Persisted documents stay until retired.
- **Persisted data only in `local` objects with empty params (P3, owner, 2026-10-21):** persisted documents and tables
  live in `local` objects with empty params (one per host and type); their address is (object type, name, key), never a
  host instance such as the session id (W7; no host kind either since slice 6b R2: a store belongs to one host),
  so a params change never orphans data. Per-entity data is keyed documents or table rows there, with an app-chosen
  key; objects with params keep only in-memory state and read persisted data by key. Renaming a persisted store's type or
  definition, or changing how keys are formed, is an explicit one-off migration in the store.
  Why not elsewhere: a `remote` object's identity contains the principal key (provenance, grant revision), so its
  persisted documents would scatter across access paths and be orphaned after a reconnect; a shared storage key
  (`storeKey`) would put two objects with two lines on one document, so it does not exist; params would orphan data
  on a params change. Enforced at the type level (`self.state(…, persist)` and `self.table` only in factories of
  `local` types with empty params) and as a declaration error at runtime ("persist needs a stable identity: put the
  documents into a local shared store").
- **Durable plugin state:** whatever must survive a host teardown (crash, restart, a DO eviction) is a persisted
  document; everything else is rebuilt on activation (in-memory documents, natives, derives, routines, presence,
  references re-held by clients; job runs end `lost` unless their records persist).

### Rules across owners

- **No plugin reads or writes another plugin's documents** (Chord or Durable). Data crosses plugins only through
  state and methods. Data core enforces lives in a format core owns and is handed to core through its API when the data is
  created (`createConversation` with `init`), never written into core's documents directly.
- **Invariants across owners** are enforced by the owner of the dependent data, which reconciles from the other
  owner's state with an idempotent routine. No cross-owner transactions, no "notify the other owner" calls that can
  be lost:

  ```ts
  // ports' ForwardStore: "a forward of an archived session is closed"
  const catalog = self.get(Catalog, {});
  self.on(catalog.sessions, async ({ value: sessions }, ctx) => {
    for (const f of forwards.value.list) if (sessions[f.session]?.archived) await close(f.id, ctx);   // idempotent
  });
  ```

  After a crash the routine runs again with the current value; sessions does not know ports exists.

---

## 10. Store and storage

> **Superseded (owner, 2026-10-21):** persisted data lives in one transactional store per session, designed in
> `packages/chord/docs/next/store/book.md` and decided in the log ("The store", S1-S17, W1-W14, P2-P4, "Flat columns",
> "Query runner", "Index definitions are recorded", "Blobs and derived data"). In short: backends SQLite (Node, Durable
> Objects, sqlite-wasm in the browser; tests on SQLite `:memory:`, no hand-written memory backend, owner, 2026-10-27); real tables owned by objects with empty params (P3), flat
> columns (scalars, every `str()` as plain UTF-8 `TEXT` in code point order with lone surrogates replaced and NUL refused (owner, 2026-10-26, superseding W8), `json(...)` with its own version and on-access migration), a small
> query language, writes `put`/`update`/`delete`/`updateWhere`/`deleteWhere`; one documents engine for Durable
> (`StoreStorage`) and Chord; one commit queue per store that writes, adopts and marks (S1, W1), with `Storage.commit(
> writes, adopt, context)` in Durable; an outbox of ordered operations in the same transaction (no compaction at first);
> eager migrations by scan with row `v` for eager steps only. In-memory documents are instance state with no storage
> (P2). The text below describes the per-object lines, Delta trackers and commit sequence, which stay; its storage
> interface is replaced by the store.

- **What stays from Durable's store design** (`durable/src/session/transaction.ts`, `session.ts`): one Delta tracker
  per document held by its object, prepare and adopt by pointer swap, ops per commit, lines per object, migrate on
  access, `checkpointWhen` (required for persisted documents, R14), retire, and the documents engine's invariants (create before change, no
  change after retire, one live incarnation per address, `deltasSinceBase`).
- **Where persisted documents live:** rows of the store's documents engine (S13) with address `(namespace: "chord",
  owner: "<object type>", kind: <definition>, key)` (key `""` for a singleton), never a host instance (W7); ids from the store's
  counter (S10). Chord ships no storage of its own: no `DocumentStorage` interface, no Chord SQLite or memory document
  storage and no Chord storage conformance suite (the store's conformance suite covers the engine); the frozen `next/`
  storages are not ported. The store is passed to the session's host by base code (owner, 2026-10-26):

  ```ts
  const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "session.sqlite"))), ctx);
  const worker = createHost<P>({ address: Session({ id }), principal, store, onError });   // tests: SQLite :memory:
  …
  await worker.close(ctx);
  await store.close(ctx);                  // the app owns the store; in 6b the Durable Session shares it
  ```

  `openStore` runs the store's own migrations, checks the file is UTF-8 and reads `lastSeq`, the definitions and the
  id counters once; `sqliteBackend(db)` takes any `SqliteDatabase` (Node, Durable Objects, sqlite-wasm later); the
  backend interface is internal; `importStore(backend, archive, ctx)` takes the same backends. No `openNodeStore`.
- **Loading at activation (owner, 2026-10-26):** persisted singletons load right after the factory, sequentially,
  all singletons of the object with plain reads (owner, 2026-10-27: the object holds its line, so no read transaction
  is needed), once per object, before its references are bound: find, load (base plus
  deltas), fingerprint check, `migrate` with its result validated once (R8). A storage error is `storage_failed`; a
  fingerprint mismatch, a throwing `migrate` or an invalid migration result fails the object `broken`.
- **Statements per commit (owner, 2026-10-26):** the store keeps `lastSeq` (the seq of its last commit) in memory (read at open,
  persisted with each commit, S9) and folds the documents engine's checks into the writes (unique keys, a partial
  unique index on the live address, conditional `UPDATE … WHERE id = ? AND version = ?`): a delta commit is about three
  statements (revision, the record's counted conditional `UPDATE`, `lastSeq`), plus one `INSERT` with an outbox. Durable's ids in the store (slice 6b D3): one id allocator per store
  for every id (Durable's `mintId` and Chord's document ids; it starts at 2, saturates at `Number.MAX_SAFE_INTEGER`, each
  commit persists it, outbox commits and archives carry it as `nextId`); `StoreStorage`'s `record_ids` table only checks
  an id's record type. Every table and document namespace in the store is claimed once (slice 6b "owner names and
  claims"): a table by its SQL name `"<owner>:<table>"`, documents by `(owner, namespace)`; an object claims under its
  type, `StoreStorage.open(store, owner, ctx)` under `owner` (two harnesses on one store under two names are fine).
- **Tables in a transaction (owner, 2026-10-26):** the table handle first, keys as objects with exactly the key
  columns, reads async, writes synchronous and buffered like a draft's ops (checked and staged, no I/O; written in the
  commit step or dropped on failure); no write shorthands on the handle:

  ```ts
  self.tx(async (tx) => {
    const old = await tx.get(edits, { id });                       // overlays own put/update/delete (W10 after bulk)
    const { items, next } = await tx.page(edits, q, 50, { after }); // committed rows, stable for the transaction
    tx.put(edits, row);
    tx.update(edits, { id }, { at: now });
    tx.delete(edits, { id });
    tx.updateWhere(edits, (e) => prefix(e.path, from), (e) => ({ path: replacePrefix(e.path, from, to) }));
    tx.deleteWhere(edits, (e) => lt(e.at, cutoff));
  }, ctx);
  await edits.get({ id }, ctx);                                    // outside: committed state, ctx last
  ```
- **The outbox (owner, 2026-10-26):** optional, `openStore(backend, ctx, { outbox: true })` (an omitted option keeps the
  persisted setting; switching needs an explicit `true` or `false`), persisted in the store's
  metadata (turning it on starts sync from an archive at the current `lastSeq`); a table in the store's backend,
  written in the commit step's transaction (atomic for one `INSERT`); exposed as `store.outbox.read(afterSeq, limit,
  ctx)` -> `{ seq, writes }[]` and `store.outbox.trim(throughSeq, ctx)`, no pluggable encoding; versioned by the store's
  schema migrations (its layout) and a `format` per outbox commit (the write vocabulary, the archive's `format`; older
  formats stepped forward on read, newer ones refused).
- **Writes, commits, batches, archives (owner, 2026-10-26):** a *write* (`StoreWrite`, tagged by `kind`) is one change
  of the store (`put`, `update`, `updateWhere`, `table`, `index`, `document.create`, …); a *commit* the writes of one
  seq in the outbox; a *batch* the commits `from..to` that sync uploads and a replica applies; an *archive* a manifest,
  the writes from 0 to `lastSeq` and an `end`. `lastSeq` is the seq of the store's last commit.
- **Export and import (owner, 2026-10-26):** `store.export(ctx)` yields the archive's parts, the state after its
  `lastSeq` as writes (manifest, `table`, `index`, `put`, `document.create`, `end`), holding the commit queue
  until the iteration ends or `ctx` aborts; `importStore(backend, parts, ctx)` applies them into an empty backend in
  one transaction with the replica's applier. Lossless (owner, 2026-10-26): every `put` write carries its versions (`$v`,
  each `json(...)` column's) in the outbox and in archives, a `table` write its state, a `latest` document its current
  value; the applier never infers a version. The encoding is pluggable; plain JSONL ships first. Sync is not export:
  it ships outbox batches as commits happen.
- **`json(schema, { version, migrate? })` columns (owner, 2026-10-26):** schema and version required, `migrate`
  optional and pure, on access (W11), its result checked once (R8); without it (or failing) the read is refused and
  the owner fails `broken`; each column's version and schema fingerprint are recorded in the table definition and
  compared at activation (same version, other fingerprint: `broken`, D9); a read never writes back.
- **Table versions: `evolveTable` (2026-10-27, the second spec review's majority):** a table's history is a base
  (`defineTable`) and one `evolveTable(prev, (t) => t.rename(…).add(…).rows(…).drop(…).index(…))` per version, each
  materialized and fingerprinted at declaration, as contracts' `evolve`; the store replays the recorded version's
  successors in order (DDL and `migrating`, the data step, `ready`); key columns are immutable in `set`.
- **Eager migrations and addresses (owner, 2026-10-26):** the activation attempt's `readyTimeout` deadline does not
  run while an eager migration step runs (getters still time out by their own). Store names carry no host kind (slice
  6b R2, owner, 2026-10-27): tables are `"<object type>:<table>"`, document owners `"<object type>"`.
- **Eager `rows` migrations** commit in chunks of 100 rows (owner, 2026-10-26; a fixed constant: about 1 ms of commit
  step per chunk, the total time is the same for larger chunks, and every other owner's commit waits for the step).
  Between chunks the migration yields one macrotask without `setTimeout`'s 1 ms clamp: `setImmediate` where the
  runtime has it, otherwise a `MessageChannel` message (2026-10-27, slice 6a build reviews).
- **Eviction as in Durable,** for keyed persisted documents only (persisted singletons and `at(key)` documents stay
  in memory while their object lives: `handle.value` is a synchronous read; owner, 2026-10-26): one not read, written or watched for the retention
  period (default 10 minutes) leaves memory and reloads on the next access. **Store errors (owner, 2026-10-27; supersedes in part "Store errors: Durable's rule"):** the store has Durable's
  `Storage` semantics, its owners react as Durable's Session does. A step that fails before `COMMIT` rolls back: that
  commit rejects, nothing is adopted, the store goes on. The store stops (`storage_failed`: later calls reject
  `unavailable/storage_failed`, the host closes, `onError` receives `{ kind: "storage_failed" }`, the app decides,
  section 3) only when the outcome is unknown (`COMMIT` or `ROLLBACK` failed) or `adopt` threw, and on a backend
  error of a read whose `ctx` was not aborted. A Chord object whose commit the step refused (memory and disk disagree:
  the counted conditional `UPDATE`, the live-address index) fails live (`object_failed`, `broken`); an `int` result out
  of range (`CHECK`) fails only that transaction (`invalid/args`). Durable's Session fails on any commit error
  (`GuardedStorage`), as today.

---

## 11. Kinds of state

| Kind | For | API |
| --- | --- | --- |
| document | data the object owns | `self.state`, `self.tx` |
| derive | computed values | `self.derive(sources, fn)` |
| Durable's views | the conversation view, task graph and Durable documents | `Watchable`s through Durable's watches; feed derives and state members |
| paged method | large or queryable collections | a method returning pages (chat history) |
| table | a plugin's own records with queries (owner, 2026-10-21) | `self.table`, the store's query DSL |
| plugin database | derived data only: full-text search, caches (rebuilt, never synced) | a native opened by its owner |

App state lives in Chord documents; only transcript-bound data (entries, documents that fork and rewind with a
conversation) lives in Durable.

### Watchables (owner, 2026-10-21; log "Watchable and one watch API", W1-W4)

There is no `replicatedState` in v2. Everything observable is one of two kinds, sharing one lifecycle:

```ts
interface Watchable<T extends JsonValue> {   // JSON only (no bytes); documents, derives, reference members, constant(v), Durable's views
  readonly value: T;
  watch(ctx: Context): Promise<WatchHandle<T>>;          // listener (call, ctx), call: WatchCall<T> (below)
}
interface NativeWatchable<T> {               // self.writable(initial) with set(), composed registry values
  readonly value: T;
  watch(ctx: Context): Promise<NativeWatchHandle<T>>;    // listener (call, ctx), call: NativeWatchCall<T>; a change is a new value (!==)
}
type WatchCall<T> =                          // owner, 2026-10-27: a recoverable failure is a call, the watch stays open
  | { kind: "value"; value: T; ops: Op[]; retired: boolean }
  | { kind: "failed"; error: unknown };
type NativeWatchCall<T> = { kind: "value"; value: T } | { kind: "failed"; error: unknown };
// const w = await notes.watch(ctx); send(w.value);
// w.start(async (call, ctx) => { if (call.kind === "failed") return showError(call.error); render(call.value); });
// … await w.stop();
```

- **Failures are calls, watches end only for good (owner, 2026-10-27):** a source that fails and can recover (a
  derive whose compute throws, a replica member a hold lists as failed, a member a new variant lacks, a registry whose
  `compose` throws, slice 8) gives its watches one `{ kind: "failed", error }` call and keeps them open; its next good
  value arrives as `[["r", value]]` (folded with the failure for a busy listener). A failed derive recomputes on every
  later change of its sources and on a re-bind (self-healing). A watch ends only when nothing can come back: its owner
  ended (`ended`), `stop()` or a cancelled context, a throwing listener (`listener_error`), `storage_failed`. `self.on`
  handlers are not called for failures: a routine waits for the next good value (the failure is reported where it
  happens: the derive's owner reports `derive_failed { object, member?, error }` once per failure episode, the first
  failure after a value or after creation, not for a derive failing only because a source failed). `ref.state` stays
  a separate watchable of the object's reachability (`loading | live | failed | ended`), with the same words. A
  replica member that vanished with a variant is kept and comes back with a later binding; while failed it accepts
  only `[["r", value]]`.
- **Watch handles are Durable's, moved into Chord** (Durable imports them): `watch()` atomically takes the current
  value and buffers later commits; `start(listener)` installs the one listener; commits are delivered in order, async
  listeners awaited; a listener still busy with an earlier frame gets the commits made meanwhile as one call, from
  the **pending queue** (owner, 2026-10-23): ops stay raw and are folded through a leaf index (a map from path to
  the last pending append or primitive set; a new one on that path merges into it; any structural op clears the
  map; `r` drops everything before it); past 10,000 pending ops only "replace with the current value" is kept (no
  size, text or time caps; no folding of list appends or trims; ops come only from Chord's tracker and
  `diffRevisions`, so there are no defences against hand-written ops). `PendingOps` is Chord's shared Delta code. The
  same queue holds a link hold's ops while its window is full (section 3). Natives: every value in order, past 100 pending values one call with the newest (W4). Durable's
  event stream keeps its own queue (events are not state); `stop()` is idempotent, drops pending frames, never aborts or awaits a running call; `stop()` and
  `closed` return the end, tagged by `kind` (owner, 2026-10-27): `stopped`, `aborted` (its context aborted), `ended`,
  `listener_error { error }`, `failed { error }` (a final failure; a recoverable one is a call). Durable's synchronous
  observers take the same shapes: `advance(call, ctx)`, `end(end)`.
  **Retirement (owner, 2026-10-26, option A; replaces W2a's `[["r", null]]` frame and the end `retired`):** one
  mechanism for Chord and Durable documents, singletons and keyed alike. A watch follows its document's address; a
  retirement is one last call with a `retired` flag (a Chord document: `initial()` with `[["r", initial()]]`, which a
  wire replica applies; a Durable document: the last good value, no ops); the watch goes on, and a later
  write delivers the new incarnation as `[["r", value]]`. A watch ends `ended` with its owner (the object of a Chord
  document; for Durable the task of a task document, right after its retirement call, or the Session). Listeners take
  one object before the context (owner, 2026-10-26; tagged since 2026-10-27, above): `(call, ctx)`, a `WatchCall` or
  `NativeWatchCall`.
  A retirement call carries the address's value after the retirement: `initial()` for a Chord document, the last value
  (no ops) for a Durable one, which has none while absent. Watching an absent address gives `undefined`. On the wire a
  `state` entry lists retired members like failed ones. A per-key source in a factory, `handle.at(key)`, is a singleton per key: loaded at activation, `initial()` while absent, usable as a state member, derive source and `on` source (owner, 2026-10-26). A
  stopped watch releases every reference it held (W3).
- **Only `Watchable<Json>` can be a contract state member or go on the wire**, by type and by a kind check when the
  object is served (Q14); a `NativeWatchable` never can, even holding JSON. Mutating a native value in place notifies
  nobody.
- **Publication (W1):** the commit step writes, adopts (pointer swaps, Durable's touched views dispatched by id) and
  marks (dirty derives; ops appended by reference to each touched hold's batch and each watch's queue). Right after
  the step, synchronously, the owner's flush recomputes the dirty derives someone holds or watches (dependency order),
  encodes one entry per touched hold into one `state` message per link and origin, and queues watch callbacks. A
  throwing derive fails only its member; reentrant `self.tx`/`watch`/`release`/`get`/`hold`/`load`/`close` throw
  `invalid/reentrant`; a delivery or flush that throws is reported (`delivery_failed`) and the others still run. The
  same boundary runs without a store seq for in-memory commits, `writable.set`, registry changes and inbound wire
  batches (a `bound` or `state` message is applied as one batch before listeners run). There is **one batch per host**,
  passed to its sources (no module-level singleton); a dirty derive nobody holds or watches recomputes lazily on its
  next read.
- **Consumers:** derives and the wire use the internal flush; app code uses watches; `self.on` is a watch owned by
  the object (first call with the current value, then every commit; Chord awaits a running call on reload); clients
  get ordered ops over the link, folded by the provider's pending queue when they fall behind (section 3); a re-hold
  gets a fresh snapshot.

---

## 12. Derives

`self.derive(sources, (values) => value)`: a synchronous pure function, recomputed when a source changes and
diffed into ops for the wire. Sources are `Watchable`s and `NativeWatchable`s (documents, other derives, reference
members, Durable's views, registry values); the result is always JSON (state is JSON only; bytes only in method arguments and results). A derive is marked dirty in the
commit step and recomputed in the owner's flush right after it, so its change travels in the same message as its
source (W1); a dirty derive nobody holds recomputes on its next read. A throwing derive fails only its member
(`broken`). There is no `previous` (W14): `mapShared` keeps unchanged elements identical.

- **Built on what exists:** derives sit on Chord's internal publication primitive (not today's `cell.ts` or
  `replicatedState`); the diff is
  Delta's `diffRevisions` called directly (identity short-circuit: unchanged shared subtrees cost one `===`; bytes are
  atomic leaves compared by identity; equality never by stringify).
- **Container width (R24):** structural sharing is O(change) along a path, not across a container's width: changing
  one item of a flat array copies the array's slots, and `mapShared` visits every element (one identity comparison
  each). Large collections are keyed documents or bounded windows; a benchmark of long arrays (allocations, element
  visits per change) sets the documented limit.
- **The footgun:** a derive that builds new objects for unchanged data makes every commit cost O(size of the value),
  per view, because the diff must compare contents. Unchanged parts must be the same objects as last time.
- **`mapShared(f)`** (from `@earendil-works/chord/next` state; it moves into Delta when v2 goes upstream): an identity cache per source element: `f` runs only for new or
  changed source elements, unchanged ones return their previous result object. With it a list derive costs pointer
  comparisons, not content comparisons:

  ```ts
  const strip = mapShared((n: Note) => ({ text: n.text, at: n.at }));   // a mapper over the whole array
  self.derive([notes], ([n]) => ({ list: strip(n.list) }));
  // one appended note: one new object, 2,000 identical references, diffRevisions emits one insert
  ```

- **Cookbook** (documentation with examples per case): select a field, look up by key, small aggregates (just compute;
  the value is small); filter or map a list (`mapShared`); redaction (preferably separate documents per visibility,
  otherwise `mapShared`; computed once in the shared store, not per view); joins across two sources (`mapShared` plus
  the looked-up source's revision); a window over a large list (take a section of the source elements without
  rebuilding them, cache per-element measurements by identity, keep the window's start stable so changes arrive as
  appends). Large combined views from several sources re-path the sources' ops (as Durable's `ConversationView`);
  application code never interprets ops.

---

## 13. Natives

```ts
const watcher = self.open(async (context) => watchDir(path, { signal: context.abortSignal }), (w) => w.close());
self.onLive(async (ctx) => { for await (const f of watcher.value.files(ctx.abortSignal)) await importFile(f, ctx); });
```

- `self.open(open, close, { closeTimeout? })` (slice 2): `open(context)` gets a context aborted when the attempt is
  abandoned (a timeout, a cycle, its end); `close(value, reason, context)` gets one aborted at the close timeout, after
  which a possible leak is reported (`close_timeout`) and the rest continues. It returns a handle with `.value`, not a
  proxy: reading it before its open resolved throws `not_ready`, after its close started `released`. A value that
  arrives after its attempt was abandoned is closed at once.
  Natives open during activation (the object goes live after all opens) and close in reverse order when it ends.
  The opened value never changes during that attempt: no `self.resource`, versions, `replace`, `deps` or stale
  handles. To change a live native, the object restarts. A partly failed activation closes already-open natives
  with reason `end`; a later attempt opens them all anew. `retryOn` may appear anywhere in the synchronous factory.
  Type names: `Native<T>` (the handle), `NativeCloseReason`.
- **Order:** natives open one after another in declaration order (a later opener may use an earlier handle's
  `.value`) and close in reverse. A throwing `close` does not stop the others: on `host.close()` all errors are
  collected and it rejects with them; an object ending in the background reports them to `onError`.
- Behaviour around a native goes into routines; listeners on natives outside routines are forbidden.
- The facet may not open natives.
- What an old native does after its owner restarts is its owner's `close` (a model runtime keeps working until
  collected; a closed SSH connection fails its in-flight `exec`).
- An open that fails makes the object `failed` (`transient` with backoff, or `broken` if it says so).

- **`close` gets a reason:** `reason: { kind: "reload" } | { kind: "close" } |
  { kind: "end" }` (the plugin is reloaded and the object is native / the host shuts down / the last reference ended or
  the type was removed). Chord aborts only the object's own calls and jobs; other work using the native (Durable tool
  executions on a code mode sandbox) is the owner's: `close` may drain instead of tearing down, e.g. seal the sandbox
  (no new scripts) and end it when its running scripts finish or hit their deadline.
- **Restart stays sequential (R16):** close the old native, then open the new one. Two patterns for natives whose
  resource has work in flight:
  - **Drain in the background:** `close` detaches the old resource, returns at once, and disposes of it when its work
    has finished or after `closeTimeout` (30 s at most, Q7: a longer script is aborted); Chord then opens the new one
    immediately. Code mode's sandbox does
    this; its tool entry looks up the current sandbox at `execute()`.
  - **Swap through a registry:** the resource is a registry contribution; readers always find the current one, and a
    reader that must wait for one uses a cancellable "wait until present" with the park deadline.

---

## 14. Routines

Two kinds, declared in the factory (owner, 2026-10-24; C4 decided; slice 5):

```ts
self.on(catalog.sessions, async ({ value: sessions }, ctx) => {   // reacts to a value: first the current one, then every change
  for (const f of forwards.value.list) if (sessions[f.session]?.archived) await close(f.id, ctx);   // idempotent
});
self.onLive(async (ctx) => {                                    // called once when the object goes live
  for await (const file of watcher.value.files(ctx.abortSignal)) await importFile(file, ctx);
});
self.onLive(async (ctx) => {                                    // periodic: a loop with sleep
  for (;;) { await sleep(HOUR, ctx); await dropOld(ctx); }
});
self.onLive(async (ctx) => {                                    // set up, wait for the end, clean up
  const timer = setInterval(tick, 1000);
  try { await untilAborted(ctx); } finally { clearInterval(timer); }
});
```

- **Lifecycle (both kinds):** declared in objects, never in facets (owner, 2026-10-26: everything is done through
  objects); they start when the object goes live (in the same turn)
  and stop when it ends (their `ctx` is aborted, then
  the drain waits for running calls, bounded by `closeTimeout`). Each call gets its own `ctx` (the object's principal
  for a remote type, the host's for a local one; the host's incarnation; `ctx.get` released when the call settles).
- **On reload** the old routines' `ctx` is aborted; the new routines start once all old routine calls of the object
  have finished (bounded; a stuck call is reported and the new routines start anyway): a handover per object, so
  routines need no names. Example it prevents: an old handler midway through `restart(W1)` and a new one seeing W1
  still pending and restarting it again. The bound is `closeTimeout` (owner, 2026-10-24); calls do not wait for the
  handover, only the new routines do (slice 7b). A stuck old call past the handover is reported `drain_timeout` and
  the whole old attempt is sealed then (audit A12: one seal token per attempt; its method calls had the same bound).
- **`on(source, fn)`:** any watchable (a document, a derive, a reference member, a registry value, `ref.state`). The
  first call gets the current value (`[["r", value]]`, W2b), then one call per change; calls never overlap (S8);
  changes made during a call arrive folded in the next (newest value, folded ops); a running call is not aborted by a
  change (native sources too: a busy call is followed by one call with the newest value). A throwing call is
  reported and called again with the current value after a backoff (1 s doubling to 60 s;
  a change during the backoff calls at once; success resets it). The source ending (a released reference, its object's
  end) ends the routine without a report; a retired document does not end it (the call has `retired: true`).
- **`onLive(fn)`:** called once when the object goes live. Returning ends it until the next reload or activation;
  throwing is reported and restarts it after the same backoff (reset after a run of at least a minute); an abort is
  no error.
- **Idempotent reconcilers:** a routine reconciles from the current value, writes no "in progress" flags and starts a
  job for long work. Chord keeps no state for routines across reloads or restarts; what must survive is a document of
  the object (e.g. a `lastCleanup` time, which also survives a crash).
- **Helpers:** `sleep(ms, ctx)` (rejects when `ctx` is aborted, leaves no timer or listener) and `untilAborted(ctx)`.
  Routines and handlers wait only through calls that take `ctx`; otherwise Chord cannot stop them, and the handover
  and the drain report them stuck.
- **Errors:** `onError` gets `routine_failed { object, routine, error }`, `routine` a `Position` (`{ kind: "on" |
  "onLive", position }`; natives use the same type); never uncaught.
- **Keep-alive:** routines do not count in `host.activity` (an `onLive` runs forever).
- No bare timers or callbacks that touch state outside routines, jobs or calls. Gone (C4): `every` (an `onLive` with
  `sleep`), `custom` and its `run(fn)` (an `onLive` with `try`/`finally`; callbacks that must run one at a time go
  through a small queue or the source's async iterator), names, a due time kept across reloads.

---

## 15. Jobs

Owned work a call starts that outlives the call (a shell command, a session clone, a peer send, a login's work), in
Durable's sandwich: **intent** (a transaction), **run** (any effect), **finish** (a transaction on the current code).
Decided with the owner on 2026-10-24 (decision log "Routines and jobs open points", "Jobs keep accepts", "Job crash
handling"; C3 settled this way); slice 5 builds jobs in memory, slice 6 persistence, slice 7 their reload rules.

```ts
const ShellState = defineState("chat.shell.state", {
  schema: obj({ output: str() }), version: 1, initial: () => ({ output: "" }),
});
const ShellJob = defineJob("chat.shell", {
  version: 1,
  args: obj({ command: str(), author: Author }),
  result: obj({ exit: int(), output: str() }),
  state: ShellState,                          // optional: one document per run
  concurrency: 1,                             // optional: at most one active run per object
});

host.serve(ChatStore, ({ conversation }, self) => {          // local: no principals; views filter (below)
  const entries = self.state(ChatEntries);
  const shell = self.job(ShellJob, {
    run: async ({ command }, ctx) => {
      const out = new OutputBuffer({ maxLines: 2000, retain: "tail" });
      const progress = throttle(100, () => ctx.state.change((d) => { d.output = out.snapshot().text; }, ctx));
      try {
        const r = await runProcess(command, ctx.abortSignal, (chunk) => { out.push(chunk); progress.schedule(); });
        return { exit: r.code, output: out.snapshot().text };
      } finally {
        await progress.flush();                       // the last output reaches outcome.state, also after an abort
      }
    },
    finish: async (outcome, tx) => {
      const list = (await tx.draft(entries)).list;
      list.push(outcome.kind === "done"
        ? shellEntry(outcome.args, outcome.result)
        : shellEntry(outcome.args, { interrupted: outcome.error.kind, output: outcome.state.output }));
    },                                                      // the run's state document is retired in this commit
  });
  return {
    shells: shell.running,
    runShell: async ({ command, author, requestId }, ctx) =>
      ({ id: (await shell.start({ command, author }, ctx, { key: requestId })).id }),
    abortShell: async ({ id }) => shell.abort(id),
  };
});
```

- **Definition:** `defineJob(name, { version, args, result, state?, concurrency?, accepts?, persist? })`. `args` and
  `result` are schemas; `state` is a document definition (a singleton, one document per run); `persist` arrives with
  slice 6. `self.job(Job, { run, finish? })` is declared in an object's factory (not in a facet) and returns the job
  handle: `start(args, ctx, { key? })` (a `Run { id, outcome(ctx) }` after the commit), `tx.start(job, args, { key? })`
  inside `self.tx` (a `Run` handle at once, whose `outcome` rejects if the transaction is discarded), `outcome(id, ctx)`
  (unsettled runs only), `abort(id, ctx)` (`"marked" | "terminal"`, as Durable's `abortTask`: stored, resolves once `run` settled; slice 6b) and `running`.
- **1. Intent:** one transaction on the owner's line. Arguments are checked against `args` (closed schema, like
  method arguments). Dedupe first: a run with the same `key` that is not settled is returned as it is (the run whose
  `finish` this transaction is never counts, so `finish` can start the same job again with the same key). Then the
  `concurrency` check: at the limit `start` rejects with `unavailable/busy` (a queue is the owner's, built from a
  document and a routine). Otherwise a run record `{ id: uuidv7, version, args, key }` and its state document
  (`initial()`) are written in the commit, with whatever else the transaction writes (`tx.start`: a request entry and
  the run, both or neither). `run` starts after the commit.
- **2. Run:** `run(args, ctx)` may do anything, outside transactions. `ctx` is a `Ctx` (the object's principal for a
  remote type, the host's for a local one) plus `jobId` and `state`: `ctx.state.value` (synchronous) and
  `ctx.state.change(fn, ctx)` (a transaction on the owner's line on the run's document, without the run's abort signal).
  State changes are accepted until `run` settles, also after an abort (so output written while stopping still reaches `outcome.state`), and are
  refused (`released`) afterwards, never recreating a retired document. Each change is a commit and, while someone
  watches, a message: authors throttle frequent changes themselves (Chord does not coalesce them); awaiting or
  catching each change is the author's (an unhandled rejection is the author's bug). External writes carry keys made
  from `ctx.jobId`. A `run` that throws after its signal fired ends `aborted`, otherwise `threw` (reported as
  `job_failed`).
- **3. Finish:** when `run` settles, Chord records the outcome on the run (`phase: "finishing"`), then calls the
  current code's `finish(outcome, tx)` in a transaction (Durable's rule: only `await tx.*`). In the same commit Chord
  deletes the run record and its key (Q9: dedupe covers unsettled runs only) and retires the run's state document. A
  `finish` that throws changes nothing: it is retried with backoff (1 s doubling to 60 s), each failure reported
  (`job_finish_failed`); after five consecutive failures the run is `blocked { finish_failed }`, its outcome, state
  and key kept, retried on the next reload. `finish` is optional (then the commit only cleans up).

  ```ts
  type Outcome<Args, Result, State> = { readonly id: string; readonly args: Args; readonly state: State } & (
    | { readonly kind: "done"; readonly result: Result }
    | { readonly kind: "failed"; readonly error: JobError }
  );
  type JobError =
    | { readonly kind: "threw"; readonly error: ChordError | PluginError }   // run threw (reported)
    | { readonly kind: "aborted"; readonly reason: "abort" | "reload" | "restart" }
    | { readonly kind: "restart_limit"; readonly restarts: number };       // persisted runs (slice 6b)
    // abort(id); a native restart on reload, in-memory runs (slice 7b); "restart": a persisted run abandoned after a crash (slice 6b),
    // or a run cut off by its attempt's seal while the object continues (slice 6a)
  ```
- **Abort is a request:** `abort(id)` fires `run`'s `ctx.abortSignal`; `run` decides what it returns (a result that
  already arrived stays a success); a run ignoring the signal keeps its slot. Abort of a finishing run does nothing;
  abort of a blocked run drops it (no `finish`, its record, key and state document go, reported; owner, 2026-10-24).
- **Waiting:** `run.outcome(ctx)` resolves with the outcome once `finish` committed; the caller's abort ends only its
  wait. Across a link nobody waits on a long call: UIs watch state.
- **`running`:** a JSON watchable, one entry per unsettled run, tagged by phase:
  `{ id, version, key?, args, state, phase: "running" | "finishing" } | { id, version, phase: "blocked", reason }`. A
  blocked run carries no `args` or `state` (it may be of another version than the code); views filter it as they
  filter anything. Per-principal views derive what each principal may see (§6, the shared store): a reader without
  output, a guest only their own runs.
- **Concurrency and keep-alive:** `concurrency` counts runs that are running or finishing; blocked runs do not count.
  **Runs belong to the object** (owner, 2026-10-26): records, keys, the active count, `running`, run state documents
  and pending actions are the object's, across attempts and native restarts; an attempt has the implementation and
  its running invocations; a run's state changes and outcome are fenced by the run's own invocation; `finish` runs
  on the current live attempt. **Jobs keep their object alive** (D4): running and finishing runs are a count on the object, not references (they
  never appear in `host.references`); an object whose last reference goes stays while the count is above zero, and
  ends (after its type's `linger`) when it reaches zero, dropping blocked runs with a report. `host.activity.jobs`
  counts them.
- **Object end:** revocation (R11), `host.close` and a reload that removes the type end the object at once: runs get
  the abort signal, the drain is bounded by `closeTimeout`; an in-memory run's outcome and state go with the object
  (no `finish`). Jobs in `local` stores are never revoked (no principal): a store that runs work for a principal keeps
  the grant as data and reconciles with a routine (§25).
- **Versions (`accepts`, slice 7b §8):** a job is versioned like everything else; `accepts` maps an older version's args
  forwards and its result forwards (`{ 1: { args: (old) => current, result: (old) => current } }`; a producer's
  direction, unlike a contract's). Its records keep every run's version: a new attempt's `self.job(Def, impl)` at
  another version takes the records over (the same version with another fingerprint, over args, result and state, is
  refused at declaration, as documents). A run started on an older version and still running finishes on its old
  code across a pure swap (its invocation keeps the old implementation); `finish` runs on the new code with the
  outcome's args and result mapped forwards (once per run, never per publication); `running` shows its args mapped; a
  run not invoked yet runs on the new code with its args mapped. Its state document keeps its version while the old
  code writes it and migrates through its own `migrate` once its run settled or moved to the new code (the outcome
  `finish` gets). Without an adapter, for a run of a newer version than the code (a rollback), or for a job the new
  code no longer declares, the run is `blocked { version }` (kept, not invoked) until a reload brings matching code;
  blocked runs (`finish_failed` ones too) are retried on every reload of their object's plugin; a persisted run of
  another version or fingerprint stays blocked with its record as stored until the reload that brings its version
  resumes it. A native restart aborts running in-memory runs (`aborted { reason: "reload" }`) and `finish` runs on the
  new code; persisted runs are stopped and resumed per their `resume` (6b R3, owner, 2026-10-29). A `finish` in flight
  across a reload completes on the code it started with; the next one runs on the new code. A version change aborts
  nothing and discards nothing.
- **Persistence (slice 6):** `persist: { resume: "rerun" | "abandon" }` keeps the run record and its state document
  in the owner's store (owner: a `local` object with empty params, P3). How a run resumes after a crash is required, no
  default: rerun (the current
  `run`, args mapped forwards, state migrated; only work since the last state change repeats, so it must be
  idempotent) or abandon (`finish` gets `failed { aborted, reason: "restart" }`); wording aligned with Durable
  (replay-safe, abandon on restart). A recorded outcome resumes only `finish`, never `run`; an abort request is
  persisted. A restart limit as Durable's (owner, 2026-10-27, slice 6b D6): at activation a run recorded `running` was
  cut off by a crash: `restarts + 1`, stored, then it resumes (rerun or abandon); a clean close writes its stopped runs
  back so the next activation counts nothing; a `ctx.state.change` (progress) resets the count; at five in a row the
  run ends with `failed { kind: "restart_limit", restarts }`, `finish` runs, `job_interrupted` is reported (no
  parking, as Durable since #11139). A persisted state document may defer storing a change
  (`ctx.state.change(fn, ctx, { persistence: { kind: "deferred", withinMs? } })`, Durable's shape, default 1,000 ms;
  stored before the outcome is recorded; slice 6b D8).
- **Chaining:** `finish` may `tx.start` the next job, atomically with the outcome (separate steps, branches).
- **Not jobs:** request/response work (a method), standing behaviour (a routine), input into running work (a flow,
  §20: the owner's document plus methods), multi-step durable work with sleeps, waits or ownership trees on a host
  with a harness (a Durable task). Jobs as objects (#9) are rejected: a third lifetime, two objects per run for two
  principals, a `finish` across owners.

---

## 16. The facet

```ts
import { defineFacet } from "@app/core";             // base code's defineFacet, bound to the app's P

export default defineFacet((host, self) => {         // `self` (contributions) arrives with slice 8
  self.contribute(Http, { routes: { "GET /notes/export": exportNotes } });
  host.serve(Notes, (params, principal, self) => …);
  host.serve(NoteStore, (params, self) => …);
});
```

- **Facets are typed by the app's principal (owner, 2026-10-21):** base code exports `defineFacet` already bound to its
  `P` (`export const defineFacet = bindFacet<P>()`, next to the principal union), and every facet (server, worker,
  web, TUI) imports it from there; `host.load` accepts only facets typed for the host's `P`, so a factory's `principal`
  narrows by variant. Nothing is checked at runtime: the principal a factory receives is the one the link stamped.
- A plugin's per-host setup, **declarations only** (owner, 2026-10-26): `host.serve`, `self.contribute` (slice 8),
  `host.references`; no natives, no documents (C16 accepted), no routines, no jobs. Everything a plugin does at runtime
  is done through objects: shared or persisted state and standing behaviour live in a `local` store object with empty
  params (host lifetime, its own failure domain; its dependents park while it is failed and go on when it recovers), as p2 does (its 63 facets take only
  `host`). A facet cannot fail after `load`.
- `host.serve(Type, factory, { linger? })`: `linger` (milliseconds, 0 by default; slice 3b) keeps a live object with
  params alive that long after its last reference, so a new reference within that time reuses it with its documents
  and dependencies; it never applies to objects that are not live.
- `host.serve` and contributions are valid only while the setup runs. The facet never `self.get`s a type it serves
  itself.
- Between plugins only: object types and registries. No natives across plugins except through registry entries.

---

## 17. Registries

```ts
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 2 });   // shared: identity only
host.serve(Http, {                                             // the defining plugin's facet: the one provider (slice 8 D1)
  compose: (table, { report }) => buildRouter(table, report),  // pure; always delivers a value; reports conflicts
  accepts: { 1: { contribution: (old: HttpContributionV1) => upgrade(old), value: (router) => routerV1(router) } },
});
self.contribute(Http, { routes: { … }, wraps: [ … ] });
const router = self.registry(Http);           // a declared dependency; read router.value at use (await host.registry(Http, ctx) outside objects)
```

- Each contributor (a facet or an object) contributes **at most one value per registry**; the table is an immutable,
  ordered list of `(contributor, value)`. Contributor order is sorted by plugin name (never load order): deterministic
  on every host and across reloads, and deliberately meaningless; meaningful order comes from the owner's composition
  (e.g. HTTP phases). A reload replaces a contribution as a
  whole.
- **`compose` is a runtime composition, not a staging check:** contributions can be dynamic (known only once a native
  is open, or changing at runtime; contributions may be readables), so no conflict check can be complete in staging.
  `compose(table, { report })` is pure and runs whenever the table changes (after a commit, when a contributor goes
  live or ends, when a dynamic contribution changes). It always delivers a value with its fallback built in (e.g. the
  first by plugin name wins) and reports conflicts through `report` (owner notices and telemetry events); readers get
  a plain value and never handle conflicts. If `compose` throws, the failure is reported and its
  watches get a `failed` call, while `.value` keeps the last good composition (slice 8), **but only while every
  contribution it was built from is still in the table** (dependency model decision 5, slice 7a): when one leaves (its
  contributor ended, failed or restarted), the last good value is dropped and `.value` throws until `compose`
  succeeds, so it never hands out a native whose contributor ended; only before any good composition, or after such a
  drop, do readers get the error. Work that started earlier keeps the value it read (a pinned Durable phase keeps
  its old table). Helpers: `keyedEntries(table, entriesOf, report)` (a map, the first by plugin name wins, a duplicate
  reported), `orderedEntries(table, itemsOf, orderOf?)`; both keep each item's plugin (named so beside the contracts'
  `keyed`, slice 8 build).
- **Who contributes (R21):** only facets and host-lifetime objects (`local`, empty params); their factory's `self` has `contribute`, a
  referenced object's `self` does not (a type error). Reading a registry's composed value stays open to every object.
- **A contribution is in the table exactly while its contributor is live:** a facet's while its plugin is loaded; an
  object's from `live` until it ends, fails or restarts.
- **The owner decides** conflicts, order and selection (which contributions apply where).
- **One authoritative declaration (Q8):** only the facet of the plugin that defines a registry declares it to the host
  (`compose`, version, `accepts`); other plugins' tokens only identify it by name and types (contribute and read,
  never bring their own `compose`). A reload of the defining plugin replaces the declaration atomically (`serve`
  replaces; a removed defining plugin's provider goes, its readers wait `not_served`) and the table
  recomposes. Without a declaration (the defining plugin is not loaded) the registry has no composed value: readers
  wait `failed { waiting }` (`unavailable/undeclared`), like a request for a type nobody serves; contributions wait in
  the table.
- **Versions (Q8, the owner-adapter pattern):** a contribution carries the registry version its plugin was built
  against; older ones are adapted with the defining facet's pure `accepts` when the table is built. A contribution
  without a matching version or adapter (older without adapter, or newer) is left out of the table and reported (an
  owner notice naming plugin, registry and versions); its plugin keeps working. Contributions are in-process values
  (often functions) and are not schema-checked.
- **Use sites guard contributions:** a contribution is untrusted code (third-party plugins are a goal of p3). Every
  use site catches synchronous throws and rejections when it calls an entry, reports naming the contributor (the
  composed table keeps each entry's plugin name), and continues with the other entries. Durable already does this for
  extensions (`extension_error`; a throwing tool becomes an error result); `compose` reports through `report`.
- **Slice 8's rules** (decisions "Slice 8 D1" to "Slice 8 S3", `slice-8.md`; S2's `broken` and S3's backoff superseded
  by slice 7a): the token is shared, the provider serves it (`host.serve(R, { compose, accepts })`); `self.registry(R)`
  in a factory is a declared dependency: the attempt parks until the registry has a usable value at its version
  (composed; mapped by `accepts[old].value` for an older reader), otherwise it shows `failed { waiting }` naming the
  registry (`not_served`: `unavailable/undeclared`; `version`: a reader newer than the provider or without a mapping,
  `contract_mismatch`; `compose`: a first `compose` or the mapping threw; `loading` before the publication), woken at
  every change of whether the value is usable; `host.registry` waits the same way up to its `readyTimeout`;
  contributions never fail a registry (a failed one is left out and reported); a throwing `compose` keeps the last
  good composition (above); `retryOn` retries on value calls only; `host.root(fn, context, { principal? })` seals its
  context at settle, abort and `host.close`.
- **Registries may carry natives.** An entry lives exactly as long as its contributor; consumers look up at each use
  or follow the composed value and keep nothing from an entry beyond a use.
- **Contributions that change (owner, 2026-10-19; W4):** registries are host-local, so contributions are usually
  in-process values (functions, runtimes, handles). A contribution is fixed for its contributor's life (dynamic parts
  behind handles read at use; a change means a restart or reload), a `Watchable`, or a `NativeWatchable`; Chord follows
  the latter two through the internal flush: on every change it replaces that entry (a new immutable table) and runs
  `compose` again, in the owner's flush, never inside another owner's commit step. The composed value is itself a
  `NativeWatchable`; use sites watch it or read its current value. For in-process values that change,
  `self.writable(initial)` is a `NativeWatchable` with `set` (identity compared, never ops, never a state member):

  ```ts
  const ext = self.writable(mcpExtension([]));                  // e.g. MCP: tools known only at runtime
  self.contribute(HarnessExtensions, ext);
  self.on(mcp.tools, ({ value: tools }) => ext.set(mcpExtension(tools)));
  ```

  Tools, sections, hooks, wraps and tasks reach the harness as one Durable `Extension` per plugin contributed to
  p3's core registry; `compose` builds Durable's registry snapshot (Durable applies selection and wraps, and pins a
  snapshot per task phase). Skills and other lists work the same way.
- **A contribution may be another registry's value** (it is followed: its change recomposes). A ring of registries
  reading each other is caught when one composes (audit A2): a registry read while it composes throws `invalid/cycle`,
  the contribution that read it is left out and reported `contribution_failed`, the rest of the registry works.
- **Removing a contribution:** there is no remove call (`contribute` is declarative, in the factory). An entry leaves
  the table when its contributor ends, or after a reload whose new code no longer contributes. A live contributor that
  has nothing to offer for now sets its readable to the registry's empty value (an extension without tools, empty
  routes); the table keeps exactly one entry per live contributor.
- Registries add behaviour (tools, routes, renderers, commands, input gates); they never replace an owner's checks.
  No lifecycle in entries: anything needing cleanup is a native of the contributing object.

---

## 18. Start data and platform bindings

There are no host values. Start data (session id, init, data directory) is a `local` object with empty params (host lifetime)
and constant state (`constant(value)`: a readable that never changes, R23), served by the base code's core facet from the start message:

```ts
export const SessionInfo = local("app.session-info", { version: 1, params: {}, members: { init: InitSchema } });

// base code (apps/<app>/src): the core facet, passed to load() like any facet
export const coreWorkerFacet = (init: Init) => defineFacet((host) => {   // base code's own bound defineFacet
  host.serve(SessionInfo, () => ({ init: constant(init) }));             // local, empty params: host lifetime
});

// any plugin
host.serve(NoteInbox, (_, self) => {
  const info = self.get(SessionInfo, {});
  const watcher = self.open(async (context) =>
    watchDir(join(info.init.value.dataDir, info.init.value.id, "inbox"), { signal: context.abortSignal }), (w) => w.close());
  return {};
});                                                   // NoteInbox: local, empty params → host lifetime
```

Plugins read start data through a reference, after activation (in openers, derives, routines and methods); nothing
reads it synchronously in a factory. Platform bindings the host owns (a Durable Object's `state` and `env`) are core
objects whose `self.open` returns the binding and whose `close` does nothing. A long-lived native from the host is a
host-lifetime object in a core facet (the Durable harness, section 24).

**Core vs. plugin is decided by where the code lives:** base code (`src/`, imported statically by the start code under
a fixed name such as `@app/core`, not switchable, a change restarts the host) or a plugin directory (found by listing,
loaded through loader D, named by its `package.json`, switchable, a change reloads it). Core is what the app always
needs and everything builds on (harness, catalog, access, session location); optional features are plugins (code
mode is a plugin). Both use exactly the same primitives.

---

## 19. Presence

```ts
const viewers = self.derive([host.references(Notes)], ([refs]) => refs.length);
```

`host.references(Type)` (slice 4b) is a JSON `Watchable` of the references to objects of a type on this host:
`{ params, principal?, incarnation }[]` (named `origin` until 2026-10-27). It is one rule (owner, 2026-10-24): the incarnation of the host that made
the reference as its caller sees it, so two tabs are two origins, and a guest's `ctx.get` shows the guest's tab. An
entry is added when a reference binds and removed when it ends, in that batch; a departure discovered while a batch
is sending lands in the next batch (so one commit stays one message per link). The host keeps a type's list from its
first `host.references(Type)` on (one small object per asked type; entries come and go with references). **A link drop is a departure**
(accurate and simple); smoothing (a phone switching networks) is the UI's job, e.g. a debounced viewer count. Counts
per person or origin are derived by the app from the principals and origins. There is no consumer-side linger
(a closed tab closes its link); provider-side `linger` keeps a just-closed object warm and keeps the worker alive
(section 3). Replaces the presence, viewer and login-abandon leases. "Leaving" is never derived from an unmount
(section 21).

---

## 20. Input into running work

### Flows kept by their owner

```ts
start({ provider }, ctx)          → { id }                                  // uuidv7
LoginFlow {id}: state | { kind: "running"; step?: { id, … }; notices } | { kind: "done" | "failed" | "cancelled"; notices }
answer({ id, step, value }, ctx)  → ok | "step no longer active"
cancel({ id }, ctx)
```

The UI watches the state; a late or second answer to a step that is gone is refused; a promise-based callback (pi-ai's
`prompt`) stays inside the owner (its job keeps the resolver). Imperative consumers (tests, scripts, a CLI, an agent
tool) use a generic client helper over the same state, not a second protocol:

```ts
async function* steps(flow, ctx) {
  let last = 0;
  for (;;) {
    const s = await until(flow.state, (v) => v.kind !== "running" || (v.step && v.step.id > last), ctx);
    if (s.kind !== "running") return s.kind;
    last = s.step.id;
    yield s.step;
  }
}
for await (const step of steps(await ctx.get(LoginFlow, { id }), ctx))
  await login.answer({ id, step: step.id, value: answerFor(step) }, ctx);
```

A long-held server `step()` call is not used: a link drop fails it and the consumer cannot tell whether it missed a
step; state re-holds by itself and `last` keeps steps from being lost or repeated.

### The Questions service

Another pattern (`apps/p2/docs/questions.md`): a shared store with per-principal views (asker: `ask`; viewer: `open`,
`answer`), typed questions (`text`, `select`, `confirm`), policies over a live audience (`first`, `quorum`, `all`),
reattachment by `key`, deadlines, authorization per question, secrets redacted. Fits tool approval and a question the
agent asks everyone present. Its store must live in an object (it predates "natives only in objects").

> **Decision needed: where a flow lives.** Options: (a) a keyed document of its owner; (b) an object `LoginFlow {id}`
> living until done. (Jobs as objects were rejected, §15; a flow kept as its owner's document plus a job is the likely
> answer.)

---

## 21. Reload and rollout

### Per host

`host.reload(facets, context)` (slice 7b; decision "Slice 7b's open points, as recommended" (1)) takes the host's
**complete new plugin set** after `load`: a plugin in it and not loaded is added; one loaded with another facet value is
changed (Chord compares no code); one passed as the very same facet object is unchanged and untouched (owner,
2026-10-29: base code passes its core facet value every time); one loaded and not in it is removed. It resolves with a
report once the commit happened and every object took its fate (swaps and retries had their first dependency check;
it does not wait for objects to go live); a plugin whose new code fails keeps its old code and is listed in the
report's `failed` (per plugin, below).
Reloads run one after another per host; before `load` resolved it throws, after `close` it rejects `released/closed`;
`context` bounds it (decision 4: no install watchdog): its abort before the commit rejects `aborted` and changes
nothing, after the commit it only ends the wait: it rejects `aborted` with `details.committed`, a `CommittedReload`
`{ added, changed, removed, failed }` naming what the commit applied (the plugins component adopts it, so a later
reload never passes a committed plugin's old facet; owner, 2026-10-30).

```ts
type ReloadReport = {
  readonly plugins: { readonly added: readonly string[]; readonly changed: readonly string[]; readonly removed: readonly string[] };
  readonly failed: readonly { readonly plugin: string; readonly error: unknown }[];   // new code failed: old code kept, an added one left out
  readonly objects: readonly ({ readonly object: string } & (
    | { readonly kind: "swapped" } | { readonly kind: "restarted" } | { readonly kind: "ended" }
    | { readonly kind: "parked"; readonly cause: FailureCause } | { readonly kind: "retried" }))[];
};
```

```
1. load      new bundles (the app's or loader's: a facet arrives evaluated); a plugin whose build or evaluation
             fails keeps its loaded facet (`reload(facets, context, { failed })`)
2. staging   every new setup into a staged table, and every affected object's new factory against a recording
             `self` (declarations only, nothing activated, bound or opened); a plugin whose new code throws keeps its
             old code, staging runs again without it, then the closure rule (below)
3. commit    one batch: the host switches to the new code atomically, a publication (7a)
4. after     each object takes its fate (below)
```

- **Per plugin, never all or nothing** (owner, 2026-10-30, decision "Per plugin at startup and reload"; supersedes 7b's
  rollback per host): a plugin whose new code fails at a reload (its build or evaluation, a setup's or factory's throw
  in staging, a declaration error, `checkAccepts`, a type or registry served twice, a remote type on a host without
  principal or address) keeps its old code (its loaded facet, unchanged) and is reported in the reload's report
  (`failed: [{ plugin, error }]`, the same list `load`'s report has; an added plugin that fails is left out); staging runs again without it, and every other plugin of the reload applies. **The
  closure rule:** a changed plugin whose recorded requests would not bind because the plugin they need was kept old (or
  is missing) is kept old too, so a consumer edited together with a broken provider keeps working on its old code. At
  startup the same holds: `load` leaves a failing plugin out and resolves with `{ failed: [{ plugin, error }] }`; its
  consumers wait `failed { waiting }`; `load` never closes the host for a plugin (base code decides whether its core
  failing is fatal). A loader that kept a plugin on its loaded facet because its new code failed before staging (its
  build, its evaluation) tells the host with `reload(facets, context, { failed })`: the host lists it and applies the
  closure rule to it as to a plugin whose staging failed. What no rule detects: a consumer relying on new behaviour of a kept provider whose contract did not
  change (as in a rollout across hosts). Runtime states (registry conflicts, failed opens, migrations) stay per object
  after the commit (`onError` as always).
- **Staging** runs every new setup (each plugin into its own table, merged; an unchanged or kept plugin's loaded
  entries are reused, its setup not run again) into a staged table beside the live one (types with their factory,
  `linger` and provider, `bindProvider(contract, options.accepts)`; registry providers; facet contributions by
  plugin), then, for
  every live, activating, parked or failed object of a changed or removed plugin whose type is still served, its new
  factory with the object's params (and principal) against a recording `self`: it records what the factory opens,
  the documents, tables and jobs it declares with their versions, its contributions and requests, runs the checks an
  attempt makes without effects (declared twice; persisted data outside a stable identity; contributions outside a
  host-lifetime object; a document or job at an older version, or at its version with another schema), and hands out
  inert handles. Staging is synchronous, so no request or arriving hold meets it half done (audit A1: model §1's
  `installing` is cut).
- **The commit** (one batch): the served types become the staged ones (an unchanged plugin's entries stay as they
  are); a removed plugin's registry provider goes (its readers wait `not_served`), a reloaded one's replaces the old
  (`RegistryRecord.serve` replaces), the reloaded plugins' facet contributions are replaced by plugin (object
  contributions follow their objects), every changed registry composes once; a removed type's presence list goes.
  After the batch, each object takes its fate, host-lifetime objects of new types start (no barrier), and the
  publication wakes the requests indexed under the names the reload serves (`UnboundIndex.wake(names)`, per name),
  refused holds of those names re-run their start.
- **Fates** (decided in staging; objects of plugins not in the reload are untouched):

  | The object | Fate |
  | --- | --- |
  | its type is removed | **ended**: as an end (natives close `end`, callers of running calls rejected `released`, handlers drained, in-memory documents gone, persisted ones kept); its holders' requests are not ended: they wait unbound `not_served` (§7) |
  | failed, parked, activating or waiting for its backoff | **retried** on the new code (`ref.retry()`'s rule, whatever broke it); an activating attempt is sealed and its natives close `reload` |
  | live, neither its live attempt nor the new factory opens natives, and no table of the new factory is newer than the store's | **swapped** in place (below) |
  | live, otherwise | **restarted**: new calls park (it shows `loading`), its contributions leave, running calls drain (bounded by `closeTimeout`; a call outliving the drain is cut off by the seal fence), the attempt is sealed (in-memory job runs end `aborted { reload }`, persisted ones are stopped and resumed, R3), natives close `reload`, the new attempt activates after that teardown (documents stay; eager table migrations run as at activation) |
  | any of the above whose new code waits for a dependency | **parked** (decision 4): no overlap of old and new code; reported with the cause |

  A restarted object gets a new instance id (an old activation chain never matches it); a swapped one keeps it; a
  retried one keeps it as any retry does. Cycles are checked again for the new attempts; `parked_long` is unchanged.
- **The pure swap** (decision "The seal fence": not a replacement while its calls run): a new attempt of the same
  object (its documents, line and job records) activates at once; calls arriving meanwhile wait at
  the gate (bounded by `readyTimeout`, `unavailable/park_timeout`). The new attempt's requests are made and bound
  before the old attempt's are released (a request equal to an old one binds to the same target with no gap, M§3.9).
  Running calls finish on the old attempt with its handles valid, except R15: an old call touching a document whose
  version rose throws once (`released/version`), the document intact, the call not resent; the same for a table whose
  version rose (old table handles' version fence: old code never issues SQL for a dropped column). Once the swap
  ended (the new attempt live, parked or failed) and the old attempt's calls settled (bounded by `closeTimeout`,
  `drain_timeout`), the old attempt is sealed and its references released; its job invocations finish on their old
  code. Retiring attempts are bounded by `closeTimeout` each; a later swap never waits for them (several may retire
  at once after quick reloads), while a restart, an end and the host's close do (an end rejects their callers at
  once). The references move to the new instance's members by name (one frame from the last value; a member the new
  variant lacks fails `invalid/member`; §7); exposed derives are matched by their member names, internal ones are
  rebuilt; in-memory documents migrate through `migrate` when the new code declares a higher version; the
  contributions are replaced in one batch; `self.writable` starts at its new initial value (decision 2); `retryOn`
  sources are re-declared. **Routines hand over per object:** the old attempt's routines are aborted; the new ones
  start once the old routine calls finished, bounded by `closeTimeout` (a stuck one is reported `drain_timeout` and
  the whole old attempt is sealed then, audit A12: one seal token per attempt); calls never wait.
- **Natives are not kept across reloads by name:** natives have no line, transactions or schema, so old and new code
  would interleave unchecked. In practice a restart costs little (the Durable harness is base code, terminal PTYs live
  in their own process, model runtimes, sandboxes and the search index rebuild in milliseconds); reloading the plugin
  that owns SSH connections or the relay socket hurts.
- **No factory trial, no migrate dry run, no consumer contract check during staging:** staging records declarations;
  incompatible consumers wait at bind (`failed { waiting }`, `contract_mismatch`). The one exception is the closure
  rule above: when a plugin of the reload failed, a changed plugin's recorded requests are checked as a bind would
  check them, to keep it old.
- **Start barrier** (host start and first load; dependency model §6, decision (a), slice 7a): `load` runs the facets'
  setups (the core facet with its start data among them) and **publishes** them in one batch (types served,
  registries served and composed once, contributions in their tables); requests that waited for the publication are
  placed after that batch (holds and `host.hold` wait for the publication only, never for the barrier: two hosts
  whose objects need each other's types start without a deadlock). Then it activates the host-lifetime objects and
  resolves when each has its **first outcome**: live, failed by its own cause, or parked with no blocker that is a
  local object still without its first outcome (`local`: executing on this host, a keyed pin still loading here
  included; a wait on another host or on a failed dependency ends the first pass), or ended (`host.close` settles a
  waiting `load`). One first-outcome signal per object, separate from the readiness dependents wait for, counted once,
  never reopened by retries. So `CodeMode → Harness` waits for the harness's outcome. **What it promises:** every
  host-lifetime object here had its first try, and the contributions of those that went live are in their tables;
  **not** every tool that will arrive (a parked or slow contributor, tools found in `onLive`, MCP): what a first turn
  needs is p3's explicit admission check. Base code calls `harness.resume()` after `load` (the harness is an ordinary
  host-lifetime object that opened Durable paused during the barrier; owner, 2026-10-21, refines R17). Nothing waits
  for specific contributions: what is missing shows where it is used (section 24). Failed plugins are reported with
  their error. Reloads need no barrier.

### Rollout across hosts

- **The rollout is the app's** (decision "Slice 7b's open points" (3)): it calls `host.reload` on each host in order,
  server, then workers, then clients; Chord guarantees per host (staging, commit, a failing plugin kept on its old
  code). The plugins component's `rollout` (slice 7c) runs such steps. An install never waits for activations (a reverse-order rollout would
  deadlock).
- **Each host knows only its own install** (model §5): until its reload commits (while the app bundles, before
  `host.reload`), a hold that does not fit its running code is answered `failed { waiting, version }` and the commit
  wakes it (a blip of at most one install; staging itself is synchronous, audit A1). What a consumer on
  another host sees follows §7: kept and freshly bound while its version is accepted; `failed
  { waiting }` (`version`, `not_served`) otherwise, bound again by the install that serves it; a consumer whose own
  code moves to a new version releases its old request and makes a new one.
- **The app's loader keeps its own duties:** the desired code set, a digest over the facet bundles' content hashes (an
  unchanged server restart reinstalls nothing), serialized installs, a host that starts or reconnects installing the
  current set before anything is routed to it, a rejected own install failing its own requests with the reason.

### Loading plugins and the reload loop (slice 7c)

- **No dev/prod split** (owner, 2026-10-30): a Chord app is self-modifying (the owner or an agent edits a plugin while
  it runs), so finding, building, loading, watching and rolling out plugins is core machinery: one component,
  `chord/next/plugins` (`src/next-node/plugins/`, Node-side; the kernel stays portable and takes facets however they
  were made: static imports in tests and Durable Objects work the same). Reloads stay explicit: the watcher marks,
  never applies.
- **A plugin** is a directory with a `package.json` (its `name` is the plugin's name, npm style) and one file per facet
  kind the app names; plugins come from roots found by directory listing (no source parsing; the first root wins a
  duplicate name). Dependencies between plugins resolve by contract name at runtime; names are prefixed
  (`<plugin>.<name>`; tools `<plugin>_<name>`).
- **Loader D:** one esbuild script per facet (its own files, copied files of other plugins, its npm `dependencies`
  inlined; host packages, `chord.external` packages and Node builtins external, passed in at evaluation); evaluated with
  `vm.Script` under a stable filename per (plugin, kind, digest); no module map: old generations are reclaimed by the
  GC; V8's compilation cache turned off when the component is created. `pluginFile(path)` resolves a file of the
  calling facet's own plugin. A plugin's dependencies are installed into its directory (`installDependencies`, as
  coding-agent does: `--omit=dev --legacy-peer-deps --ignore-scripts`). esbuild is an optional peer dependency.
- **The reload loop:** a watcher marks plugins dirty from the files each facet used (a copied contract dirties every
  user) and flags changes of base code (the app restarts its hosts); a build is per plugin (a failed one keeps its old code); `rollout` runs the app's
  steps in order (server, workers, clients; decision "Slice 7b's open points" (3)). A reload control (a button, a CLI,
  an agent tool) is the app's. One base bundle per surface (host packages and the app runtime) is an app's startup
  optimization, the web's in slice 11.
- Project plugins, trust, snapshots, scopes and npm/git package installs: `apps/p2/docs/plugin-loading.md` (still the
  reference for those; not in 7c).

- **UI reload vs. leaving:** "leaving" is never derived from an unmount, only from explicit navigation or presence (a
  dropped reference); a component unmounted by a reload has not left.

> **Decision needed: project plugins.** Per-directory plugins with trust and snapshots (`plugin-loading.md`) need their
> own pass over this design.

---

## 22. Wire

Exposed documents, derives and readables are state members: a snapshot in `bound` when a hold binds, ops per commit
(a draft's recorded ops, no diff), ops from diffs for derives, ops of job state documents (slice 5), and failed
members in the entry of the message that carries them. **Commits are atomic for consumers:** locally, subscribers are
notified once after every document of the commit is adopted; remotely, one `state` message per commit per link and
origin carries an entry per touched hold, applied in one batch before listeners run (also when one Durable commit
touches several holds), so remote consumers never see a torn commit. Consumers apply ops with `applyImmutable`: no
validation, no clone of snapshots or ops.

- **The protocol version** travels in `hello`; hosts of different versions refuse each other (a web page reloads for
  a newer server). Error reasons and message kinds are part of it. Until p3 ships, changes keep `PROTOCOL_VERSION` 1
  (nothing is deployed); after that every message or reason change bumps it.
- **One typed `Message`** (owner, 2026-10-22, "Wire protocol"): a TypeBox schema `MESSAGE`, a tagged union over
  `kind`, from which the protocol types derive; every decoded message is checked against it (compiled once) unless
  the link is trusted (section 3). Kinds:

  | Kind | Direction | Fields |
  | --- | --- | --- |
  | `hello` | both, first | `protocol`, `incarnation`, `calls` (the call window N) |
  | `hold` | to provider | `origin?`, `hold`, `type`, `version`, `fingerprint`, `params` (part), `address`, `principal?`, `incarnation?`, `chain?` (activation chain, Q5), `limit?` (decoded size limit, 4b) |
  | `revoke` | parent to child (route link) | the revocation value (4b) |
  | `release` | to provider | `origin?`, `hold` |
  | `retry` | to provider | `origin?`, `hold`, `hops` (the retry's hop budget, 1-16: 16 from the first host, one less for each host it passes on from, none sent at 0; audit A5); relays forward it unchanged |
  | `call` | to provider | `origin?`, `call`, `hold`, `method` (index), `args?` (part; absent: no arguments), `segments?` |
  | `abort` | to provider | `origin?`, `call` (named `cancel` until 2026-10-27) |
  | `ack` | to provider | `origin?`; one per applied `bound`/`state` message |
  | `closed` | relay to provider | `origin`: the downstream origin ended |
  | `bound` | to consumer | `origin?`, `holds: [{ hold, variant, members: [{ member, value }], failed }]`; one batch |
  | `state` | to consumer | `origin?`, `holds: [{ hold, members: [{ member, ops }], failed, retired }]`; one batch (`retired`: members retired since the last message, slice 6a) |
  | `failed` | to consumer | `origin?`, `hold`, `cause { kind, error }` (`kind`: `transient`, `broken` or `waiting`, slice 7a), `retryIn?` (a transient cause's backoff; absent: broken, waiting); each new cause of a parked object is a message of its own |
  | `loading` | to consumer | `origin?`, `hold`: a new attempt after a failure, or a relay's upstream dropped |
  | `result` | to consumer | `origin?`, `call`, `value?` (part; absent: `null`), `segments?` |
  | `error` | to consumer | `origin?`, `call`, `error` (a ChordError's JSON or a plugin's code, message, details) |
  | `gone` | to consumer | `origin?`, `hold`, `error`: the held object ended (revocation 4b; a reload never ends a hold, it unbinds it with `failed`, slice 7b; relays never make one) |
  | `ping`, `pong` | both | the heartbeat |

  A `bound` on a hold that is bound already replaces its replicas in one batch, another variant allowed (re-holds,
  slice 7b's restarted objects and its swaps to another variant).
- **Codecs are pluggable per link** (both ends use the same): `binaryCodec` (default: a kind byte with a flag for a
  following origin varint, varints, raw incarnations and fingerprints, length-prefixed strings and parts; about 23 B
  for a streamed token) and `textCodec` (Delta-style JSON tuples without field names, a message with an origin wrapped
  as `["@", origin, tuple]`; for debugging; `describeMessage` prints any message so). Measured: a 2,000-token reply
  about 46 KiB instead of 196 KiB. No CBOR (revisit only if benchmarks show encoding as a bottleneck).
- **Parts are opaque** (slice 4a): `params`, `args`, `value`, snapshot values and ops are a `Part` (JSON text at the
  origin, its UTF-8 bytes once a binary codec received it). A part is parsed only where it is owned, right when its
  message is handled (the provider parses params and arguments, the consumer results, snapshots and ops), so a relay
  forwards it unparsed and a malformed part is still a protocol error. A message naming an unknown id is ignored
  before its parts are parsed. The text codec re-serializes parts at decode (one parse per part per hop, accepted for
  a debugging codec).
- **Names travel as indexes** into the hold's bound version (each variant's state members and methods sorted; variants
  sorted). A reload that no longer accepts that version unbinds its holds first (`failed { waiting }`, slice 7b).
- **Checks by layer:** the codec's structural decode, the `MESSAGE` envelope (skipped on trusted links), the bound
  version (ids, indexes, order), then the owners (`checkParams`, `checkArgs`, Delta's decoder).
- **Unknown ids are ignored on both sides (Q1):** they are normal races (a `result` crossing an `abort`, a `call`
  crossing `gone`, a state part crossing a `release`); the side that ended a hold or call settles its own pending work
  (a consumer receiving `gone(h)` rejects its pending calls on `h`; per-direction order guarantees nothing else for `h`
  follows). Protocol errors close the link and are reported (`protocol_error`): a message failing the schema or the
  codec, a malformed part, a reused live id, more than N running calls of one origin, a broken handshake (a first
  message that is no `hello` of the link's codec, a second `hello`, another protocol version).
- **Byte segments:** a payload (arguments, a result) whose method's schema has a `bytes()` leaf carries each
  `Uint8Array` as a raw segment referenced by `{"$bytes": i}` and read back as a view of the received message; `$bytes`
  is the one reserved key there (`invalid/args`). Never base64. State is JSON only.
- **Encoders:** each member of a hold has its own Delta encoder and decoder (path interning end to end between
  provider and consumer), restarted with every snapshot. Two holds of the same principal (two tabs) encode the same
  ops separately (O(change) each). A part is encoded once at its origin; relays never re-encode it.
- **Sending:** one `state` message per commit per link and origin while the window has a slot; otherwise the ops wait
  in the members' pending queues and leave as one message when an `ack` frees a slot (section 3).
- **Relays** read and rewrite only envelopes (section 3, "Relays").
- **Size limits per part (R2, Q2; slice 4b):** limits apply to each part (wire and decoded size), configurable per
  link, checked from the part's length before it is parsed or inflated; the decoded limit is enforced in the one
  decode function. An oversized part fails only its own hold or call (`too_large/part`); the other parts of the message
  apply; a snapshot over the limit fails its hold with no automatic re-hold. The decoded limit travels with relayed
  work: the relay checks the admitting link's wire limit itself and stamps its decoded limit on the upstream `hold`
  (honoured on the parent link only, never taken from a client; calls inherit their hold's), and the host that
  inflates enforces the smaller of its own and the stamped one while inflating, after the part's owner and id are
  known (parts for unknown ids are never inflated, Q1). A relay checks only what arrives from downstream; answers
  from upstream (the app's own workers) it forwards unchecked and unparsed, and the end that parses them checks them
  against its own link's limits (owner, 2026-10-24: each end checks what it parses; a relay check needed a re-hold
  with the same id, which old messages in flight could mistake for the new hold). So IPC carries no limit of its own.
  A reference failed `too_large/part` is never held again automatically: it leaves its path, so a reconnect does not
  hold it; only `ref.retry()` puts it back (a new hold). This lives only in the consumer's memory, as long as the
  reference. The
  WebSocket's `maxPayload` stays only the transport's hard cap (e.g. 64 MiB; code 1009 closes the connection).
  Defaults for client WebSockets: 16 MiB on the wire and 64 MiB decoded per part; none on IPC.
- **Compression at the origin** (owner, 2026-10-19; slice 4b): a JSON part above a threshold (e.g. 16 KiB) is
  compressed once by a host with a synchronous compressor when it encodes it (`createHost({ compression })`, Node's
  zlib adapter in a Node-only subpath), whatever the link (IPC included), only if it shrinks; hold params are never
  compressed; byte segments stay raw; the codec is in the part's envelope (the text codec tags every part, so no JSON
  value is reserved); relays forward it compressed; the end that owns it inflates it. Option (b) (owner, 2026-10-24):
  hosts without a compressor (browsers) send uncompressed and inflate asynchronously (`DecompressionStream`), holding
  later messages of that link in order (bounded by the window and N; acks go out after apply). **Child links refuse
  compressed parts** (protocol error): honest clients never send them, and a 65 KB part could inflate to 64 MiB on the
  server; so asynchronous inflate happens only on a host receiving from its parent or a route. Because a host cannot
  tell whether its parent sees it as a child (a tab) or over a route (a worker), call arguments sent up a parent link
  are never compressed; results and state going up are. Compressed hold params are a protocol error on every link.
  The asynchronous inflate runs one part at a time; the queue behind it is bounded by the sending peer's window and N,
  so only a misbehaving parent or route peer could grow it (accepted: those are the app's own hosts). The adapter reports "too large"
  and "corrupt" as a tagged result. Limits and the threshold count bytes. No per-link compression.
- **Trace carriers (R5; slice 9)** are an optional bounded field of `call` and `hold` (key count, string lengths);
  relays read them from the envelope.
- **Adapted bindings get diffs** (slice 7b; decision "References are the only indirection" (5)): a consumer bound
  through `accepts` attaches to the object instance's shared mapping for its version: per member one derive of the
  instance's member through `(current) => old` (a changed member), of its whole state (a removed member), or the
  member itself (unchanged), made on first use, dropped when no reference of that version is left, gone with the
  instance; one map and one diff per commit per version whatever the number of old references, each hold encoding its
  own ops, so an old tab never receives a large state whole on every commit. A new instance (a reload) has its own
  mappings; the references move to them as to any new instance (one frame, never a new mapping applied to the old
  instance's values). A version the instance does not accept gives no member: the reference waits unbound with its
  last values.
- **A `failed` on a bound hold unbinds it** (slice 7b, model §5): the consumer applies it as a start-over plus the
  failure (its calls waiting for a slot reject with it; the provider rejects its calls in flight once); the provider
  detaches the hold's sources, drops its unsent pending ops and a queued `bound`, and keeps the ack slots of `bound`
  and `state` messages already sent until their `ack` or the link's loss. A reload sends it when the object's type is
  removed (`not_served`), its version is no longer accepted (`version`), or a swap parks on a failed dependency; a
  restart or a parked swap still loading sends `loading`; both are followed by a fresh `bound` when the object is live
  again (applied as a re-binding). A swap in place keeps the hold bound and sends it a fresh `bound` once the new
  instance is live (audit A9, 2026-10-30: one rebind path; a tab's watchers may get a frame for an unchanged member).

---

## 23. Optional components

The app kit's Node components (slice 10, `slice-10.md`, decision "Slice 10's points"): `chord/next/http` and
`chord/next/workers` in `src/next-node/`; the web page host and the TUI are slice 11. Each is ordinary code on Chord's
public API; nothing in the kernel depends on them.

### HTTP (`@earendil-works/chord/next/http`)

`httpServer(host, { listen, authenticate, headers?, links? }, ctx)` listens first, holds every request and upgrade
until `load` resolved, then serves. `authenticate(request, ctx) => P | undefined` is the app's one hook (D3: who a
request is, and which credential wins, is app policy; no Chord registry of resolvers); `headers` are added to every
response, also those no route makes; `links.path` (`/chord`) upgrades to `host.accept(webSocketLink(ws), { principal,
limits })`, a socket without a principal refused. `ws` is an optional peer dependency (D7).

The registry `Http` (`"chord.http"`) is defined by the component and served by its own facet (`http.facet`, loaded
with the plugins, D1); plugins contribute `routes`, `wraps` and `sockets`. A route is `(req, ctx) =>
Promise<HttpResponse>`, run in a `host.root` scope with the request's principal (`ctx.principal`) and a signal aborted
when the client disconnects; `req` has `method`, `path`, `params`, `query`, `headers`, `origin`, `json(limit?)` and
`body(limit?)` (D4: nothing read until asked; 1 MiB by default; past the limit 413). Patterns (D8): exact segments,
`:name`, a trailing `/*`; the most specific match wins, segment by segment from the left; one pattern from two
contributions is a reported conflict, the first by plugin name wins; `HEAD` falls back to `GET`. A request uses the
router as it was when it started.

```ts
type HttpResponse = { readonly headers?: Readonly<Record<string, string>> } & (           // D5
  | { kind: "json"; value: JsonValue; status?: number } | { kind: "html"; body: string; status?: number }
  | { kind: "bytes"; mime: string; size: number; read(offset, length, ctx): Promise<Uint8Array>; download?: string; ranges?: boolean }
  | { kind: "redirect"; to: string; status?: 302 | 303 | 307 } | { kind: "error"; status: number; message?: string });
```

The component does ranges (206/416), `HEAD`, safe download headers, 64 KiB reads with backpressure stopped on
disconnect, and a 500 without the message for a throwing route; `fileResponse(path, options)` serves a file.

```ts
type Wrap = {
  name: string;
  phase: "observe" | "headers" | "transform";   // the component's phases, outermost first
  scope?: "own" | "all";                         // default "own": only this contributor's routes
  route?: string;                                // only this route; a missing route is a reported conflict
  wrap: (req, next, ctx) => Promise<HttpResponse>;
};
```

Wraps (D2) run within a phase in contributor order (no numeric priorities: plugins have no single registration
order; Fastify's lifecycle phases and encapsulation are the model). Wraps may add a security boundary on top of a
route's checks, never instead of them. `sockets` (D6): `{ "/terminal": (socket, req, ctx) => … }`, a `ws` WebSocket
after the origin check and `authenticate` (no principal: 403 before plugin code), for a plugin's own protocol; wraps do
not apply.

### Workers (`@earendil-works/chord/next/workers`)

`createWorkers({ entry, start, plugins, idleMs?, onOutput? }, ctx)` gives a route's `resolve` (a forked worker per
address, IPC, a start message with the app's start data and the worker kind's built scripts, `ready` within 60 s), a
`state` watchable per address and `stop(address)`; `workerMain(fn)` is the child's side. One live worker per address
(a kernel lock taken by the child before it opens its store). Keep-alive (D9): the child reports `host.activity` and
the app's `busy` counts; the server stops a worker idle (all zero) for `idleMs` (5 min). A failed start uses the
route's backoff (D10); `RouteHandle.retry(address)` (D10b) ends it. Workers never build (D11): the server's plugins
component builds every plugin; workers evaluate shipped scripts, and `workers.step(name)` ships a rollout's scripts to
every running worker (D12: one report per host).

### Channels

WebSocket byte channels with acknowledged windows, separate from object links, wait for a second user after the
terminals (slice 10 D6); they would be built on top of plugin sockets.

### Chunked transfers

Large byte transfers are chunked by the owning object: `begin`, `append({ upload, offset, bytes })`, `finish`,
`read({ id, offset, length })`, about 1 MiB per chunk. The awaited `append` is the backpressure; after a drop the
writer asks for the stored offset and resumes; unfinished uploads expire (the owner's routine). A helper wraps the
loop. Chord has no stream type (it would need its own rules for drops, cancellation, relays and restarts).

---

## 24. Durable integration and portability

### Durable

- Durable keeps importing today's Chord's `context`, `delta`, `json`, `output` and `sqlite`; `next/` imports the same
  modules, so `Context`, `Draft` and `JsonValue` are one type. Durable's conversation view, task graph and documents
  are `Watchable`s through Durable's watches (Durable's `WatchHandle` now lives in Chord); Durable adopts and dispatches
  them synchronously inside the storage's commit (S1, W1; with `StoreStorage` that is the store's commit step), so a derive over a Durable view travels with it. This needs Durable to publish a commit when it adopts it (owner, 2026-10-26; a pi change, upstream first; explainer `durable-observers/`): inside `adopt`, its trackers, telemetry events and internal observers (view mounts, task graph, scheduler, submissions) run, and the host `observeCommits` observers are dispatched in one microtask queued before the observers, so they run before every wait the commit resolves and every abort it queues, but after the storage's synchronous step, never inside Chord's batch; host listeners and watch listeners have no order between them (owner, 2026-10-26). Durable's public primitive for adapters is a synchronous observer, `observeConversation`, `observeTaskGraph`, `observeDoc` (its `advance(call, ctx)` gets a `WatchCall` and runs inside `adopt`: record only, no awaits, no Session calls, no throws); `watchXXX` is built on it for app code. Chord's `self.follow(attach)` (slice 6b D9) is a source over it. Otherwise a derive over two Durable views computes between their frames of one commit. With `StoreStorage`, Durable's `adopt` runs inside the host's batch; the store knows nothing of Durable (no special cases) and needs only its step and flush to stay synchronous. Durable's
  state getters (`documentState`, `viewState`, `taskGraph()`) and the `replicatedState` family are removed (W14). Only
  plain data crosses between Durable and v2 objects.
- **The harness is an object in the core facet** (base code): a `Harness` `local` object with empty params, so host lifetime (it runs for the worker's whole life,
  whether or not anyone holds it) opens Durable paused with `self.open` during the barrier and gets model
  access and execution environments from registry entries, looked up at each use:

  ```ts
  const models = self.registry(HarnessModels);              // declared dependencies (slice 8 S3): activation waits
  const envs = self.registry(HarnessEnvironments);
  const extensions = self.registry(HarnessExtensions);
  const harness = self.open(async (context) => Harness.open(await StoreStorage.open(store, Harness.name, context), {
    models: () => models.value,                              // read at use
    env: (target) => envs.value(target.cwd),
    settings: () => currentSettings(),
    registry: registryReader(extensions, context),           // Durable's RegistryReader over the composed value (slice 8)
  }, context), (h, _reason, context) => h.close(context));
  ```

  Durable's `models` and `settings` accept functions (pi `7ec1f648e`). Durable opens with scheduling paused; base code
  calls `harness.resume()` after `await host.load(...)`; the worker connects to its parent first (W6), so host-lifetime
  stores can reference server types during the barrier; requests arriving during `load` park like any call to a
  loading object (refines R17). A missing tool gives its call an error result the model sees; a missing model makes the generation
  report "model unavailable" and wait (not fail) until a model contribution appears; a task whose definition is missing
  stays blocked (`missing_task`) until the plugin is installed or the task is aborted, as Durable does.
- **Durable's views from other objects** (slice 8 §5): the harness object contributes its `Native<Harness>` to a
  registry of p3's; another object declares that registry (`self.registry`), wakes on it (`self.retryOn`) and follows
  a view through its value (`self.follow`). A Session close ends Durable's synchronous observers `failed` ("session
  closed"; decision "Slice 8 S1"; app watches still end `ended`), so the follower fails `transient` and follows the
  next Harness once its contribution arrives. `registryReader`'s listener runs inside Chord's batch: it only wakes
  Durable's scheduler (a Chord call there throws `invalid/reentrant`).
- `HarnessModels` and `HarnessEnvironments` start with one contribution each, from the models and envs plugins'
  objects that own the natives; several providers or environment kinds are their `compose`. After a models reload
  the next request uses the new runtime; a running stream finishes on the old one.
- **Chord from Durable code (Q6):** tools, hooks and sections get Durable's `ToolExecutionApi` and a `Context`, never a
  Chord `ctx`. p3's core opens the harness with a base context holding the host under a typed key
  (`withContextValue(ChordHostKey, host, …)`); every phase context inherits it. A core helper opens a call scope from
  any Durable context: `chord(async (ctx) => …, context)` = `host.root(fn, context)` (host principal; attribution as
  data; references released when `fn` settles; slice 8 D3). No wrapping of
  tools and no p3 `defineTool`. Clients are never reachable this way (they are not addressable): a tool that needs the
  user goes through an owner's state, e.g. the Questions service (`apps/p2/docs/questions.md`): the model-facing
  `ask_user` tool and any other tool call `Questions.ask`/`wait`, tabs render the open questions and `answer` them.
  Documented with this example.
- **Code mode** (a plugin) keeps owning its `pi-codemode` sandbox; its tool entry looks up the current sandbox when
  `execute()` starts, so a call pinned by a phase before a reload (e.g. waiting in an approval hook) starts on the new
  sandbox; on `reload` and `close` its `close` detaches the old sandbox, returns at once and disposes of it when its
  scripts finish or after `closeTimeout` (30 s at most, R16, Q7); after a worker stop Durable replays as today.
- **Telemetry:** `HarnessOptions.telemetry`; submissions and tasks store an optional carrier (section 29).

### Portability

Adopted in the kernel: host = identity plus incarnation; the loader is an adapter; values independent of the
transport; durable state only in persisted documents. A Durable Object deployment
(`apps/p2/docs/research/chord-on-durable-objects.md`) would map a logical host to a DO, compose plugins at build time
(Workers forbid `eval`), replace the relaying tree with edge routing and use alarms for routines.

> **Decision needed: a Durable Object profile.** Problem: a DO can lose its memory while clients stay connected
> (hibernation); routines need wake-ups (one alarm per DO); links between DOs are RPC stubs. Hot reload is not needed
> there; plugin composition is. For later.

---

## 25. Apps: ownership and porting

- **Every thing has one owner, the smallest object it belongs to;** ownership nests; rules set at creation are written
  in the creating commit (Durable `createConversation` with `init`).
- **Core owners are always present;** a plugin owner may be missing (optional dependencies are registries owned by the
  dependent, section 7). Avoid a core god object: each core owner owns only what belongs to it.
- **Revocation of work in shared stores:** a store that runs work on behalf of a principal stores the grant (or device)
  as data with the work and reconciles from the grant owner's live grants (a routine aborts jobs, withdraws questions,
  drops queued input whose grant no longer exists); no revocation hook. The window between a revocation and the
  routine's run is accepted (R10): a step started in it still runs; there is always some window.
- **Reading without starting a worker** is plain pub/sub in an ordinary plugin: a host-lifetime object of its worker facet
  records the summary locally and publishes it to the plugin's server object (a method call from a routine on the source); clients read
  the server object, which never starts a worker; it keeps the latest value per session (a document if it must
  survive a server restart) and ignores reports from an older worker incarnation. **The caller's incarnation is
  stamped by Chord (R20):** a call arriving over a link carries the calling host's incarnation from the link handshake
  (`ctx.incarnation`, next to `ctx.principal`, not part of the principal or its key, so object identities do not
  change with restarts); nobody sends it as data and it cannot be forged. On relayed calls it is the **origin** host's
  incarnation (Q13, owner, 2026-10-21): the relay takes it from the link the hold came in on and sends it in
  the upstream `hold` (a client's value is ignored, like its principal); calls inherit their hold's (section 4). Session list, status, children, unread and
  artifact lists follow this.
- **Porting guideline:** what core enforces on data lives in a format core owns, written by the plugin that creates
  the data; a plugin's private document is read only by that plugin. Example: subagents mark one-shot and
  cwd-following child conversations in a core per-conversation policy document (`readOnly`, `followsSessionCwd`);
  chat and relocation read it; `ReadOnlyConversations` and `SessionCwdFollowers` go away.
- **p3 is built next to p2,** fully isolated (`apps/p3`, own data directory), without migrating p2 data; plugins are
  derived from the functionality map (`apps/p2/docs/p3-functions/`), not ported one to one.
- **Session lifecycle:** archive retires nothing (stops the worker, ends guest access, closes forwards); a session
  delete removes the whole session (tagged documents, the worker's databases, files, the catalog entry).

---

## 26. Decisions needed

Open, decided with the slice named or a concrete case (numbers kept stable; everything else is decided and folded into
this document):

| # | Topic | Section | When |
| --- | --- | --- | --- |
| 11 | where a flow lives | 20 | when login is ported |
| 14 | project plugins | 21 | own pass over `plugin-loading.md` |
| 16 | a Durable Object profile | 24 | when a DO target becomes concrete |
| 24 | a per-type drain override: a host option or fixed (no install watchdog: `reload` takes the app's context, decision "Slice 7b's open points" (4); the routine handover uses `closeTimeout`; a failing job `finish` backs off 1-60 s and blocks after five failures, decided) | 3 | if a real case needs it |
| 28 | Astra's circuit breaker (a hard transport-buffer cap plus a stall deadline); the heartbeat is built, the cap was never decided | 3 | if a real case needs it |
| 29 | round-3 cut C11 (`ctx.trace`); C3 and C4 are decided (§14, §15) | 8 | slice 9 |

Apps (p3), from the functionality map, decided per domain when p3 is designed:

| # | Topic | Problem and options |
| --- | --- | --- |
| 17 | session files | one owner `SessionFiles {session}` on the server for uploads, sent-file snapshots and artifact versions (caps per kind, index readable without a worker, copy on clone/fork, delete with the session); proposed, sub-points: one preview limit, fork's artifact list, copying attachments into remote environments |
| 18 | session delete | per-session objects plus `SessionTag` plus a session directory, or owner hooks through a registry; search index per session or global plus a hook |
| 20 | connection pools | SSH connections to one environment exist four times: one owner with a pool, or per-use connections |
| 21 | config files with a single writer | settings, models and auth are watched by every process and written by two: one owner on the server, others follow its state |
| 22 | file formats as versioned interfaces | `envs.json`, downloads, uploads have no version: version them like documents, or keep each internal to one owner |
| 23 | the terminal host process | a detached process with its own code: part of the revision (reloaded or restarted with it) or deliberately outside |

---

## 27. Versions and adapters

| Surface | Version | On change |
| --- | --- | --- |
| object type | `version` plus contract fingerprint | every change bumps; forward evolution and `checkAccepts` (Q10); otherwise `contract_mismatch` |
| registry | `version` | `accepts` adapter on contributions |
| document | `version` plus schema fingerprint | pure `migrate`, on access; a schema change without a bump fails the object `broken` |
| job | `version` | `accepts` maps older args and results forwards (`finish`, `running`); the state document's own `migrate`; `blocked` without an adapter or for a newer version |
| native | none | the object restarts on reload |
| Durable tasks and documents | `version` | Durable's `migrate` |
| link protocol | protocol version | refused; hosts update together |
| UI components, Chord and app APIs | none yet | exposed as they are; versioned with an SDK later |

**Contract evolution in code (Q10; implemented in `packages/chord/src/next/contracts/`, see its README):**

```ts
export const NotesV1 = remote("notes", { version: 1, params, variants: {
  editor: { state: { notes: arr(NoteV1) }, methods: { add: method(NoteV1, Id) } },
} });
export const NotesV2 = evolve(NotesV1, (e) => e.state("editor", "notes", arr(NoteV2)).args("add", NoteV2));

const accepted = checkAccepts(NotesV2, {
  1: { state: { editor: { notes: (current) => current.map(toV1) } }, methods: { add: { args: (old) => toV2(old) } } },
});
```

- A history starts with a base written in full with an explicit version (`remote()` / `local()`; `local` has flat
  `members` and no variants). `evolve(prev, (e) => …)` always continues it with structured edits: `state`,
  `addState`, `removeState`, `args`, `result`, `method(name, args, result)`, `addMethod`, `removeMethod` (local: no
  variant argument), and for a local contract's keyed members `keyed`, `addKeyed`, `removeKeyed` (slice 7b; owner,
  2026-10-26: keyed members' versions are mapped per key). Every version is materialized and fingerprinted at declaration, so an old plugin's own copy of
  v1 computes the same fingerprint; no build step, no generated files, no hand-copied fingerprints.
- **A new history base** (a params change or a change of the variant set) is a new `remote()`/`local()` with an
  explicit version and no accepts for older versions: old plugins get `contract_mismatch` and must update.
- **Mappings live with the provider,** never in the contract: the pure `checkAccepts(contract, accepts)` (called by
  the objects layer) requires, at type level and again at runtime, a mapping for every member that exists in the old
  version and changed or was removed since: changed state `(currentMember) => oldMember`, removed state `(current
  variant state) => oldMember` or `"refuse"`, `args: (old) => current`, `result: (current) => old`, removed methods
  `{ call }` or `"refuse"`, changed keyed members `(current document) => old document` or `"refuse"` (mapped per key
  for an older local consumer), removed keyed members `"refuse"`; added members need nothing. No-op edits need identity mappings. Untyped JavaScript
  providers fail at declaration naming the member; unknown keys and wrong shapes are rejected.
- **The fingerprint** is a hash (`hash64`, portable, not a security boundary) of a schema-aware, data-only normal form
  (`NORMAL_FORM_VERSION`, tied to the protocol): annotations dropped only on schema nodes, `required`/`enum` sorted,
  union and intersection order kept (it is meaning: defaults), a whitelist of TypeBox keywords, executable features
  rejected; bytes are a `{ type: "bytes" }` data marker. Schemas are deep-copied into a private history (never frozen; immutable by convention).
- **Schema helpers:** `str num int bool nul lit oneOf union obj arr map opt bytes unknown` and `type Static`.
- Chord wraps state mappings as a derive and diffs per object and version (section 22); members an old consumer does not know do
  not appear.
---

## 28. Building: slices

Chord v2 is built in vertical slices; the plan, the feature map (every feature of this document assigned to the slice
that builds it) and the carry-over of deferred obligations are in `slices.md`. Slice specs (`slice-N.md`) stay as the
history of how each slice was specified; this document states the current rules. The first layered build (kernel steps
1-6) was deleted on 2026-10-22 and survives only in git history. Done in pi: `pi-telemetry` (propagation, links,
metrics, the store interface, the renderer), `chord/context` (`Context.telemetry`), pi-ai and Durable telemetry,
`chord/telemetry-sqlite` (section 29), Chord's shared `Watch`/`NativeWatch`/`PendingOps`, Delta's `appendText`.

**Rules for every slice** (owner, 2026-10-22): the code follows the root `AGENTS.md` section "Chord v2 Code Style";
one test file per source file, one `describe` per mechanism, the spec's test list case by case; cost guards through the
in-memory telemetry adapter (section 30); GC tests for every cache and binding; one or more runnable examples
(`packages/chord/test/next/examples/NN-topic.ts`); hot-path slices add a light benchmark script
(`test/next/bench/`, by hand) with results in `benchmarks.md`; `npm run check` and the slice's tests before reporting.
Caches are `WeakMap`s keyed by their owner; no module-level strong caches; no hot-path work no decision asked for. The
function doing counted work counts it through its context; call sites never count for others; plain totals without
site labels.

**Testing the core:** every slice spec contains an explicit test list, one group per mechanism with its edge cases,
tested individually and exhaustively: activation and parked dependencies (the dependency model: unbound requests, waits without timers, wakes on every
change, retry passing on, a dependency failing while live, cycles, the start barrier's first outcomes), revocation over running jobs (R11), compatibility (R6), params
and arguments for every caller (R7), migration results and old calls on migrated documents (R8, R15), flow control
(the window per origin, folding, relays forwarding and returning acks), the incarnation fence (R20), the harness start
after the barrier (R17), native restart patterns (R16), and W1's publication list (a throwing derive, a chain A→B→C
where B throws, two owners alternating with a derive over both, reentrancy, a watch started after 150 frames, stop
during a running call, a retire with a derive over it, a reload during a routine call, GC counts of retained
revisions).

---

## 29. Telemetry

Chord reports traces, events and metrics through `@earendil-works/pi-telemetry`; one adapter per host
(`createHost({ telemetry })`, NOOP by default) decides sampling, buffering, export and filtering.

- **Types:** the adapter is a `TelemetryContext` (`startSpan` plus optional readonly `metrics` and `propagation`
  capabilities); only hosts hold it, to start roots. `Context.telemetry` is always a `TelemetrySpan` (the NOOP span by
  default); every span carries its adapter's `metrics` and `propagation`, so code with a context can record metrics
  and inject carriers. `withTelemetry(span, context)`, `traceIn(options, fn, context)` (context last; pi change with S1); `value()` and keys stay.
  `Ctx` extends `Context`, so `ctx.telemetry` is the current span; app values such as the principal stay out of
  Durable's context. `ctx.trace(name, attributes, fn)` creates a child span and gives `fn` a child `ctx`.
- **Adapters trust typed inputs:** no validation of malformed caller values and no try/catch around recording; only
  carriers from another process are checked (keys present, strings), else the root. Callers never protect themselves
  against broken adapters.
- **Across links:** `call` and `hold` carry the caller's carrier as a bounded header field (section 22); the provider
  extracts it and runs the method under it; relays add a `chord.relay` span.

  ```
  chord.call Notes.add            [tab A]
  └─ chord.relay                  [server]
     └─ chord.method Notes.add    [session:S1] principal=guest
        · event chord.commit docs=2 ops=5
  ```

- **Shared work** (one activation for several getters, a worker start) is its own root span linked to its first
  trigger; each waiting span links to it. Routine runs, job runs, eviction, backoff retries and background closes are
  root spans linked to their trigger where one exists.
- **Tiers:** spans for calls, methods, relays, holds, activations, opens, closes, loads, revocations, resolves, routine
  runs and job runs; events for commits inside methods, retries and parking; metrics for state messages, WebSocket
  bytes, commit durations, in-flight calls, active holds, open links, park durations and backpressure waits. IDs are
  attributes of spans, never of metrics.
- **Nothing is measured or walked for telemetry:** only sizes the code already has. Errors carry a fixed category and
  a message truncated to 500 characters; cancelling is not an error.
- **A typed telemetry schema** ships with Chord, as pi-ai (`AI_TELEMETRY_SCHEMA`) and Durable
  (`DURABLE_TELEMETRY_SCHEMA`) have; call sites that only have a context use the generic `addEvent`.
- **Storage and reading:** `@earendil-works/chord/telemetry-sqlite` over `chord/sqlite` (Node and Cloudflare): one
  row per settled span (events and links inline), metrics aggregated per series per 10 s, a 1 s batched flush with
  retention (7 days), a bounded queue (dropped and counted). The shared read interface `TelemetryStore` (Jaeger
  style): `findTraces` (name, attributes, errors, time window, limit, cursor) returns complete traces, `getTrace`,
  `findMetrics`. Spans carry global ids and a trace id; links carry trace and span id. One renderer
  (`pi-telemetry/render`) prints links and never follows them. A web trace viewer in the playground reads the store.
- **Durable** (done): submit and phase spans, stored carriers on submissions and tasks (`TaskOptions.trace`, creation
  links), events after commit, report events; pi-ai emits `pi.ai.request`/`pi.ai.poll` from one observer in
  `lazyStream`. Persisted Chord jobs store their start carrier.

## 30. Cost model

As little compute and memory as possible while staying correct; Delta was built for this (its own primitives are
practically free: `diffRevisions` on shared subtrees 0.018 ms, `applyImmutable` per small change 0.004 ms). Measured
before/after per hop: `apps/p2/docs/p3-reviews/v2-cost-model.md`.

| Hop | Work |
| --- | --- |
| commit | Delta's `prepare` (copies and checks only placed values), adopt by pointer swap; storage writes the delta |
| reads in a transaction | the draft overlay, no copy; unchanged = no write |
| subscribers on the same host | the same value and ops by reference |
| derives | compute plus `diffRevisions`; unchanged parts stay the same objects (`mapShared`, cookbook) |
| send | one encode per touched hold member per commit at its origin (the member's Delta encoder); while the window is full, per op one path key and one map lookup (leaf index), and one encode per waiting member per freed slot |
| relay, per message | decode the envelope, swap the origin (one shallow copy), encode the envelope; parts copied once into the outgoing buffer, never parsed; per `bound`/`state` one FIFO entry; two bytes of origin per message upstream |
| relay, per hold | the address's params checked once (route admission, `authorize`) |
| receive | the compiled `MESSAGE` check on untrusted links; arguments validated once at the provider (compiled closed schema), params checked; one `ack` per `bound`/`state` message |
| heartbeat | one timestamp write per received message; one timer per host |
| apply | `applyImmutable`, structure shared |
| new hold | the value encoded once (unavoidable) |
| memory | one authoritative value per document per host; replicas and derived values share structure; one cached value per adapted member, object instance and version (while a reference of the version holds it) |

**Cost guards:** Chord reports full-value walks, deep copies, encodes, schema validations and materializations as
ordinary telemetry metrics, always on (no test mode; with the NOOP adapter they cost an empty call where such work
happens). Tests use the in-memory adapter and assert them per hop (e.g. one appended note to a 500 KB document with
10 viewers: no walks, no copies, one encode per hold part at its origin and none at relays, no validations); a `vitest bench` suite measures the hops.

---

## 31. Rejected

`replicatedState` and its source family as public API; a separate IndexedDB backend; generic JSON rows and
store-maintained index entries; last-write-per-row compaction; recording raw SQL statements or SQLite changesets;
plugins' own databases holding source data; rollback after losing the driver role; JSON-field operands in bulk
updates (until needed); a lazy-lifetime flag; a `lifetime` option; derive `previous`. Drain-based handover; version fences without transactions; object restart for state changes; Durable's Session as the
object store; volatile documents; per-group lines; generic call or request ids; optimistic transactions; an outbox for
transient delivery errors; revoking proxies on `.value`; resources replaced in place (`replace`, `deps`, stale
handles); registries created at runtime and entries resolved through mutable indirection (contributions that change
with their contributor, readable contributions and readers looking up the current value at use are fine, R25); generic
registry keys with a `conflict` flag;
`restart_required`; detached references counting toward presence; contracts taken from the running app; ceremony
(`native/` directories, `defineNative`, lints); weakening type checking; "magic" input-field matching for delete; a
factory trial; a migrate dry run; principal field patterns and re-stamping for revocation; `storeKey`; a consumer contract check during staging; reload votes; `defaultProjectTrust: "always"`; loader variants A and B; a topology layer above the host API; a stream type in
Chord; callbacks as method arguments; `opaque` members; numeric middleware priorities; host addresses as data naming an
input field; host-name strings in app code; host values (start data and platform bindings are core objects);
consumer-side linger; registry composition as a staging check; a JSONL document storage; `tx.get` for documents; validating state and documents on commits or reads (migration results are validated once, R8); copying values on same-host calls; op-rewriting projections and a
view algebra; keeping natives across reloads by name; Chord ending the process on a storage failure; an `optional`
flag on references; cross-relay reset coordination; count limits that refuse calls or holds; relays acking per hop, relay resets
(`reset { hold }`, `reset { holds }`), relay recovery and id renumbering at relays (replaced by flow control per
origin); a byte window, credit messages, snapshot admission and debt; `reset` from a consumer; a round-robin of
relayed calls at the relay; `state: false` on references (C8); `inVariant`/`expectVariant` (C15); per-call deadlines.
