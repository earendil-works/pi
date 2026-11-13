# Chord on Durable Objects

## Bottom line

**A fixed-plugin Chord app is a plausible Cloudflare target.**
Map a logical Chord host to a Durable Object (DO), not each
Chord object to a DO. A session host is then one DO containing
its local cores, per-principal views, facets and document store.

The main difficulty is not SQLite or plugin composition.
It is that a DO can lose all its JavaScript memory while its
clients remain connected. Chord currently treats a live link,
references and running work as in-memory runtime state.

Keep the Node target unchanged. Preserve boundaries for a
static loader, platform storage, event-driven links and wake-ups.
Do not implement a DO target or a new durable-job system now.

## Reading and confidence

- **[Repo]** means observed source or an authoritative v2 decision.
- **[Fact]** means a platform claim, linked to documentation.
- **[Inference]** means a suggested mapping, not a decision.
- Sketches below illustrate boundaries, not implemented v2 APIs.

Read `redesign-decisions.md`, `chord-next-walkthrough.md`,
`p3-walkthrough.md` and `plugin-loading.md` §§1–7, 14.
The decision log wins: `local` has no principals or natives;
registries use `compose`; rollback is per host; v2 lives in
`packages/chord/src`. Older walkthrough statements about
opaque members, registry keys and cluster votes are superseded.

Inspected today's Chord placement, host, link, wire and Node
manager/loader code, and Durable's Cloudflare storage adapter.
Fetched the platform documentation linked below. No deployment,
benchmark or runtime conformance test was performed.
Platform APIs and limits change; recheck them before implementation.

## 1. What runs where?

### Recommended starting shape

**[Inference]** One DO per logical host is the least disruptive map:

```text
browser / TUI
      │ WebSocket upgrade
      ▼
edge Worker: authenticate, select host, forward
      │
      ├── CatalogHost DO: shared/catalog objects
      │
      ├── SessionHost DO S1: all objects of session:S1
      └── SessionHost DO S2: all objects of session:S2
                    │
                    └── external execution service
                        (files, shell, PTY, sandbox)
```

The edge Worker is replicated and disposable. It is not the
single, stateful `server` host from the Node topology.
A CatalogHost DO can fill that role initially; a global catalog
can later need sharding. That is an application placement issue.

| Placement | Consequence |
| --- | --- |
| One DO per Chord host | Preserves local calls and own/facet transactions |
| One DO per session | Same choice when a session is a host |
| One DO per Chord object | Breaks local cores, registries and facet transactions |
| One DO per principal | Duplicates shared cores; usually the wrong boundary |

A DO class is reusable code, not a Chord object type.
One SessionHost class can serve arbitrarily many session DO IDs.
Inside S1, `NoteStore {S1}` exists once; owner and guest `Notes`
views remain separate Chord objects in that same DO.

**[Fact]** Namespace stubs address DOs by name or ID; invoking
the stub wakes the DO. Merely constructing a stub does not.
Storage belongs to that DO, not to a Worker instance.
[CF lifecycle][cf-life], [stubs][cf-stub], [storage][cf-sql].

### Edge identity

**[Repo]** Principals come from authenticated links, not call data.
Today's `Connection.#principalOf` ignores downstream claims;
only the trusted parent may forward a principal.

**[Inference]** Authenticate at the edge and overwrite any
client-supplied identity header before forwarding over the
private DO binding:

```ts
const principal = await authenticate(request);
await authorizeSession(principal, session);
const headers = new Headers(request.headers);
headers.delete("X-Chord-Principal");
headers.set("X-Chord-Principal", JSON.stringify(principal));
return env.SESSIONS.getByName(session).fetch(
  new Request(request, { headers }),
);
```

The DO accepts that stamp only on a trusted ingress path.
Possession of a namespace binding is a capability, not proof
that an arbitrary payload names an authorized user.
Internal services need explicit caller identities and grants.
The owning object still checks access to its data.

On socket acceptance, associate the principal, grant revision
and stable client/origin ID with the socket. On wake, revalidate
revocation/expiry; the browser does not pass through the edge
authenticator again for each WebSocket message.

### Client WebSockets and hibernation

**[Fact]** The edge can forward the upgrade to a DO.
For hibernation, the DO uses `WebSocketPair`,
`ctx.acceptWebSocket(server)` and class handlers
`webSocketMessage`, `webSocketClose`, `webSocketError`.
Do not also call `server.accept()` or use event listeners.
[WebSockets][cf-ws], [state API][cf-state].

```ts
const [client, server] = Object.values(new WebSocketPair());
this.ctx.acceptWebSocket(server);
server.serializeAttachment({ clientId, principalKey, grantRevision });
return new Response(null, { status: 101, webSocket: client });

// Called on an event, including after a new constructor ran.
async webSocketMessage(ws, data) {
  const identity = ws.deserializeAttachment();
  await this.runtime.ready();
  await this.runtime.receive(identity.clientId, data);
}
```

**[Fact]** Hibernation keeps the socket connected but discards
JavaScript memory. The constructor runs again before delivery.
`ctx.getWebSockets()` enumerates retained sockets.
Attachments survive hibernation, not socket loss; their current
documented serialized limit is **16,384 bytes**.
[WebSockets][cf-ws], [lifecycle][cf-life].

**[Inference]** Attachments should contain small identities,
not all holds or state. Restore subscriptions from durable
records, or add an explicit protocol resume/reset exchange.
A browser socket staying open does not restore Chord's hold IDs,
ACK window, feeds, pending calls or delta-encoder baselines.
Rebuild those before sending deltas, or send fresh snapshots.
This is runtime work, not just a different socket wrapper.

For a first target, standard non-hibernating WebSockets are
simpler but retain memory/billing and still need crash recovery.
Hibernation is a separate capability, not a correctness shortcut.

### DO-to-DO links

**[Repo]** Today there are three transports in `src/link.ts`:
`MemoryLink`, Node `IpcLink`, and `WebSocketLink`.
A `Link` is an ordered bidirectional frame channel.
There is no HTTP or Cloudflare RPC link today.
`acceptWebSockets` assumes an event-listener WebSocket server.
The Node manager spawns processes; it is not a portable scheduler.

**[Fact]** DO stubs support RPC and `fetch`.
Calls made through one stub have ordered delivery, not guaranteed
ordered completion. Different stubs have no ordering guarantee.
After a broken stub, recreate it. RPC callback capabilities have
execution-context lifetimes; they are not persisted addresses.
[Stubs][cf-stub], [RPC lifecycle][cf-rpc-life].

**[Inference]** An RPC adapter could carry Chord frames:

```ts
// Proposed envelope, not a platform or Chord API.
await target.deliver({ linkEpoch, sequence, frames });
// Replies / state pushes return through an addressed peer DO.
```

It must implement both directions, bounded queues, ordering,
link failure, cancellation and reconnect/reset. `fetch` POST
batches are another carrier, not inherently a duplex link.
A single request/response method cannot replace long-lived holds.
A stored peer host address is resumable; a JS callback stub is not.

Today's synchronous `Link.send` could enqueue an asynchronous RPC,
but its drain must belong to a live platform event and surface
failures. Neither unbounded fire-and-forget nor a warm stub in a
module variable is a durable transport.

Unlike an IPC pipe, addressed RPC delivery has no lasting peer
connection whose close releases every hold. Remote interest needs
a recoverable session/lease or equivalent reconciliation policy.
Its exact mechanism remains open; do not leak permanent holds
after a consumer DO disappears.

DO-to-DO WebSockets can approximate today's link more directly.
However, outbound WebSockets do not hibernate. A permanent hub
with outbound sockets to every session defeats much of the
scale-to-zero benefit. Prefer direct session sockets and addressed
messages for cross-host notifications where practical.
[WebSocket restrictions][cf-ws].

## 2. Each Chord concept

### Object types, objects and references

**[Inference]** Keep contracts and placement unchanged in meaning.
Translate logical host names to namespace + stable DO name in
the platform router. Do not put Cloudflare IDs in every contract.

A live reference means logical interest and a hydrated view.
It cannot mean that its provider's JS instance stays resident.
On a full restart, remote references retain readable old values,
become `loading`, re-hold and hydrate as already designed.
Hibernation additionally needs the connected-socket resume path
above, because no disconnect tells the client to re-hold.

`local` remains useful inside a DO. A local object cannot silently
move to another DO: that introduces serialization, principals
and failure behavior its callers did not agree to.

### Documents and SQLite transactions

**[Repo]** v2 already defines the right boundary:
`DocumentStorage.commit/find/load/scan/byTag/mintId`.
Singletons hydrate before activation; keyed docs load on demand.
Own-object plus facet documents may share one transaction.

**[Inference]** Implement that interface on DO SQLite:

```text
documents: owner identity, definition, key, version, JSON/checkpoint
changes:   whatever the chosen checkpoint/delta format needs
tags:      tag → document identity
jobs:      committed intent / outcome / acknowledgement
schedule:  routine or recovery key → next due time
```

`commit(batch)` must atomically write all documents and indexes,
then let Chord adopt the result and notify once.
Use stable owner/store keys, never a socket ID or random runtime
incarnation as the persisted document identity.
Non-persisted documents disappear on eviction or code reset, even
if a remote reference still exists. Persist required state; do not
promise pure-object reload preservation across a platform deploy.

**[Repo]** Durable already has
`openDurableObjectSqliteStorage(ctx.storage)` and
`DurableObjectSqliteDatabase`. It uses `ctx.storage.sql.exec`,
wraps commits in `storage.transaction`, converts BLOBs to bytes,
and queues operations across adapters sharing the same storage.
Its `close()` drains work; it does not close DO-owned storage.

This is a useful substrate, **not an existing Chord v2
DocumentStorage adapter**. Tags and Chord ownership still need
mapping. Prefix Durable and host tables separately. Route all
application SQL through the shared adapter queue: raw SQL during
an awaited transaction bypasses it and can join that transaction.
See [Durable storage source][repo-storage] and its README.

**[Fact]** DO storage provides input and output gates:

- Storage waits prevent unsafe interleaving of incoming events
  under the default gate rules. An external `fetch` await is
  not a blanket lock on the DO.
- Output gates hold outgoing effects/messages behind pending
  storage writes. They do not create a transaction with another
  DO, R2 or an external HTTP service.
- SQL execution is synchronous. `transactionSync` groups SQL
  with rollback on throw, but its callback cannot be async.
- SQLite-backed `storage.transaction(async ...)` can group SQL
  across awaits. Unrelated host work still needs coordination.

[SQLite API][cf-sql], [gate explanation][cf-gates].

**[Inference]** Keep Durable's stricter rule:
inside `self.tx`, only `await tx.*`.
DO gates do not replace Chord's object lines, draft ownership,
commit/adopt/notify ordering or abort checks.
Do not replace an async Chord transaction callback directly with
`transactionSync`; its final prepared SQL batch could use it,
while the adapter's existing async transaction is another option.

Concrete race:

```text
A reads note → awaits network → B changes note → A writes old plan
```

A DO does not make this safe just by being single-threaded.
Fetch before the transaction; decide against current drafts inside.

One DO's SQLite transaction can span its own and its facet's docs.
It cannot span two DO databases. Splitting a host into one DO per
object would therefore change the decided transaction semantics.

`blockConcurrencyWhile` can gate bounded local initialization.
It resets the DO on an uncaught error or a 30-second timeout.
Do not hold it around arbitrary plugin opens, remote dependency
activation or long calls; those can block unrelated traffic or
wait on a response that needs the blocked host.
[State API][cf-state].

### Derives

**[Inference]** Pure synchronous derives fit well.
Recompute them after document hydration and reference recovery.
`previous` is an optimization across factory reruns, not a durable
memory guarantee across eviction. A derive must produce correct
results without its previous cache; otherwise persist the needed
input in a document.

### Natives and `self.open`

**[Fact]** Workers provide fetch/streams, Web Crypto, service
bindings, R2, DO storage, TCP capabilities and deployed Wasm.
Node compatibility is partial: importing a shim is not proof that
it works. `node:vm`, `child_process` and `worker_threads` are
currently listed as non-functional stubs.
[Node compatibility][cf-node], [standards][cf-standards].

| Native on this target | Mapping |
| --- | --- |
| Durable harness / subscriptions | Open per runtime incarnation |
| HTTP client, remote-service session | Recreate on activation |
| SQLite | Host-owned DO storage, not a filesystem DB |
| Crypto/Wasm instance | Recreate; respect isolate memory/CPU |
| Local child process, PTY | External service required |
| Workspace directory watcher | Remote environment/event service |
| Persistent local files | R2 or external execution environment |

Workers now have a virtual `node:fs`: read-only bundle files and
request-local temporary memory files. That is **not** a persistent
workspace, and `fs.watch` is unsupported.
[Filesystem API][cf-fs].

**[Inference]** `self.open` stays useful, but “whole object life”
means one activation, not forever for a logical object address.
Open functions must tolerate repeated activation.
`close` can clean up on explicit disposal; it cannot be required
to flush state, release a distributed lock or finish a job.
**DOs have no guaranteed shutdown hook.** Use leases, expiry and
idempotent external cleanup. [Lifecycle][cf-life].

**[Repo]** Durable also already supports `RemoteCodemodeSandbox`.
`packages/codemode/src/cloudflare.ts` supplies a sandbox DO using
bundled QuickJS Wasm; it recommends a separately deployed Worker
to keep CPU-bound scripts off the session's isolate/thread.
Its default remote VM limit is 32 MiB, not p2's Node 256 MiB.
This is an existing remote-compute path, not proof that shell,
PTYs or the full p2 plugin set can run inside a session DO.

### Routines: `every`, `on`, `loop`, `custom`

**[Fact]** Each DO has one alarm slot.
Setting another replaces it. Alarms wake inactive DOs and execute
at least once; thrown handlers retry with exponential backoff,
starting at 2 seconds, up to six retries.
[Alarms][cf-alarm].

**[Inference]** One host scheduler multiplexes all routine due
times, retry backoff, linger expiry and unfinished-upload cleanup:

```text
cleanup             12:00
retry notes import  11:07
expire upload       11:10
DO alarm            11:07  ← earliest due record
```

The same scheduler must also coordinate with Durable's future
wake-ups; plugins must not independently overwrite the alarm.
Persist scheduling intent and arm the alarm atomically where
possible; provide recovery for an interrupted dispatch.
An in-memory heap alone cannot wake an evicted DO.

- **`every`:** persist next due time if it must run without
  viewers. Decide skip/coalesce/catch-up behavior after downtime.
  Treat delivery as repeatable, not exactly-once.
- **`on(readable)`:** rebuild subscriptions and reconcile from
  current state on wake. An unpersisted event emitted while the
  host is absent is lost; important events need a persisted cursor.
- **`loop`:** good for bounded work while active, not a guaranteed
  resident daemon. Reconcile/resume from records when restarted.
- **`custom`:** platform timers/watchers are a capability.
  Timer-based adapters prevent hibernation while pending.

An hourly cleanup that must run after the last reference is
released needs a durable scheduled owner. A reference-only object
that no longer exists has no routine to execute.

### Jobs and crash-resumable work

**[Repo]** Chord jobs deliberately are not durable execution:
intent → ordinary `run` → current-code `finish`.
A persisted live run interrupted by a crash becomes `lost`.
Crash-resumable work belongs in a Durable task.

**[Fact]** Current DO documentation says a promise passed to
`ctx.waitUntil` can prevent eviction until it settles or for up
to **15 minutes**. This differs from the ordinary edge Worker's
post-response `waitUntil` extension of **30 seconds**.
Neither is a persistence or crash-replay guarantee.
Alarm handlers currently have a 15-minute wall-time limit;
CPU limits are separate. [State API][cf-state],
[lifecycle][cf-life], [Workers limits][cf-worker-limits].

**[Inference]** On this target:

1. Commit intent and dedupe/concurrency state before starting.
2. Register bounded in-flight work with the platform event.
3. Persist outcome before finish/ack; persist finish retries.
4. On activation, mark interrupted runs without a stored outcome
   `lost`; replay pending finish/ack for outcomes already stored.
5. Use a persisted wake-up to guarantee this reconciliation can
   happen even if no client returns.

Do not retry an arbitrary `run` from the beginning on an alarm.
If an external import succeeded just before eviction, repeating
it may duplicate its effect. Use the job ID as an external
idempotency key. To resume useful progress, use Durable tasks or
an explicitly checkpointed application protocol.

A Promise, abort signal, login resolver or progress readable does
not survive memory loss. Interactive flows that must survive need
persisted steps and a resumable task, not only a job closure.

### `host.references` and presence

**[Inference]** A hibernating viewer is still connected and may
still be looking. Rebuild the reference list from attached
sockets plus recorded holds, preserving origin IDs per tab.
Do not interpret an empty new JS Map as “everyone left”.

A socket is not itself a hold: one tab can hold many objects.
For relayed references, preserve the original client ID rather
than counting the relay DO as one viewer.

On actual close/loss, mark holds lingering, exclude them from
viewer counts and schedule expiry. Expiry records and next wake-up
must survive eviction if they affect flow cancellation or cleanup.
Presence is approximate across broken networks; an auto-pong is
connectivity evidence, not proof that a person is watching.

**[Repo]** Today's connections start a 15-second interval pinger
and use incrementing JSON ping/pong frames.
**[Fact]** Timers prevent hibernation. CF handles WebSocket protocol
ping frames without waking the DO; its optional application
`setWebSocketAutoResponse` matches one fixed request/response pair.
[State API][cf-state], [WebSockets][cf-ws].

**[Inference]** A static transport heartbeat could use auto-response.
Today's changing JSON ping IDs do not fit it directly. Make
heartbeat policy pluggable; otherwise “hibernation support” still
wakes or pins every host. Browser JS cannot send protocol pings.

### Registries, compose and host values

**[Inference]** Static plugin contributions fit especially well.
Load all selected facets, stage declarations, run pure `compose`,
then activate objects and release the start barrier.
Composition conflicts fail startup or deployment validation.
They do not require runtime source evaluation.

Registry closures/natives are local to the DO incarnation.
Recreate them on wake. Do not persist a router containing
functions or send native registry entries to another DO.
A registry spanning hosts would require a separate data protocol;
Chord's registry is host-local.

Host values can provide:

- logical host/session ID and immutable deployment digest;
- DO storage/scheduler and typed service-binding capabilities;
- R2 and external execution-service access;
- deployment configuration and secrets, kept private.

A binding handle can be host-provided; a resource with its own
lifetime still belongs to an object. No real data directory,
process PID, local terminal or persistent cwd is implied.
Do not cache per-DO host values or a Chord host at Worker module
scope: multiple DO instances can share an isolate.

### Bytes and owner-chunked transfers

**[Repo]** v2's `Uint8Array` plus owner-managed offset protocol
is a good fit. Structured clone on Node IPC is one transport's
implementation, not the core wire contract.

**[Fact]** Current SQLite-backed DO limits include:

| Resource | Documented limit |
| --- | --- |
| SQLite storage per DO | 10 GB |
| SQL string/BLOB/row | 2 MB |
| SQLite-backed KV key + value | 2 MB combined |
| Incoming WebSocket message | 32 MiB |
| Worker isolate memory | 128 MB, including Wasm |
| DO CPU per request | 30 s default; configurable up to 5 min |

These are backend-specific, not the legacy KV-backed DO's
128 KiB value limit. Memory is per isolate, not a guaranteed
128 MB reserved for each Chord object or DO.
[DO limits][cf-limits], [Workers limits][cf-worker-limits].

**[Inference]** Keep an explicit application frame cap below the
platform maximum. About 1 MiB per binary chunk leaves headroom,
but the complete frame includes its envelope. Cap snapshots and
state batches too; chunked uploads alone do not bound a huge
singleton/index snapshot or migration result.

Use SQLite for metadata, upload IDs and committed offsets;
R2 for large immutable content. R2 writes and SQLite commits
are not one transaction. Write to staging keys, publish metadata
only after success, and collect orphaned uploads/blobs.

**[Fact]** R2 multipart parts have a 5 MiB minimum except the last
part, a 5 GiB maximum and a 10,000-part limit.
[R2 uploads][cf-r2].

**[Inference]** A 1 MiB Chord chunk is therefore not automatically
one R2 multipart part. Choose a larger owner chunk, persist small
staging objects and assemble them, or use an authorized direct
HTTP/R2 upload protocol. Do not buffer the whole file in a DO.
Keep resume offsets authoritative and append idempotent; an ACK
can be lost after storage succeeded. Downloads can use authorized
HTTP ranges rather than relay all bytes through a catalog DO.

## 3. Plugins without hot reload

### Fixed composition at deployment

**[Fact]** Ordinary Workers forbid `eval` and `new Function`.
`node:vm` is a non-functional compatibility stub, so loader D's
`vm.Script.runInThisContext` cannot evaluate fetched facet scripts.
A browser classic-script loader is not a server-side escape hatch.
[Standards][cf-standards], [Node compatibility][cf-node].

**[Inference]** Generate a static entry module at build time:

```ts
import notes from "./plugins/notes/worker";
import models from "./plugins/models/worker";
import agent from "./plugins/agent/worker";

export const sessionFacets = [notes, models, agent];
// The DO boot path installs this already-imported set.
```

Bundle the core and selected facets into deployed Worker modules.
Keep one runtime package instance, contract names/versions and
pure composition rules. Package installation, project approval
and bundling happen in trusted build infrastructure, not on DO
activation. JS modules can remain separate in the upload; they
need not be independently evaluated scripts or one physical file.

This changes the loader, not the plugin programming model.
Trusted plugins in that bundle share its authority; composition
is not tenant isolation. A fixed superset can select enabled
facets per tenant, but cannot load code absent from the deploy.

Audit dependencies for dynamic code generation too. Today's
Chord validation uses `typebox/value`; do not assume a future
schema JIT, bundler, lazy Node loader or native addon is portable.
Use interpreted or build-generated validation where required.

### If tenants later supply code

**[Fact]** Cloudflare's Worker Loader binding now appears under
**Dynamic Workers**. `env.LOADER.load(code)` creates a worker;
`get(codeId, callback)` allows caching. Code is supplied as Worker
modules, with explicit bindings and egress policy. This is
platform-mediated isolate creation, not eval inside the host.
[Dynamic Workers][cf-dynamic], [API][cf-dynamic-api].

Current docs also describe **Durable Object Facets**:
a supervisor DO loads a class from a Dynamic Worker and runs it
as a child with isolated SQLite storage via `ctx.facets.get`.
These Cloudflare facets are **not Chord facets**.
[DO Facets][cf-do-facets].

**[Inference]** This is worth rechecking for per-tenant Chord hosts.
It is not a drop-in loader D replacement: putting each plugin in
a separate isolate loses local references, native registry closures
and own/facet database transactions. Loading a whole tenant's
Chord host as one dynamic child is closer to the existing model.
Availability, CPU isolation, billing and WebSocket lifecycle need
a prototype before choosing it.

**[Fact]** Workers for Platforms offers another route:
a trusted dispatch Worker selects customer Workers in a dispatch
namespace. Customer code gets explicit resource bindings and limits.
[Workers for Platforms][cf-wfp].

**[Inference]** Deploy a tenant's fixed plugin set as one user
Worker/host bundle, or expose a remote extension service.
Dynamic dispatch routes to deployed code; it does not make
arbitrary source executable in the dispatcher's isolate.
None of these options is necessary for the owner's fixed-plugin
deploy goal.

### What happens to staging, rollback and revisions?

**[Inference]** On the static target:

| Reload mechanism | Static-deploy meaning |
| --- | --- |
| Load new facet source | Build/upload immutable Worker code |
| Stage factories and compose | Validate build; repeat activation checks on boot |
| Atomic host commit | One coherent bundle per DO incarnation |
| Retain old closures/jobs | No guarantee across platform reset |
| Roll back failed staging | Before startup, reject activation; no old in-memory host to retain |
| Roll back a release | Platform deployment rollback, not storage undo |

Keep per-object activation errors and start barriers.
Platform acceptance of a bundle does not prove every object factory
or tenant's stored documents can activate. Test representative
factories/compose in CI; defer real activation failures to the
normal object failure path.

**[Fact]** A deploy is **not a simultaneous restart of every DO**.
Code propagates eventually; new edge code can call old DO code
for seconds or minutes even without a gradual rollout.
Current gradual deployments assign each DO one version for that
deployment, unlike edge traffic split per request. A DO resets
when its assigned version changes; dormant DOs initialize on demand.
DO-to-DO calls can also cross versions.
[Code updates][cf-updates], [gradual DO deployments][cf-gradual].

Class lifecycle migrations are different from document migrations.
Current docs require class lifecycle changes to be deployed
atomically, outside gradual version uploads, and restrict rollback
past them. Document migrations still need their own policy.
[Gradual DO deployments][cf-gradual].

**[Inference]** Chord's current “ahead/installing → wait” rule
needs a target-specific rollout interpretation:

```text
edge B → session DO A during a 10% B rollout
A is healthy and intentionally stays on A.
Waiting for A to install B may never finish during this deployment.
```

- Identify the whole plugin/core code set with an immutable build
  digest and platform version, not only a server boot sequence.
- Keep desired deployment, observed provider build and provider
  health distinct. A sleeping DO is not `rejected` or `installing`.
- Use existing contract `accepts` adapters for versions the app
  elects to support, or reject incompatible skew explicitly.
- Park only when a control plane actually promises that provider
  is moving to the required build, and always bound the wait.
- Keep wire-protocol version checks. Breaking protocol deployment
  needs reconnect/reload or a compatible bridge, not silent retries.
- Never write a newer document shape and expect rollback to old
  code to understand it. Use compatible staged changes or refuse
  old access as v2 already specifies.

This does not require retaining compatibility forever or changing
the owner's no-compatibility default. A target must choose either
a supported skew window or explicit downtime/rejection. Even a
100% deployment is not an atomic cross-host code switch.

## 4. Equivalent platforms

These are mappings, not interchangeable products.
Platform summaries are facts from the linked docs;
Chord suitability judgments are inference.

### Rivet Actors

**[Fact]** Rivet describes keyed actors with state, actions,
WebSockets/events, actor-to-actor calls, scheduling and SQLite.
Actors sleep when idle and wake on demand. Files/processes/shell
are an additional agentOS capability, not implied by all actors.
[Rivet actors][rivet].

**[Inference]** A strong candidate for one actor per Chord host.
Object identity, local cores, documents and routines align well.
Still retain Chord principals, schema binding, compose and delta
semantics. Verify backend-specific serialization, transaction,
sleep/reconnect and upgrade guarantees. “Durable actor” alone
does not mean arbitrary `run` closures survive a restart.

### Deno Deploy, KV and queues

**[Fact]** Deno KV's documented queue API supports atomic enqueue
with KV writes and at-least-once delivery. It does not guarantee
strict message ordering. The referenced Deploy Classic docs carry
a July 20, 2026 shutdown notice and direct users to the new Deploy
platform. Do not assume those Classic deployment guarantees carry
over unchanged. [Deno queues][deno].

**[Inference]** Plain data contracts, static plugins, documents
and queued intent/effect/finish work map reasonably to a KV/queue
architecture. A KV store does not establish one live host per key.
Need a single-writer/lease routing design or a different
transaction adapter; a JS per-host queue does not serialize
multiple instances. WebSocket fan-out, derives and presence need
a separately defined resident/event hub. Recheck the new product's
KV, queue and instance lifecycle before selecting it.

### Vercel and Netlify Functions

**[Fact]** These are managed function runtimes with bounded
invocations and deploy-scaled instances, not a keyed durable actor
identity. Netlify offers background functions as well as request
handlers. [Netlify functions][netlify], [Vercel limits][vercel].

A current-docs correction: Vercel now advertises native WebSockets
in **public beta** on Fluid Compute. Connections pin to an
instance, end at its duration limit, and reconnects can land on
another instance; shared durable state belongs in an external
store. “Vercel cannot serve WebSockets” is no longer a safe blanket
claim. [Vercel WebSockets][vercel-ws].

**[Inference]** Good edge/router and HTTP method execution targets.
Static plugin composition works. Bad direct homes for a logical
Chord host with singleton docs, local cores, resident natives,
routines or presence. External actor/storage/queue services must
own those; warm function globals are only caches. Connection
support alone does not provide host uniqueness or transactions.

### Fly Machines

**[Fact]** Fly Machines are controllable VMs with explicit
start/stop, resources and region placement. Persistent data can
use Fly Volumes. [Machines][fly], [Volumes][fly-volumes].

**[Inference]** Closest to today's Node target: Node processes,
IPC/WebSockets, filesystem/native dependencies and loader D can
remain. One Machine can run several Chord hosts, or a host can
get its own Machine. The app/control plane still owns routing,
single-writer placement, storage attachment, failover and restart.
A volume is not a globally replicated DO database. Arbitrary
jobs still need crash recovery; stopping a VM does not preserve
its pending Promises.

### Azure Durable Entities

**[Fact]** An entity is identified by entity name + key, holds
persisted state and processes operations serially through reliable
messages. Operations can be scheduled. Orchestrations coordinate
calls and can lock entities under the framework's restrictions.
[Durable Entities][azure].

**[Inference]** Good for data owners, serialized operations and
scheduled routines. Could map one entity to a Chord host to keep
local ownership, though activation overhead/state size need testing.
Not a direct resident object graph: native handles, synchronous
live readables and socket subscriptions require another service.
Entity locks are not an automatic implementation of Chord's
own-plus-facet document transaction. Durable Functions also has
language/worker-model differences; do not assume all features of
its .NET model exist in a TypeScript target.

### Temporal / Restate-style durable execution

**[Fact]** Temporal rebuilds workflow state by replaying recorded
history; outside effects belong in activities. Workflow code must
use replay-safe operations. Restate offers services, keyed Virtual
Objects and Workflows, with durable operations and immutable
deployments; existing invocations can remain on their original
deployment. [Temporal][temporal], [Restate][restate].

**[Inference]** Best fit for crash-resumable tasks, flows, delayed
work and recorded outcomes. Restate Virtual Objects also resemble
keyed state owners. Neither is simply a container for Chord's
ordinary object factories, registry closures and native handles.
A live Chord host can be their gateway/view layer. A full mapping
would constrain effect execution and replay; it must not silently
turn every Chord job into a workflow. Temporal/Restate durability
also does not eliminate idempotency for external effects whose
completion can be ambiguous on retry.

## 5. Minimal pressure on today's v2 decisions

All recommendations in this section are **inference**, not changes
to the authoritative decisions.

### Keep these decisions

- **Synchronous declarative factories.** They help static assembly.
  Storage hydration and native opens remain asynchronous activation
  steps; factory sync does not require synchronous database loading.
- **Own/facet transaction boundary.** Keep it, but co-locate both
  owners in one host/DO. No distributed transaction is implied.
- **Local shared cores + per-principal remote views.** Especially
  useful under a DO's memory limit and shared SQLite ownership.
- **DocumentStorage.** Keep backend limits and transaction machinery
  behind it; do not add SQLite/filesystem assumptions to objects.
- **Jobs are not durable tasks.** `lost` is an honest outcome for
  interrupted ordinary code. Preserve that distinction.
- **Owner chunking.** Already supports backpressure, retry and
  partial-transfer cleanup without a core stream abstraction.
- **Compose is pure.** Static deploys can validate the same rules
  without runtime module evaluation.

### Small boundaries worth preserving

| Pressure | Minimal constraint or seam |
| --- | --- |
| Host defined as an OS process | Give it logical identity plus an activation incarnation |
| Loader D baked into core | Accept pre-imported facets; loader is a host adapter |
| Node IPC defines data semantics | Define JSON + bytes independently of the carrier |
| `Link` assumes a permanent socket | Separate frame delivery, session recovery and heartbeat policy |
| Per-host commit queue | Keep it host-local; never claim cross-DO serialization |
| Singleton docs always in memory | Hydrate only live owners; bound/paginate large values |
| Natives need guaranteed `close` | Cleanup best-effort on crash; persist intent/use external leases |
| Routine timers assume residency | Allow platform wake-up scheduling; declare capability limits |
| References keep processes alive | Distinguish logical interest from physical residency |
| Derive `previous` is indispensable | Require restart-safe recomputation or persisted inputs |
| In-memory flow/job resolver | Use persisted task/step state when recovery is required |
| Revision assumes one coordinator | Allow immutable builds plus platform rollout status |

**[Repo]** Durable already avoids cache-expiry timers where timers
cannot be unreferenced (`harness/scheduler.ts` and
`session/session.ts`). Its document retention can sweep on commits
instead. Chord's proposed one-timer keyed-document eviction should
similarly be a policy, not a mandatory background wake-up. Whole
DO eviction already frees those caches.

### What not to design now

Do not add cross-DO transactions, universal workflow replay,
a distributed registry, an RPC callback-based object API, or a
Cloudflare-specific plugin language. None is needed for a fixed
trusted plugin set.

When this target becomes concrete, prove these cases first:

1. Static facets + SQLite documents + two principal views.
2. Evict/hibernate with a held reference; restore state and presence
   without stale deltas or duplicated viewers.
3. Evict after job intent, after external effect and before finish;
   get honest `lost`/recovery behavior without duplicate effects.
4. Several routines plus Durable recovery sharing one alarm.
5. Edge B → DO A and DO B → DO A during a gradual rollout;
   no endless mismatch parking.
6. Chunked upload interrupted between R2 write and SQLite ACK.

The open issue is an execution/lifecycle profile for a DO host,
not whether plugins can be composed without hot reload.

## Sources

### Repository anchors

- [Authoritative decisions](../redesign-decisions.md).
- [Concept walkthrough](../chord-next-walkthrough.md).
- [Complete walkthrough](../p3-walkthrough.md).
- [Loader model](../plugin-loading.md), §§1–7, 14.
- [Chord links](../../../../packages/chord/src/old/link.ts),
  [wire](../../../../packages/chord/src/old/wire.ts),
  [connections](../../../../packages/chord/src/old/connection.ts),
  [hosts](../../../../packages/chord/src/old/host.ts),
  [Node manager](../../../../packages/chord/src/old/manager.ts).
- [Durable Cloudflare storage][repo-storage];
  [storage usage](../../../../packages/durable/README.md#storage).
- [Cloudflare codemode](../../../../packages/codemode/src/cloudflare.ts),
  [remote protocol](../../../../packages/codemode/src/runtime/remote.ts).

### Platform documentation

[cf-life]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[cf-stub]: https://developers.cloudflare.com/durable-objects/api/stub/
[cf-sql]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
[cf-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[cf-state]: https://developers.cloudflare.com/durable-objects/api/state/
[cf-rpc-life]: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
[cf-gates]: https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
[cf-alarm]: https://developers.cloudflare.com/durable-objects/api/alarms/
[cf-node]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
[cf-standards]: https://developers.cloudflare.com/workers/runtime-apis/web-standards/
[cf-fs]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
[cf-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[cf-worker-limits]: https://developers.cloudflare.com/workers/platform/limits/
[cf-r2]: https://developers.cloudflare.com/r2/objects/upload-objects/
[cf-dynamic]: https://developers.cloudflare.com/dynamic-workers/getting-started/
[cf-dynamic-api]: https://developers.cloudflare.com/dynamic-workers/api-reference/
[cf-do-facets]: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
[cf-wfp]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
[cf-updates]: https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates
[cf-gradual]: https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/
[rivet]: https://www.rivet.dev/docs/actors/
[deno]: https://docs.deno.com/deploy/kv/manual/queue_overview/
[netlify]: https://docs.netlify.com/build/functions/overview/
[vercel]: https://vercel.com/docs/functions/limitations
[vercel-ws]: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
[fly]: https://fly.io/docs/machines/
[fly-volumes]: https://fly.io/docs/volumes/
[azure]: https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-entities
[temporal]: https://docs.temporal.io/workflows
[restate]: https://docs.restate.dev/foundations/services
[repo-storage]: ../../../../packages/durable/src/storage/sqlite/cloudflare.ts
