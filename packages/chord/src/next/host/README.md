# host

Hosts, facets, objects, natives and references: hosts serving `local` and `remote` types, with failures and retries,
principals and variants, links to children, to a parent and over routes to addressable hosts (with relays between
them), the heartbeat, the `ctx` of method handlers, (slice 4b) revocation, cycles across hosts, presence,
keep-alive counts, size limits per part and compression at the origin, (slice 5) routines and the objects' jobs
(declared here, built in `jobs/`), (slice 6a) the host's store: tables, persisted documents and eager table
migrations at activation (built in `store/` and `documents/`), and live objects that fail, and (slice 8) registries
(served, contributed and read here, built in `registries/`), writables, wake signals (`retryOn`) and root scopes
(`host.root`).

## For apps (`index.ts`)

```ts
import { broken } from "../data/index.ts";
import { createHost, defineFacet, sleep } from "./index.ts";

const facet = defineFacet<AppPrincipal>((host) => {     // a facet declares only: types to serve
	host.serve(Notes, (_, self) => {                       // empty params: activated at load, lives until close
		const notes = self.state(NotesDoc);
		const info = self.get(SessionInfo, {});
		const watcher = self.open(                          // a native: opened during activation, closed at the end
			async (ctx) => watchDir(info.dataDir.value, ctx.abortSignal),
			async (w, reason) => w.close(),
		);
		self.on(info.dataDir, async ({ value: dir }, ctx) => watcher.value.follow(dir, ctx));   // first the current value; never a failure
		self.onLive(async (ctx) => {                        // once live; its ctx is aborted when the object ends
			for (;;) { await sleep(HOUR, ctx); await compact(ctx); }
		});
		return {
			notes,
			count: self.derive([notes], ([n]) => n.list.length),
			add: async ({ text }, ctx) => {
				await self.tx(async (tx) => { (await tx.draft(notes)).list.push({ text }); }, ctx);
				return null;
			},
			rescan: async (ctx) => watcher.value.rescan(ctx),
		};
	});
	host.serve(Remote, (_, self) => {
		self.open(async (ctx) => {
			const config = readConfig();
			if (!config) throw broken(new Error("no remote configured"));   // retrying is pointless
			return connect(config, ctx.abortSignal);                        // a throw here is retried with backoff
		}, (c) => c.close());
		return {};
	});
	host.serve(Draft, ({ conversation }, self) => {        // params: lives while referenced
		const store = self.get(Notes, {});                  // live before this object is
		return { summary: self.derive([store.count], ([c]) => `${conversation}: ${c}`) };
	});
	host.serve(NotesView, (_, principal, self) => {       // remote: one object per principal key, one variant
		const store = self.get(Notes, {});
		if (principal.kind === "guest") return { variant: "reader", members: { count: store.count } };
		return { variant: "editor", members: { count: store.count, add: (args, ctx) => store.add(args, ctx) } };
	});
});

const host = createHost<AppPrincipal>({
	principal: { kind: "server" },                         // what this host's own requests act as
	onError: (error) => log(error),
	closeTimeout: 30_000,
	readyTimeout: 60_000,
});
await host.load([{ name: "@app/notes", facet }], ctx);    // published, then every host-lifetime object's first outcome
const notes = await host.get(Notes, {}, ctx);             // live and hydrated; waits through loading, transient, waiting
await notes.add({ text: "milk" }, ctx);
notes.release();
const draft = host.hold(Draft, { conversation: "c1" }, ctx);   // a reference at once: loading, then live
(await draft.state.watch(ctx)).start(async (call) => call.kind === "value" && render(call.value)); // loading, live, failed, ended
// failed { waiting }: "waiting for X: …", not this object's fault; it goes on when X is live
if (draft.state.value.kind === "failed") draft.retry();  // a Retry button
host.accept(link, { principal: { kind: "guest", session: "S1" } }, ctx);   // a child's link, authenticated by its entry point
await host.close(ctx);                                    // closes links, then natives with reason "close"
```

Addressable hosts and routes (slice 4a): a server routes holds of worker types to the worker of their address.

```ts
export const Server = hostKind("server");
export const Session = hostKind("session", { id: str() });
export const Notes = remote("notes", { version: 1, params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }), variants: { … } });

const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError });
server.route(Session, {                                   // before load, one route per kind
	authorize: (principal, address) => principal.kind === "owner" || principal.session === address.params.id,
	resolve: async (address, context) => {                // once at a time per address; context aborted at close
		// No `signal: context.abortSignal`: it aborts at host close and would kill the worker (an `error` on the child);
		// the worker exits when its link closes.
		const child = fork("worker.ts", [], { serialization: "advanced" });
		child.send({ id: address.params.id });             // the app's own start message
		return { link: ipcLink(child), principal: { kind: "worker", session: address.params.id }, trusted: true };
	},
}, ctx);                                                  // ctx: the parent of the route's work
await server.load(serverFacets, ctx);
wss.on("connection", (ws, req) => server.accept(webSocketLink(ws), { principal: authenticate(req) }, ctx));

// worker.ts: connect first (W6), then load
const worker = createHost<P>({ address: Session({ id }), principal: { kind: "worker", session: id }, onError });
worker.connect(ipcLink(process), { principal: { kind: "server" }, trusted: true }, ctx);
await worker.load(workerFacets, ctx);

// a tab: tab → server (relays, parses nothing) → route(Session) → worker
const notes = await tab.get(Notes, { session: "S1" }, ctx);
```

Authority and housekeeping (slice 4b):

```ts
type Revocation = { grant: string } | { session: string };
const server = createHost<P, Revocation>({
	address: Server(), principal: { kind: "server" }, onError,
	revokedBy: (p) => (p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }] : []),   // the same on every host
	compression: nodeCompression,                          // Node only: `src/next-node/compression.ts`
});
server.revoke({ grant: "g1" }, ctx);                    // ends g1's objects here and on every worker, closes g1's links
host.serve(Notes, ({ session }, principal, self) => {   // in a facet: `host.references` is the facet's host's too
	const viewers = self.derive([host.references(Notes)], ([refs]) => refs.filter((r) => r.params.session === session).length);
	…
});
(await worker.activity.watch(ctx)).start(async (call) => call.kind === "value" && supervise(call.value)); // { references, calls, jobs, lingering }
server.accept(webSocketLink(ws), { principal, limits: { part: 16 * MiB, decoded: 64 * MiB } }, ctx);
```

- `createHost<P, R>({ address?, principal?, principalKey?, telemetry?, onError, closeTimeout?, readyTimeout?,
  heartbeat?, revokedBy?, compression? })`; `R` is the app's revocation type (JSON). `address` (`Session({ id: "S1" })`, see `contracts/`'s `hostKind`) makes the host addressable: it serves only
  objects placed there; without one it is a client. A host with a `principal` acts as it for its own requests; a host
  without one (a client) has none. A host serves remote types only with both a principal and an address (`serve` of a
  remote type throws at `load` otherwise).
  `principalKey` maps a principal
  to its part of an identity (L1's canonical JSON by default; the same function on every host). `closeTimeout` (30 s)
  bounds each native's close and the drain of an ending object's calls; `readyTimeout` (60 s) bounds every activation
  attempt (its wait for the previous instance's teardown included; paused while it is parked on its dependencies) and
  is the default deadline of a `get` and of `host.registry`. `heartbeat: { ping?, close? }`: a link silent for `ping` ms (15 s)
  sends a `ping`, one silent for `close` ms (30 s), its handshake included, is closed (its references go `loading`);
  one interval timer per host (`min(ping, close) / 10`), running only while it has links. A handler that blocks the
  event loop longer than `close` gets its links closed.
- `revokedBy(principal) => R[]`: what revokes a principal; its revocation keys are the canonical JSON of each value,
  computed once per principal object (cached weakly). `host.revoke(r, ctx)`, synchronously: every remote object whose
  principal has `r` among its keys ends at once, whatever references remain (R11): each holder gets `forbidden` with
  reason `revoked` (a UI can say "access revoked"; a hold over a link sends `gone` with it), running calls are aborted
  with it (callers rejected), an activation in progress is abandoned; teardown follows as for any end (drain, closes
  with reason `end`). Requests of the principal that hold nothing end too, bound to nothing yet or never: holds that
  arrived before the publication, holds refused here (`failed { waiting }`), relayed holds waiting for their route's
  link (each gets `gone`), references made here still unbound, and this host's own remote references of the
  principal over its paths, a route still resolving or a link down included (`ended`, released at the provider if
  held there): no later link holds them again.
  Then every route link is sent `revoke { revocation }`, which the child applies with its own `revokedBy` (and passes
  down its own route links), and every child link whose principal it revokes closes (a relay sends
  `closed { origin }` upstream for it, after the `revoke`). Never this host's own principal, never the parent link; a
  `revoke` arriving on any link but the parent is ignored; nothing is replayed to links made later. Revocation is an
  end, not a blocklist: a later hold for the principal (a new authentication) binds a new object. Local objects have
  no principal and are never revoked.
- `host.references(Type)` (also on a facet's `host`): a JSON watchable `{ params, principal?, incarnation }[]`, one entry per
  reference to an object of `Type` here: a binding of this host (`host.get`, `self.get`, `ctx.get`) or a hold over a
  link served here. `principal` is the reference's (absent for a local type); `incarnation` its caller's (a
  tab's own through a relay, this host's for its own references; a `ctx.get` reference the call's). Entries are
  added when a reference binds and removed when it ends, in the batch where that happens (a link drop is a departure
  derives see at once); lingering objects have none. The list is made for the first `references(Type)` (with the
  references existing then) and kept; while watched, a batch's changes are folded into the published list once (one
  splice op per removal, one for the additions: a revoke of many holds is one list and one frame), otherwise it is
  built on its next read. A departure discovered while a commit's links send (a transport failing on send) lands in
  the next batch, so one commit stays one message per link and origin.
- `host.activity`: a JSON watchable `{ references, calls, jobs, lingering }`: holds arriving over links and placed
  here, from their arrival to their end, bound or not (a hold waiting for a missing provider keeps a worker alive;
  `host.references` lists bound references only; a relayed hold counts at its destination), method calls running here (local and remote), job runs running or finishing here, objects lingering after their
  last reference. Counted where the work happens; the changes of one microtask turn are one publication
  (`[["r", counts]]`), a slow watcher gets the newest counts; nothing is scheduled while nobody watches or derives from
  it. Chord counts; the app's supervisor decides.
- `compression`: a synchronous `Compression` (`{ deflate(bytes), inflate(bytes, limit) }`, see `link/`): this host
  deflates each JSON part above 16 KiB (UTF-8) it originates, whatever the link (IPC included), only if it shrinks
  (values, ops, results, arguments; never params, never arguments sent up its parent link) and inflates deflated parts
  it owns in place. Child links refuse compressed parts (a protocol error: clients never send them, and a small part
  could inflate to 64 MiB). Without one (a browser) it sends uncompressed and inflates asynchronously
  (`DecompressionStream`), only parts it owns once their id and destination are known and their wire size passed,
  within the smaller of its link's decoded limit and a hold's stamped one, holding later messages of the link in
  order; acks go out after a message was applied, so a slow inflate is backpressure like a slow consumer.
- **Cycles across hosts (Q5):** every object instance gets an instance id (uuidv7) at its first attempt; a new object
  for an identity is a new instance. A hold made during an activation carries the chain of instance ids waiting for it
  (the activating object's chain, which it got from the hold that created it or from the object that declared it
  here, plus its own id; the last 32); honoured from trusted links only, relays forward it as it is. A provider refuses
  a hold whose chain names the instance it would bind while that activates: broken `invalid/cycle` naming the cycle by
  label where known ("app.a(1) → … → app.a(1)"); a local `self.get` of an activation in the chain is refused the same
  way. A dependency failing with `invalid/cycle` makes its dependent broken with that error (it would wait on a ring
  that never heals). The gap (owner, 2026-10-29: no probe): a chain is fixed when its object is created, so a ring
  across hosts whose objects start at the same moment is not detected, and without a dependency deadline it stays
  parked; an attempt parked longer than its `readyTimeout`, whatever its blocker (audit A11), is reported once per
  parking episode (`parked_long`), nothing fails. A cycle is a plugin bug: see the authoring rules below.
- `onError(error: HostError)` gets everything that fails in the background, by `kind` (`failure` where the value is a
  `FailureCause`, `error` otherwise; a position is `{ kind: "on" | "onLive" | "native", position }`, from 1):
  `activation_failed` (`object`, `failure`: every failed attempt), `object_failed` (`object`, `failure`: a live object
  failed, slice 6a), `storage_failed` (`error`: the host's store stopped; the host closes itself), `derive_failed`
  (`object`, `member?`, `error`: a derive's compute threw, once per failure episode, watched or not; `member` when it is
  an exposed state member), `close_failed` (`object`, `native` position, `error`: a close that threw while nobody
  waited), `close_timeout` (`object`, `native`: a close still running at its `closeTimeout`, a possible leak), `drain_timeout` (`object`: calls still running at `closeTimeout`; their natives close anyway),
  `listener_error` (a throwing watch listener), `delivery_failed` (a frame delivery or a link's flush that threw) and
  `protocol_error` (`error`: what closed a link, see `link/`) and `resolve_failed` (`address`: its key, `error`: a
  route's `resolve` rejected; the address waits its backoff), `routine_failed` (`object`, `routine`: its position,
  `error`: a routine call threw, or its watch could not be taken; a source's failure calls never reach a routine), `job_failed` (`object`, `job`,
  `id`, `error`: a run threw, not after an abort), `job_finish_failed` (the same: a `finish` threw; it is retried) and
  `job_dropped` (`object`, `job`, `id`: a blocked run dropped without `finish`, by `abort` or its object's end),
  `parked_long` (`object`, `waitingFor`: the first blocker's label in declaration order, a reference's or `registry
  <name>`, `state`: `loading` or `failed`, `since`: when it parked; once per parking episode, its pinned keys' loading
  included, slice 7a, audit A11), and
  the registries' (slice 8, each once per episode) `registry_conflict` (`registry`, `message`, `plugins`: a conflict
  `compose` resolved), `registry_failed` (`registry`, `error`: `compose` or an older version's `value` adapter threw),
  `contribution_failed` (`registry`, `plugin`, `type?`, `error`: a watchable contribution failed or ended, or its
  adapter threw) and `contribution_refused` (`registry`, `plugin`, `type?`, `version`). A throwing `onError` is
  ignored.
- **Registries** (slice 8, `registries/`): a facet serves a registry it defines with `host.serve(R, { compose,
  accepts? })` (one provider per host; a second serve throws at `load`); a facet's `self.contribute(R, value)` (its
  setup's second argument, `FacetSelf`) is in the table while the plugin is loaded, a host-lifetime object's (`local`,
  empty params: `StoreSelf.contribute`; any other factory throws, R21) from `live` until it fails, ends or restarts,
  entering before anyone sees it live and leaving at its seal. One value per registry each; a Chord watchable (a
  source, a constant, a document handle, a reference member, a writable, a registry value) is followed through the
  batch, anything else is a plain value whatever methods it has (registries carry natives); a ring of registries
  reading each other is caught when one composes (audit A2): the registry read while it composes throws
  `invalid/cycle`, the contribution that read it is left out and reported `contribution_failed`, the rest works. Every
  served registry composes once at the end of `load`'s setups, before any object activates.
  `self.registry(R)` is a declared dependency: without a usable value at its version (no provider:
  `unavailable/undeclared`; a first `compose` or the version mapping that threw; a version the provider does not serve:
  `contract_mismatch`) the attempt parks `failed { waiting }` naming the registry, and every change of whether the value
  is usable wakes it. `host.registry(R, ctx, { readyTimeout? })` waits for the publication, then the same way up to its
  deadline, and rejects with the last error. The last good composition is kept only while every contribution it was
  built from is still in the table (a contributor that fails or ends drops it: `.value` throws until `compose`
  succeeds).
- **Wake signals** (`self.retryOn(...sources)`, D2): registry values (constants are accepted and never wake; anything
  else throws: a reference's member, the attempt's writable, `ref.state`). The object follows them from the factory's
  return (before hydration, references and natives, so a failed open still has them) until the next attempt's
  declaration replaces them or it ends. A new value retries a failed object (`transient` or `broken`) as `ref.retry()`
  does, after the batch; one while it activates is remembered and retries it at once if that attempt fails; one while
  live is ignored; failure calls wake nothing; a composition made by the object's own contributions leaving (it
  failed live) does not wake it. There is no backoff between wakes: wake an object on sources that change rarely
  (models, a harness), not on every event (a writable set per message retries a failing object per message).
- `host.root(fn, ctx, { principal? })` (slice 8 D3): `fn(ctx)` with a handler's `Ctx<P>`: the host's principal or the
  given one, this host's incarnation, `ctx`'s telemetry, a signal linked to `ctx`'s, `ctx.get`. When `fn` settles,
  `ctx` aborts or the host closes, the scope is sealed: its references released (their calls reject `released`), a
  waiting `ctx.get` gives up, a later one is refused `released/settled`, its signal aborted. An abort rejects
  `host.root` at once (an uncooperative `fn` runs on and fails at its next use of Chord); an aborted `ctx` runs no
  `fn`; `host.close` rejects it at once `released/closed`, as a method's caller when its object ends; after `close`
  it rejects `released/closed`. Not counted in `host.activity`.
- `host.load([{ name, facet }], ctx)`: once per host; runs every setup and publishes them in one batch (types and
  registries served, registries composed once, contributions); requests made here and holds arriving before that
  waited in the unbound index (`loading`) and are placed after the batch (they never wait for the barrier: two hosts
  whose objects need each other's types start without a deadlock). Then it activates every type with empty params and
  resolves when each has its first outcome (decision (a)): live, failed by its own cause, parked with no blocker that
  is an object here still without its first outcome (a keyed pin still loading counts as here; a wait on another host
  or on a failed dependency ends the first pass), or ended (`close` settles a waiting `load`); later retries never
  hold it. Per plugin (decision "Per plugin at startup and reload"): a plugin whose setup throws or is refused at
  declaration (an invalid or repeated name, a type or registry an earlier plugin serves, a remote type here without
  principal or address, `checkAccepts`) is left out; `load` resolves with `{ failed: [{ plugin, error }] }` and never
  closes the host; its consumers wait `failed { waiting }`.
- `host.reload([{ name, facet }], ctx)` (slice 7b, per plugin since 7c): the complete new plugin set; staging runs the
  new code per plugin (unchanged and failed plugins keep their loaded entries, their setups not run again). A plugin
  whose new code fails (its setup, a factory against the recording `self`, a declaration error, a name another plugin
  serves) keeps its old code (an added one is left out) and staging runs again without it; then a changed plugin whose
  recorded requests would not bind because of such a plugin (its old code serving the name, or nobody serving it)
  keeps its old code too (the closure rule), to a fixpoint; a request is checked as a bind checks it, the provider's
  host address included. `reload(facets, ctx, { failed })` names plugins the caller passes as their loaded facet
  because their new code failed before (a build, an evaluation: the plugins component): the same for the closure rule.
  The report lists them all in `failed`; the rest commits. `ctx`'s abort before the commit rejects `aborted` and
  changes nothing; after it, it ends only the wait for the report: `aborted` with `details.committed`
  (`CommittedReload`: `added`, `changed`, `removed`, `failed` by plugin name), the commit standing.
- `host.hold(Type, params, ctx, { readyTimeout? })`: a reference at once (`Held<C>`: its `variant` is `undefined` until
  its first binding), which follows its object until released and never rejects: `loading` before the publication,
  while the object activates, retries or is parked on dependencies under way, while there is no parent link or it is
  down; `failed` while the object is failed and no attempt runs, or while nothing fits it (`waiting`: not served where
  it goes, another version; bound when a publication serves it) or its object is parked on a failed dependency;
  `live`. Throws at once only for invalid params (`invalid/params`, also before `load`). A `hostAddress` or
  `authorize` that throws or refuses, or a host address whose params fail its kind's check (`invalid/host_address`),
  fails the reference `broken`. A local type never crosses a link. Where a reference made here (`host.get`/`hold`,
  `self.get`, `ctx.get`) or a hold arriving on a link goes, by address alone (`Destination`; the address is the
  contract's `hostAddress` of the params, computed by the caller; a hold carries it to be routed, and a host serving
  the type computes it again):

  | Case | Goes |
  | --- | --- |
  | a local type; a remote type whose address is this host's, served here or not; a hold naming this host's address | here, checked against what is served here (below) |
  | the address is of a kind this host has a route for | over that route's link (the params checked against the kind, `authorize` first; `forbidden` when it refuses) |
  | otherwise (a remote type) | over the parent link, open yet or not; a hold that arrived *on* the parent link is never sent back: `unavailable` |
  | an arriving hold and no parent link | `unavailable` |

  Placed here, a request is checked against the type served here only (never a same-name registration elsewhere):
  not served (or served as the other kind) or not at the caller's version and fingerprint, or params the provider's
  own `hostAddress` places on another host (code skew; checked for an arriving hold and for a remote request made
  here alike), it waits unbound `failed { waiting }` (`unavailable`, `contract_mismatch`, `invalid/host_address`),
  indexed under its name on this host (`unbound.ts`) until a publication wakes it (a refused hold also by a `retry`,
  which re-runs its start: `loading`, then `bound` or `failed`); invalid params, a cycle and a provider's
  `hostAddress` that throws (its own code) are `broken`, never indexed. A hold that arrives and goes on is relayed (`remote/`): this host
  holds it upstream as the arriving hold's caller and forwards between the two without parsing params, arguments,
  results or state.
- `host.get(Type, params, ctx, { readyTimeout? })`: a hold, awaited until live. Each getter has one deadline for its
  whole wait, the publication and reconnects included. A broken failure rejects it at once with its error; through
  `loading`, `failed { transient }`, `failed { waiting }` and drops it waits, and at its deadline rejects with the last
  failure's error (`unavailable` "did not become live within …" when none failed yet). A getter whose deadline passes
  or whose context is cancelled releases only its own reference.
- `host.serve(Type, factory, { linger? })` in a facet's setup: a live object with params whose last reference is
  released stays live for `linger` ms (0 by default), with its documents and dependencies; a reference within that
  time reuses it, otherwise it ends. An object waiting, activating or failed when its last reference goes ends at once;
  a failed state member does not end a lingering object; `host.close` ends lingering objects at once.
- `limits: { part?, decoded? }` on `accept`, `connect` and a route's `resolve` result: per part of what arrives on the
  link, its size on the wire and after inflating (none on trusted links, 16 MiB and 64 MiB otherwise, unless set).
  Checked before a part is parsed or inflated; past a limit only its hold or call fails (`too_large/part`: an argument
  its call, a result its call, a snapshot or a state part its hold, which the consumer releases at the provider; that
  failure is final: the reference leaves its path, a reconnect holds nothing again, and only `ref.retry()` places it
  anew and holds it with a new id), the link stays. A relay
  checks `part` on the admitting link and stamps that link's decoded limit on the upstream hold (`limit`, honoured
  only on a parent link); calls on the hold inherit it, and the host that inflates enforces the smaller of its own and
  the stamped one while inflating. A relay does not check answers from upstream: the end that parses a part checks it
  against its own link's limits. Limits count UTF-8 bytes; byte segments are no parts (the transport's cap bounds
  them).
- `host.accept(link, { principal, trusted?, codec? }, ctx)`: a link from a child (`codec`: `binaryCodec` by default,
  the same at both ends; `trusted` skips the message schema check, see `link/`). Every hold and call arriving on it
  acts as `principal`, stamped by this host (principal fields on its holds are ignored); its calls get the child's
  incarnation as `ctx.incarnation`. `ctx` is the parent of the work arriving on it (its cancellation is dropped: a
  link lives until closed). Every link carries both directions: this host may hold types over it too.
- `host.connect(link, { principal, trusted?, codec? }, ctx)`: the parent link. It throws while the previous one is
  open (also while it is still closing); once that closed (a drop), `connect` takes the next. Every remote reference
  of the parent path that is not released is held on it again, with this link's own ids (see `remote/`). `principal`
  is who the parent is; holds arriving on it may name whom they act for (`principal`, `incarnation`), which this host
  honours. Connecting before `load` lets factories that reference remote types go live without waiting (W6).
- `host.route(Kind, { authorize, resolve }, ctx)`, before `load`, once per kind (`ctx`: the parent of its `resolve`s
  and of the work arriving on its links, with their telemetry; aborted for them at host close): how this host reaches
  hosts of `Kind`.
  `authorize(principal, address)` runs for every hold routed over it with the hold's principal, before anything
  starts (`false`: broken `forbidden`; a throw: broken with that error). `resolve(address, context)` returns `{ link,
  principal, trusted?, codec? }`, the address's link (role `route`); it runs at most once at a time per address, later
  holds wait for it, and `context` is aborted only when the host closes (a link it returns later is closed at once). A
  `resolve` whose holds were all released meanwhile finishes and its link is kept. A rejection (`resolve_failed`), a
  link closed already, or the address's link closing while holds over it exist starts the address's backoff (1 s
  doubling to 60 s, separate from objects' identities); the holds stay `loading` and resolve again after it while they
  exist. Only a link that completed its handshake resets the backoff. A `resolve` returns the link before the worker
  loaded (the worker connects first): waiting for its `load` could deadlock. Chord never closes a route link except
  at `host.close`. When this host holds over a route link it sends whom each hold acts for (the table in `remote/`):
  a guest's handler that `ctx.get`s a worker type reaches the worker as the guest.
- `host.close(ctx)`: aborts every route's `resolve`, closes its links first, children, routes, then the parent (no
  `gone` goes out), ends every remote reference (`released/closed`, parked calls rejected with it), every request
  still unbound (waiting for the publication or a provider) and every waiting `host.registry` (`released/closed`, at
  once, not after the slow closes below), then ends every
  object at once (calls fail `released/ended`, `self.tx` throws; documents stay readable until it is done), aborts pending opens, waits for endings already running, then drains and
  closes object by object, the last to go live first (a dependent before its dependencies), with reason `close`.
  Every call returns the same closing. It rejects with an `AggregateError` of the closes that threw. It does not wait
  for an open that ignores its abort: that value is closed when it arrives (a throw is `close_failed`).
- `defineFacet<P>(setup)`: `setup(host)` declares only, synchronously: `host.serve(Type, factory, options?)` and
  `host.references(Type)`. Facets have no documents, routines, natives or jobs (slice 6a): state and work belong to
  objects. A host for `P` takes only facets typed for exactly `P`.
- `createHost({ store?, ... })` (slice 6a): the host's store (`openStore` in `store/`), which the app opens, gives to
  one open host at a time (`invalid/args` otherwise) and closes after it. A backend error stops the store: the host
  reports `storage_failed` once and closes itself. A `local` type with empty params may then declare
  `self.table(definition)` (once per table name) and persisted documents (`defineState(..., { persist: true,
  checkpointWhen })`); the types refuse both elsewhere (P3), and so does the factory at runtime. Its activation
  loads the persisted singletons and pinned keys, then creates or migrates its tables (the `readyTimeout` deadline
  paused meanwhile, resumed with its remaining budget), then binds its references. A table or document the code
  cannot read (a newer version, a history edited in place, a failed `rows` step or `migrate`) fails the object
  `broken`; a live object whose read fails so fails while live (`object_failed`), keeping its documents for the
  next attempt.
- A factory `(params, self) => implementation` declares with `self.state`, `self.derive`, `self.get`, `self.open`,
  `self.on`, `self.onLive`, `self.job` (`jobs/`), `self.registry`, `self.writable` and `self.retryOn` (below), and
  writes with `self.tx`. It runs once per attempt. The implementation has exactly the contract's members: state
  members are JSON watchables (document handles, derives, reference members, constants), methods `(args, ctx) =>
  Promise<result>`, or `(ctx) => Promise<result>` for a method without arguments (the reference omits them too:
  `notes.clear(ctx)`). A remote factory `(params, principal, self) => ({ variant, members })` gets the principal its
  object is for and returns one variant with exactly that variant's members.
- **Routines** (§14): `self.on(source, fn)` and `self.onLive(fn)` start right after the object went live, in the same
  turn (a method call admitted in that turn may run before the first `on` call), and stop when it ends: their ctx is
  aborted with the end's error and the drain waits for their running calls (each admitted before its handler runs: a
  handler may end its own object before its first await). Once the object ended no further call starts, and a routine
  that ends its object as it starts (an `onLive` releasing the last reference) starts none after it. Each call gets its
  own ctx (the object's principal for a remote type, the host's for a local one; the host's incarnation; `ctx.get`
  released when the call settles). They are not counted in `host.activity`.
  - `on` over a JSON watchable (one whose watch is Chord's shared `Watch`: a document, a derive, a reference member, a
    constant, a Durable view) calls `fn(call, ctx)` with the value call `{ kind: "value", value, ops, retired }`; over a
    native watchable (whose watch is the shared `NativeWatch`: `ref.state`, a registry value) `fn({ kind: "value",
    value }, ctx)`, as the overloads type it. Failure calls never reach `fn`: the routine waits for the next value (the
    failure is reported where it happens, a derive's as `derive_failed`). The first call
    gets the current value as `[["r", value]]`, then one call per change; calls never overlap, every change made during
    a call (the first one and retries included) folds into one next call (the newest value; for JSON its folded ops,
    and `retired` when any change was a retirement), made one macrotask after the busy call so every value its watch
    still buffers is taken first (a native watch replays them one per microtask), and none aborts it. A call that
    throws is reported (`routine_failed`) and the backoff starts, also when the call changed the source (a handler
    writing its own source and throwing never feeds itself): after 1 s, doubling to 60 s, it calls with the newest
    value, or the last call's, as a whole value, `retired` again if the failed call had it; a change during the backoff
    calls at once. Any call cancels a pending retry, and a call that succeeds resets the backoff. The source ending (a
    document of an object that ended, a released reference) ends the routine without a report; a watch that cannot be
    taken ends it with one report (`routine_failed`). A retirement (a Durable document's;
    Chord's own documents retire this way from slice 6a) is a call with `retired: true`, and the routine goes on.
  - `onLive(fn)` is called once: returning ends it, a throw is reported and restarts it after the same backoff (reset
    after a run of at least a minute); an abort (the object ends) is no error.
  - `sleep(ms, ctx)` resolves after `ms` and rejects with the abort reason once `ctx` is aborted, clearing its timer and
    listener (delays above 2^31-1 ms are chained timers); `untilAborted(ctx)` resolves once `ctx` is aborted. Routines
    and handlers wait only through calls that take their ctx.
- `ctx` (`Ctx<P>`) in a handler: `principal` (the caller as its hold's link stamped it, or as a parent link's hold
  named it; on a local object's handler the host's), `incarnation` (the calling host's over a link, the origin's
  through a relay, this host's otherwise, R20), `get(Type, params, { readyTimeout? })` (a reference as
  `ctx.principal` sees it, with `ctx.incarnation`, also over a route; released when the handler settles; afterwards
  `get` throws `released`), the abort signal (the caller cancelled or released, or the object ends) and telemetry.
- `self.open(open, close, { closeTimeout? })` returns a `Native<T>`: its `value` is readable from the moment its open
  resolved until its close starts; before, it throws `not_ready`, after, `released`. `open(ctx)` gets a context
  aborted when the attempt is abandoned; `close(value, reason, ctx)` gets `{ kind: "end" | "close" | "reload" }` (end:
  last reference gone or a failed attempt; close: `host.close`; reload: slice 7) and a context aborted at its
  `closeTimeout`. Throw `broken(error)` from an open when retrying is pointless.
- A reference has the contract's members, `state`, `retry()` and `release()`. A remote reference has `variant`, its
  discriminant (`RefIn<C, V>` narrows the type), `undefined` before its first binding and the last bound variant while
  loading or failed; at runtime it carries every member of every variant, and one outside the bound variant fails
  `invalid/member`.
- `ref.state` (a `NativeWatchable<RefState>`, made on first access): `{ kind: "loading" } | { kind: "live" } | { kind:
  "failed"; cause; retryAt }` (`retryAt`: when the object's backoff window ends, `undefined` for a `broken` or
  `waiting` cause) `|
  { kind: "ended"; error }` (for good: `released` without a reason when its holder released it, `released/ended` when
  its object ended, `released/closed` at host close, `forbidden/revoked`). A watch gets the current state, then every
  change; it ends `ended` when the reference ends. What a
  reference does in each state:

  | State | Calls | State members |
  | --- | --- | --- |
  | `loading` | park: sent in the order made once live, each until the reference's `readyTimeout` (`unavailable/park_timeout`) | the last value; before the first binding a read throws `not_ready` and a `watch` waits for the first value |
  | `live` | run | readable |
  | `failed` | reject at once with the cause's error | a local object that went live once (it failed live, or a retry failed): the last values, a new `watch` opens at them, no frames until a new attempt is live; otherwise reads throw the cause's error and existing watches stay open |
  | `ended` | throw its `error` | reads throw `released`; watches end `ended` |

  Calls made after the reference went live never overtake queued ones (a call a handler makes while they are sent
  queues behind them). A parked call is checked against its deadline when it is about to be sent, and against the
  variant it is sent on; it also leaves the queue when its caller cancels (rejected with the reason), the reference
  fails (the cause's error) or is released (`released`). A `host.hold` released before the publication makes nothing.
- References are the only indirection (decision of 2026-10-29): a consumer's watches and derives over `ref.member`
  attach through the reference's member (`reference-source.ts`), which passes them straight to the object instance's
  own document or derive. When the reference's target changes (a new instance after a reload, retry or restart; a new
  object after removal and re-serving; another variant) it moves them there and sends one frame (a diff from the last
  value, whole after a failure). While it points at nothing it keeps its last values: no call while loading, one
  `failed` call while failed; a member the new variant lacks fails `invalid/member`. A failed live instance's members
  (its own and re-exposed ones) are followed until the commits it admitted published, then all hold (audit A10), as a
  restart's drained instance's. The keys a reference holds on a keyed member (`at(key)`, `watch(key)`) are its own
  (`reference-keys.ts`): they follow the instance they are pinned on as long as the object does (members' rule), are
  pinned again on each new live instance, their last value kept until that pin loads; a dependent's factory pin loads
  before the dependent goes live. Older consumers read through the instance's shared mapping for their version
  (`adapted.ts`).
- `ref.retry()`: a failed object (broken too) gets an attempt now, its backoff window skipped; every reference to it
  goes `loading`. One parked `failed { waiting }` passes it on (above). Ignored while an attempt runs otherwise, once
  live and once released; over a link it is a `retry` message carrying its hop budget (`hops`).

Rules:

- One object per (type, params), per (type, params, principal key) for a remote type. A local type with empty params
  lives from `load` to `close`, failed or not; every other type from its first reference (a get, a hold over a link)
  to its last release, failed or not. `load` never activates remote types.
- **Principals of same-host references:** `host.get` acts as the host's principal; `ctx.get` as `ctx.principal`;
  `self.get` in a remote object's factory as that object's principal, in a local object's factory as the host's. Over
  a route link they travel with the hold; over the parent link the parent acts as this host (upward is a boundary: a
  worker that acts for a user towards the server passes the user as data and the server object decides).
- **Activation**, one attempt: the factory; singleton documents hydrated; its requests made (references bound,
  registries read); parked until every dependency is live (below); then its own steps: natives opened one after
  another in declaration order (an opener may read documents, references and earlier natives, not derives), followed
  sources attached, members checked, derives computed; live. An attempt whose own steps do not finish within
  `readyTimeout` (the time parked not counted) is abandoned: its openers' contexts are aborted, what it opened is
  closed (`end`), an open resolving later is closed at once.
- **Parked attempts** (dependency model §3, slice 7a; `dependencies.ts`): a dependency is a `self.get` reference
  (local or remote), a `self.registry` value or a keyed pin (`ref.member.at(key)`, loaded once the reference is live);
  `self.follow` is an own step. While one is not live the attempt is parked and its object shows `loading` (all under
  way), `failed { waiting }` with `unavailable` "waiting for X: <root cause>" (X the first failed one, the root cause
  found through X's message; always these two, so a ring of waiting attempts settles after one round; within 500
  characters, X's label clipped first; X's error as `cause`), or fails `broken` with the error of a dependency that
  failed for a cycle, for authority (`forbidden`: an `authorize` refused it) or ended. A getter's deadline rejects
  with the last cause it showed, also after the dependency fell back to `loading`. No timer runs (no dependency deadline, no backoff; the `readyTimeout`
  deadline paused); the factory never runs again; every change of a dependency (its state, a new cause by value, its
  first outcome) makes it check again once after the batch that made it; once all are live it goes on to its own
  steps, and a dependency leaving `live` after that changes nothing. `ref.retry()` on a parked `failed { waiting }`
  object passes on to its failed dependencies (audit A5): on one host one retry's walk keeps a visited set (a diamond
  retries a shared dependency once); across links the `retry` message carries a hop budget (`hops`: 16 from the first
  host, one less per host, never sent at 0), so a waiting ring across hosts passes it round until the budget runs out,
  starting no attempt, and a diamond across hosts may retry a shared dependency twice (harmless): a `broken` or
  `transient` one starts an attempt, a parked one passes it on, a request waiting in an index is left alone, a
  refused hold over a link re-runs its start); a `retryOn` wake does nothing while parked. A parked object whose last reference goes ends at once.
- **Authoring rules against cycles** (dependency model §7; a cycle is a plugin bug, and a ring across hosts started at
  the same moment is only reported, `parked_long`): (1) a factory declares only what the object needs, never a type
  that needs it back; (2) back-references and occasional lookups go into methods and routines (`ctx.get`); (3) data
  flows up through state and registries, not mutual `self.get`; (4) host-lifetime objects on the server never declare
  worker types in their factory.
- **Failures** become a `FailureCause` with a ChordError; the kind comes from where it failed: the factory, a
  singleton's `initial()`, the member check (a native watchable as state included), a first derive compute or a
  dependency cycle are `broken`; a throwing open or a failed `self.follow` attach is `transient` unless it threw
  `broken(error)`; the `readyTimeout` is `transient`; a dependency that failed is no failure of the dependent (it
  parks `failed { waiting }`, above), one that failed for a cycle, for authority (`forbidden`) or ended makes it
  `broken`. A keyed document's
  `initial()` runs in a later transaction and fails only that transaction. A cycle (`a(1) → b(1) → a(1)`) fails every
  object on it.
- **Retries:** one attempt per object at a time. A transient failure is retried after a backoff per identity: 1 s,
  doubling to 60 s, reset by a success; a new object for an identity inside its window waits for the window's end.
  A broken failure is retried only by `ref.retry()` (and reload, slice 7b, `retryOn`, slice 8); a new object after its
  end tries at once. A failed attempt releases its references once its natives closed; the next attempt makes new
  ones. A dependent of a failed dependency is not retried at all: it is parked and goes on when the dependency is
  live (no backoff of its own).
- **Ending:** transactions refused and the callers of running calls rejected `released` at once, their handlers'
  contexts aborted, routines' and job runs' too (their waiters rejected); then the drain (the handlers', routine
  calls' and runs' own promises, a run's `finish` included, up to `closeTimeout`), the natives closed in reverse
  (each up to its `closeTimeout`; a throw never stops the others), the documents (readable until then) dropped, the
  derives detached, the references released, every watch on its members ended (`ended`). A new instance or attempt
  for the identity starts only after that; gets wait.
- Calls check the method against the bound variant first (`invalid/member`), then the arguments against the provider's
  current version (`invalid/member`, `invalid/args`); on one host arguments and results pass by reference.
- **Release** rejects the calls made through the reference with `released` and aborts their handlers' contexts, on one
  host as over a link. A get needs the provider's version and fingerprint (`contract_mismatch`, `waiting`); an
  unserved type is `unavailable` (`waiting`); both wait up to the getter's deadline; a closed host is `released`.
- Watches taken through a reference end when it is released, even while others keep the object alive.
- A failure's error keeps its stack frames' receivers alive until its `stack` is read (V8), its failed attempt among
  them (natives closed, documents dropped). An object keeps its last failure's error until it goes live or ends; an
  app logs the errors `onError` gets and drops them.

Patterns for natives (documentation, nothing to build). Restarting a native with work in flight (R16): a restart
(reload, slice 7) closes the old native, then opens the new one, one after the other. Two patterns keep in-flight work
alive:

- **Drain in the background:** `close` detaches the old resource and returns at once; the resource disposes of itself
  when its work has finished, or after the native's `closeTimeout` at most (code mode's sandbox). Chord then opens the
  new one immediately; callers look the current resource up when they start (`watcher.value` at each use).
- **Swap through a registry** (slice 8): the resource is a registry contribution; readers always find the current one,
  and a reader that must wait for one waits, cancellably, until one is present.

A native that follows a relocation (design §6) is not restarted at all: the native is a stable manager opened once; a
routine on the session location (slice 5) switches the resource it manages (the watched directory) and bumps a
generation, so late events from the old location are dropped.

Runnable examples, one topic each, in `test/next/examples/` (run from `packages/chord` with
`node --conditions=source --experimental-strip-types test/next/examples/<file>`): `01-objects.ts` (contracts, facets,
references, calls, lifetimes), `02-documents.ts` (singleton and keyed documents, transactions, shorthands),
`03-derives.ts` (derives, `mapShared`, derives over other objects), `04-watches.ts` (frames, folding for a busy
listener, retire, cancellation, release), `05-errors.ts` (invalid arguments and params, unknown members, contract mismatch, released references,
cycles, throwing factories), `06-natives.ts` (opening in order, `not_ready`, close reasons, throwing and slow closes),
`07-failures.ts` (transient and broken failures, backoff, dependency recovery, `readyTimeout`, the start barrier),
`08-remote.ts` (two hosts, variants per principal over a shared store, replicas), `09-calls.ts` (calls over a link,
bytes, errors, `ctx.principal`, cancellation, release), `10-drops.ts` (a hold before any link, `ref.state`, parked
calls, a drop and the re-hold), `11-linger-and-retry.ts` (`linger`, failed references, `ref.retry()`),
`12-routes.ts` (addresses, host addresses, a route to an in-process worker, a guest's `ctx.get` through it),
`13-relay.ts` (tab, server and a forked worker over WebSocket and IPC, the worker's start data through its core
facet, §18), `14-flow-control.ts` (a slow tab: folding at the provider, and at the worker per origin through a
relay while a fast tab keeps receiving), `15-revocation.ts` (a grant revoked: its tabs' links closed, its objects on
the worker ended), `16-presence-and-activity.ts` (a viewer count from `host.references`, departures, the activity a
supervisor watches), `17-limits-and-compression.ts` (a 500 KB snapshot compressed or not, a part past a limit, a
compression bomb), `18-routines.ts` (a reconciling `on` with a retry, a periodic `onLive` with `sleep`) and
`19-jobs.ts` (a shell job with a throttled state document, per-principal views of `running`, an abort and a chained
job), and (slice 6a) `20-tables.ts` (tables, writes, pages, counts), `21-persisted-documents.ts` (documents across two
hosts on one store file), `22-migrations.ts` (`evolveTable` and an eager migration at activation),
`23-keyed-watches.ts` (`watch(key)`, `at(key)`, the `retired` flag), `24-keyed-members.ts` (a keyed member pinned per
key by its consumers) and `25-export-import.ts` (an archive in JSONL and an import), and (slice 7a)
`31-parked-dependencies.ts` (a missing provider arrives: causes shown, no timers) and `32-startup.ts` (two hosts that
would have deadlocked at startup).

## For Chord's layers (`internal.ts`)

For `remote/`: `ChordHost` (`place` decides where an arriving hold goes, here or relayed over a path; `serving`
finds the object a hold placed here binds to; `relays` and `relayOrigin`, the origins this host relays holds for by
their number; `published`, `index`/`unindex` (the unbound index), `closing`, `linkOpened`, `unlink`), `AnyHost` (a host whatever its principal type: `ChordHost<P>` is invariant in `P`),
`Target` (what a binding is bound to, implemented by `ChordObject` and by `remote/`'s `RemoteObject`),
`ChordObject` (`state`, `retry`) and `Holder` (what holds an object: a binding, or a hold over a link: `moved()` when
the object's `state` changed, which a new holder also reads itself; `end(error)`), `Binding` (`moved`, `end`),
`CheckedParams`, `Caller` (principal and incarnation of a reference's maker or a hold's origin), `RefState` with `LOADING`, `LIVE`,
`RetryWalk` and `retryWalk` (one retry's walk on this host, with its hop budget), `Serving` (what a hold placed here
binds to, or why it waits) and
`UnboundRequest` (what the unbound index holds). Also on `ChordHost` for `remote/`: `revoke` (a parent's `revoke` message), `compression`, `count(kind,
delta)` (the keep-alive counts), `cycle(chain, id, closing)` (the `invalid/cycle` error naming a chain by labels),
`unplaced` (the path of remote references failed for a part past the limits) and `pathOf(Type, params, principal)`
(placing one anew on `retry`).

Inside the directory: `ChordHost` (types, objects by identity, facets, the batch, the backoff map, the endings new
instances wait for, its links and the heartbeat timer, its routes and the parent path, the publication and the
unbound index; `reference` makes a request's binding, `bind` binds it to an object here or a remote object over a
path or leaves it waiting, `acquire` gets one for a caller), `UnboundIndex` (requests that cannot bind yet, by name),
`checkDependencies` and `ParkedLong` (what a parked attempt's dependencies say; the `parked_long` report),
`Destination` (where a reference or an arriving hold goes, by address: here, a route's path or the parent's; whether
a hold served here is placed here), `Route` (one per routed kind: per address its `Path`, at most one running
`resolve`, the backoff per address; an address is kept while it has holders, a link or a running `resolve`),
`ChordObject` (one per identity: its state across attempts (what a parked attempt shows), its first outcome, holders,
retries passed on while parked, cycle checks with its instance id and the chain it was created for, lingering, ending and revocation, the count of its running and finishing job runs,
which keeps it like a reference: `countRuns`, its contributions while live and its wake signals), `RetryWakes` (an
object's `retryOn` subscriptions), `RootScopes` (the open `host.root` scopes, sealed once each), `Activity` (`host.activity`: counters, one
publication per microtask turn), `References` (one type's presence list), `RevocationKeys` (each principal's keys,
in a `WeakMap`),
`Attempt` (one activation: it is the
factory's `self`, runs the steps with their failure kinds, takes the calls, starts its routines and jobs once live,
drains and closes), `Routines` (an owner's routines: declared, then started once for a `RoutineOwner`; each `on`
follows its source with a watch whose listener never throws and never waits: it keeps the newest frame, JSON ops
folded by Delta's `PendingOps`, and the routine makes one call at a time from it, the first call and retries
included; its state is tagged: starting, idle, calling, backoff with its timer, ended),
`sleep`, `NativeHandle` (one
native: opened once, closed once, a late value closed at once; `within` bounds a close or a drain), `Backoff` (the
windows per identity and when each ends, holding no object), `Binding` (a reference's link to its object or remote
object: its state, the object that declared it, its per-reference watches, calls, parked calls and the waits for a
state; released, it keeps only its name), `ParkedCalls` (a reference's queue of calls made while loading, a timer
each), `ReferenceState` (`ref.state`, a native source: its native watches, told of each change; derives over it
marked), `CallContext` (a handler's or a root scope's `ctx`), `withLinkedAbortSignal` (a call's or a get's context aborted by the caller and by a long-lived signal, its
reference's or its attempt's, linked only until it settles: `AbortSignal.any` keeps cleanup entries per call while its
sources live before Node 24.16.0), `checkImplementation` (the variant and member check), `setUp` (runs one facet's setup),
`resolveWatchable` (the member check, Q14), `contributionOf` (a contribution as Chord follows it, the cycle check), and `nextDelay` (the 1 s to 60 s doubling every backoff shares). Cycle checks follow the waits of activating objects with a visited set,
linear in the waits.
