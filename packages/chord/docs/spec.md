# Chord specification

This document specifies the runtime in `src`. Where it and the code disagree, the disagreement is a bug. [Known limitations and decisions](#12-known-limitations-and-decisions) lists what the runtime does not do yet and the choices the sections below leave open.

Hard constraints:
- Chord's runtime depends only on its own `delta` module (tracker, applyImmutable, encoder/decoder, diff) and Node/browser built-ins plus `typebox` for schemas. No other Pi packages.
- Built-in plugins are trusted, loaded from source in-process. The plugin loader uses dynamic `import()` with a cache-busting query (owner-approved exception, `TODO(loader)`: replace with an isolating, evicting loader; old module copies leak; TUI plugins need isolation).
- Hot reload is required. Host restart only for Chord/runtime code changes or host-level crash recovery.

## 1. Concepts

| Term | Meaning |
| --- | --- |
| facet | A plugin's code for one host (surface): it serves object types (`defineFacet`). |
| object type | Name + contract. `remote` (addressable from other hosts; schemas for input, variant state members, method args/results) or `local` (host-only; members may be anything, including functions and native objects, but must be listed in the contract: `method`, `opaque` or a state schema). |
| factory | `(input, principal, self) => implementation`. Synchronous. Registered with `host.serve(type, factory, options)` from a plugin facet. |
| object | One instance of an object type. Stable identity per `(type, canonicalInput, principalKey)`. Owns cells, resources, references, listeners, tasks, registrations. Survives reloads. |
| implementation | The object's code: what a factory run returns (methods + state members; `variant` for remote types). Immutable, per code version. |
| reference | What `get` returns: a late-bound claim on an object, never the object or its implementation. An object lives while referenced. |
| principal | App-defined. Stamped by links. In-host code acts as the `host` principal. |
| root | One short Chord call tree, admitted at trusted ingress (link request without root, UI event, timer, `host.root`). Carries `{ rootId, codeVersion }`. |
| code version | One committed set of implementations/registrations per host (server-issued id). |
| code holder | Long-lived execution that is NOT a root: Durable phases/tool runs, browsers, `self.task` loops. Every Chord call they make starts a fresh short root. |

## 2. Contracts

Contracts are runtime values for every type (shipped bundles have no TypeScript; third-party plugins are built separately). TS types are inferred from them.

```ts
export const Chat = remote("pi.chat", {
	version: 1,                                   // contract version: a plain number, bumped only on breaking changes
	input: Type.Object({ session: Type.String(), conversation: Type.Number() }),
	host: hostFamily("session:", "session"),       // where its objects live: `session:` + input.session
	variants: {
		viewer: { state: { view: ViewSchema } },
		participant: {
			state: { view: ViewSchema },
			methods: { send: method(SendSchema, Type.Object({ submissionId: Type.Number() })) },
		},
	},
});

export const Index = local("pi.index", {
	version: 1,
	input: Type.Object({ session: Type.String() }),
	members: {
		search: method(Type.Object({ query: Type.String() }), Type.Array(Hit)),
		onChange: method(Type.Function([Change], Type.Void()), Unsubscribe),   // non-JSON allowed for locals
		harness: opaque("pi.durable-harness@1"),                               // native object, by name+version
	},
});
```

- Input identity: normalize (apply defaults, strip unknown), validate, then canonical JSON with fields equal to their schema default omitted. Changing defaults or normalization requires a new type name.
- Remote calls validate args/results and state values at the provider boundary. Local calls are not validated per call.
- Local contracts list every member (`members: { search: method(...), harness: opaque(...), status: Schema }`). A reference that is still `loading` must know whether `h.x` is a method (a caller that waits until live), a state member (a readable) or an opaque value, before any implementation exists. Members missing from the contract are found only once the reference is live.
- Every bundle embeds the contract tokens it was built against (its own copy). Fingerprint = hash of the canonical description.
- Placement (remote types, required): `host: hostNamed(name)` (one host) or `hostFamily(prefix, key)` (the host `prefix` + the input's required string field `key`). Data only, in the description (and so the fingerprint and the `hold` token); there is no `at` option. A `get` normalizes the input with the caller's contract, resolves the host and acquires locally if that is this host, else remotely. `serve` (and a reload that loads a facet) refuses a type whose placement excludes the host's name. A host refuses a hold whose input its own contract places elsewhere (`invalid/placement`), and a relay refuses a hold whose target disagrees with its token's placement and input. Coverage requires equal placements, and an `accepts` adapter never bridges two placements: a moved type is a breaking change. A remote reference's address is the type, the normalized input and the principal: no host name.

### Compatibility rule

A consumer built against version M binds to a provider at version N iff N = M and the provider's description covers the consumer's; otherwise only through `accepts[M]` adapters declared by the provider (`serve(type, factory, { accepts: { 1: (current) => v1View } })`); else `contract_mismatch`.

Covers: every consumer member exists with the same kind; methods: both take arguments or neither does, the provider accepts every argument the consumer can send (new fields optional, nothing newly required or retyped), and the provider's result fits the consumer's expected result (extra fields fine; a void consumer accepts any); state: provider value fits consumer schema (extra fields fine); opaque: same name@version.

Additive changes need no bump. Breaking changes (remove/rename/retype, newly required, or a change of meaning with the same shape) bump the number. Same version + non-covering description = forgotten bump, refused. Meaning changes without a bump are undetectable (author's responsibility, as with Durable document versions).

Checked at: `get` binding, reload prepare (new provider token vs every surviving consumer holding the type and every loaded plugin importing it), remote references (consumer token in the `hold` frame).

The exact host-owned reference to a `lifetime: "host"` object is a lifecycle pin, not a surviving old-contract consumer. When its
provider is replaced, commit replaces that reference with one bound to the new provider contract, acquiring it before
releasing the old one so the same object, state and unchanged resources survive. It needs no `accepts` adapter
for its own previous contract. Prepare/abort do not change that reference. All other consumers retain their own tokens
and the normal coverage/adapter checks; state-version and migration checks are unchanged.

## 3. Factory and declarations

Factories are synchronous; returning a promise throws. A declaration has a name only if something of it survives a reload and must be found again: state (its value) and resources (the open value), plus listeners (a kept subscription). Names are strings, unique per object per declaration kind (a repeated name is `invalid/duplicate`); kinds have separate names. Derivations and tasks have no names: a reload makes new ones. References are identified by their address.

```ts
host.serve(StatusStore, ({ session }, _host, self) => {
	const status = self.state("status", StatusSchema, { running: false, tasks: 0 },  // schema required, initial value
		{ version: 2, migrate: (old, from) => upgrade(old, from) });                     // per cell; default version 1
	const errors = self.state("errors", Type.Array(Type.String()), []);
	const catalog = self.get(Catalog, {});                         // reference; identity = canonical address (+ at)
	const watch = self.resource("watch", {
		version: 1, deps: [catalog], exclusive: false,
		open: async ({ signal }) => openWatch(session, signal),
		close: async (w) => w.close(),
	});
	self.on("changes", watch, (w) => w.events, (event, ctx) => status.change(ctx, (d) => { d.tasks = event.tasks; }));
	self.task(async (ctx) => { /* loop until ctx.signal aborts */ });
	const visible = self.derive([status], (s) => project(s));      // synchronous
	self.register(Routes, { "GET /status": handler });              // registry keys are the registry's own keys; `lifetime: "host"` objects only
	return { status: visible, errors, report: (args, ctx) => { status.replace(ctx, args); } };  // exposed state = what is returned
}, {
	linger: 30_000,                                                  // with lifetime "referenced" (the default) only
});
```

| Declaration | Survives reload | Notes |
| --- | --- | --- |
| `state(name, schema, initial \| { init }, { version?, migrate? })` | same cell and value (`initial` ignored, `init` not run); migrated when its version rises; a cell the reload adds runs `init` at prepare (gated objects: at the gate) | Schema required (no TypeScript at runtime). `change(ctx, draft => void)`, `replace(ctx, value)`, `value`, `subscribe`. Writes through `change` touch only mutated paths. Private state is a cell the implementation does not return. `init(ctx)` (may be async) gives the first value, see activation |
| `get(type, input, { at? })` | kept if declared again (same address) | returns a reference |
| `resource(name, { version, deps?, exclusive?, open, close? })` | kept unless `version`, `deps` or `exclusive` change; a kept resource adopts the new declaration (its `close`) at commit | `open` runs at prepare (non-exclusive) or at the gate (exclusive); returns a resource whose `.value` is the open value; a replaced resource closes with its own declaration's `close` |
| `on(name, source, [select,] handler)` | same subscription while source and `select` (identity or source text) are unchanged; `handler` swapped | each event starts a fresh root in the current code version; `select` is not re-run for a kept subscription. State sources deliver their current value at start and after every reload that replaced them |
| `task(fn)` | restarted with new code at commit: the old run is aborted via ctx.signal, and the new one starts once it finished (at most `taskStopDeadline`, default 5 s, then anyway, reported) | a code holder; calls inside start fresh roots |
| `derive(sources, fn)` | a new derivation, computed at commit | synchronous fn |
| `register(registry, { key: value })` | value swapped at commit | `lifetime: "host"` objects only |
| `expose(resource)` | follows the resource | a local member (usually `opaque`) whose reference value is the resource's value once live |

State members of an implementation may be cells, derivations, or state members of references the object holds (they are defined once the object is live). `cell.replace(ctx, value, { diff? })` publishes a structural diff when the new value shares containers with the old one (or `diff: true`), else `r`. Facet `setup` receives `{ serve, name, root, registry, signal }` of its host; `signal` aborts once this run of the facet is no longer installed (a committed reload replaced or removed it, the reload that loaded it aborted, or the host closed).

`migrate` per cell is `(old, fromVersion) => new`. A cell may be several versions behind (author bumped more than once between reloads). Without `migrate`, a raised version keeps the value, which must fit the new schema.

**Listeners on state reconcile.** A listener whose source is state (a cell, a derivation, a reference's state member) is subscribed when it starts and gets the current value, then every new value. A reload that replaces its source (every derivation is new; a reference to another address is another source) subscribes it again, so it gets the current value again: its handler must reconcile (be idempotent), not count events. An event source (a resource's events, any other `subscribe`) delivers no current value; a kept subscription to it is not touched by a reload.

**Methods.** `method(args?, result?)`: without `args` the method takes none (callers `ref.name(ctx?)`, implementation `(ctx) => …`; `method(undefined, result)` for one that returns something); without `result` it is void (callers get `undefined`, whatever the implementation returned). The description records both (absent fields), and the `call` frame carries no `args` and the `result` frame no `value` for them. A consumer and provider must agree on whether a method takes arguments; a consumer without a result accepts a provider's.

Removed vs guide: `self.own`, `holdWhile`, async factories, inferred dependencies.

### Synchronous factory, asynchronous activation

`self.get` and `self.resource` only declare and return placeholders. Activation of an object:

1. run the factory synchronously (declarations);
2. await declared resources' `open()` (e.g. connect a DB);
3. await declared references becoming live (dependencies activate first, coalesced);
4. run the `init` of every cell declared with one, in parallel, each in a root of its own acting as the host principal; validate and install the values;
5. attach derivations, start listeners and tasks;
6. object is live: references `live`, `ready` resolves.

Inside the factory, placeholders must not be used (`resource.value` and an `init` cell's `value` throw `not_ready`; reference calls throw). An `init` that throws, or returns a value its schema refuses, fails the activation like a failed `open`. An `init` must not wait for its own object or one that holds it (it is not live yet), and must not read another `init` cell of its object (they run in parallel). `init` gives a first value from a source the object reads anyway; it does not persist anything, and a cell is not saved anywhere by having one. Methods/listeners/tasks run only on live objects, so their dependencies are live. An object goes live only once its references are ready (live and, for remote ones, hydrated) and the state sources it exposes or derives from have their values, also where they forward a remote reference held some other way; waiting for references is bounded by the host's `readyTimeout` (default 60 s, `unavailable/ready_timeout`, also for a reference cycle across hosts). External consumers holding a `loading` reference (`host.hold`): calls wait until live (ctx cancellation, deadline); state members throw `not_ready` until the first hydration. Activation failures propagate to dependents and all waiting gets; the next get retries.

### Lifetime

`serve(type, factory, { lifetime })`:

| `lifetime` | Created | Ends | `linger` |
| --- | --- | --- | --- |
| `"referenced"` (default) | at the first `get` of its address | after the last reference is released, plus `linger` | allowed (default 0) |
| `"host"` | when its facet loads (or at `serve`); loading waits until it is live | when the host closes, or a reload removes its facet | refused |

- `"host"` is refused at `serve` for remote types, for an input that does not accept `{}`, and together with `linger`;
  the types (`ServeOptionsFor`) refuse the same at compile time, where such an input is one with a required field.
  The type has exactly one object: the empty input (defaults applied), created for the host principal. Every `get`
  reaches it, whatever its principal (the factory sees the host principal); a `get` with another input is
  `invalid/input`. Other references do not change its lifetime: the host keeps its own until it closes.
- Only `"host"` objects may register (`invalid/not_host_lifetime` otherwise).
- A `"host"` object whose activation fails is started again by the next reload that changes its type. A reload that
  makes a type `"host"` creates its object; one that makes it `"referenced"` releases the host's reference, so the
  object lives on only while others reference it.

### Host objects readiness

- `host.install(facet, { awaitHostObjects? })` installs declarations synchronously and returns a promise for this
  facet's host object activations. `host.load(facets, { awaitHostObjects? })` installs the entire batch before awaiting
  its host object activations. `awaitHostObjects` defaults to true. Unreferenced objects are not activated.
- Factory, resource-open, dependency and activation-finalization failures reject the returned promise with the
  activation error (ChordError codes preserved; ordinary errors wrapped as `unavailable`). Host object failures also
  reach `onError`. Installation is not a rollback transaction; setup/registration errors from `install` throw
  synchronously. Abandoned startup should close the host.
- `{ awaitHostObjects: false }` starts the same host objects but resolves after installation, without waiting for
  their activation. `host.ready()` awaits a snapshot of the host's references to its host objects at call time
  (including direct `serve` and deferred loads), rejects their activation failures, and does not acquire additional
  references. It is not an ongoing health check and does not await task completion or remote state hydration.
- Local bootstrap readiness and upstream admission are separate. A worker connects its upstream link, loads with
  `{ awaitHostObjects: false }`, awaits its local bootstrap reference (e.g. Harness, with no upstream dependency), then
  announces control readiness so its parent can accept the link. Only after admission does it await `host.ready()`.
  Otherwise a host object reporting to the server's SessionStatus deadlocks with the parent waiting for control
  readiness. Deferred loads skip the whole barrier, not selected dependencies; callers explicitly choose local
  bootstrap references, keep bootstrap busy until full readiness, and propagate later startup errors.

## 4. Principals, variants, references

- Principals are the app's type `P` (`createHost<P>`, `Host<P>`, `defineFacet<P>`, `Factory<C, P>`, `Ctx<P>`; default `unknown`). Chord invents none: `createHost({ self })` is the principal of the host's own code (roots, code inside objects, `lifetime: "host"` objects), `connect(link, { principal })` what the parent's own requests act as, `accept(link, { principal })` what a link acts as, `Route.principal(hostName)` what a routed host acts as when it calls back. All are required.
- `createHost({ principalKey })` maps principal to a key that includes connection provenance and grant revision. Objects are per principal key. The host's own principal is recognized by key (`principalKey(p) === principalKey(self)`), not by object identity, so an equal principal never creates a second object.
- Remote factories return `{ variant, ...members }`; `variant` must be a declared variant; members must match it. Local factories return any object. `variant` is reserved as a member name.
- Reference: `status` (`loading | live | released | gone`), `ready` promise, `variant`, `shape` (`{ variant, members, contract }`), `onStatus(listener)` (every status change, with the error for `gone`), late-bound members, `release()`. `self.get` is synchronous (the object goes live after its references are ready); `ctx.get` and `host.get` resolve once the reference is ready: live, and every state member of its variant hydrated (`state: false`: live only). They reject with the activation error, `aborted` (ctx aborted or settled, `signal`), or `unavailable/ready_timeout`, releasing only that reference. `host.hold` is the synchronous form for UI runtimes. A held remote reference stays subscribed to its variant's state until released; after a link loss its last values stay readable while it re-holds. State members are typed `T`; reading before the first hydration throws `not_ready`, outside the variant `not_in_variant`, after the end the end's error. A remote reference type is a union discriminated by `variant`. Shape changes (reload, variant) are pushed; members missing from the current variant reject `not_in_variant`; released references reject `released`; forced disposal makes references `gone`.
- Shared bindings: remote references on a host with the same key (type, normalized input identity, principal key, consumer contract fingerprint) are views onto one binding: one hold, one stream per state member, calls over that hold. Views have their own owner (object, call, external), status, observers and `release`; the binding ends (gone) or re-holds for all of them. Without views a binding closes, or lingers for `linger.types[typeName]` ms (`createHost({ linger: { types, cap } })`, at most `cap`, default 4, least recently released first) while staying held and hydrated.
- Methods are `(args, ctx) => Promise<result>`. Factories still check arguments; variants are not complete authorization.
- Revocation: `host.invalidatePrincipal(match)` force-disposes matching objects on this host and propagates over links; links re-stamp or close.

## 5. Lifetime

- Reference owners: object (declared `get`), call (`ctx.get`, released at settle), connection (remote references; relay maps per origin connection), host (`lifetime: "host"`), UI.
- Activation coalesced per address; if all requesters leave before it completes, the result is disposed. Factory throw: unwind declarations, reject gets, next get retries.
- Disposal after the last reference is released + `linger`: tasks aborted, listeners removed, resources closed (reverse order; all run; errors aggregated), the object's references released (cascade).
- Bulk forced disposal (`host.close`, `invalidatePrincipal`) goes in waves, referrers before what they reference, so a resource's `close` can still use its object's references; `host.close` closes links after the objects.
- Forced disposal: references `gone` immediately, new calls rejected, in-flight call contexts aborted, then cooperative cleanup.
- Reference graph acyclic in-host (checked at get); across hosts by convention.
- Links have ping/timeout; a dead link releases everything held through it.

## 6. Roots and code versions

- `Ctx = { signal, rootId, codeVersion, get(...): Promise<Ref>, principal? }`. Explicit; no AsyncLocalStorage dependency (may be used in dev to warn).
- A link creates a root for a request that carries none; nested remote calls carry `{rootId, codeVersion}`.
- Dispatch: a call with code version E runs the object's implementation for E. A host retains at most `current` and `previous` code versions (two-version rule). A call for a code version the host doesn't have (older than previous, or host started later) is rejected `superseded` (retryable by starting a new root). Never substitute another code version.
- Browsers never carry code versions into the server: browser calls start roots at the server. Browsers learn of changes via shape/reset pushes and a server `Manifest` object; incompatible contract fingerprint -> `upgrade_required`.

## 7. Reload

Explicit trigger (`reload_plugins` tool, button, API). Serialized; no nesting.

1. Build/type-check gate (application tooling, outside Chord): dependency-closed set; refuse breaking remote contract changes without a contract version bump.
2. Load: on every affected host, import new facet modules (cache-busted).
3. Prepare: for each live object of each affected type, run the new factory in recording mode: existing cells readable, writes throw; listeners/tasks/registrations recorded, not started; references recorded; non-exclusive resources whose name is new or whose `version`/`deps` changed are opened as candidate-owned (closed on abort). Validate keys, variants, registry collisions. New objects activated during prepare use the current code version (old code). Any failure: abort, discard candidates. Vote.
4. Gate (only objects with a cell whose version was raised or which replace an exclusive resource, plus objects depending on those resources):
   - Admission cut: from now, an old-code-version root that has not touched the object gets `upgrade_conflict` (retryable), not queued. Roots that already hold an activation lease on it are grandfathered; their re-entry is admitted.
   - Wait for grandfathered activations to finish, deadline (default 5 s). Missed deadline: abort the reload, reopen, nothing changed (report blocking roots).
   - Exclusive resources: close old, open new; on failure reopen old and abort.
   - Run `migrate` into private copies; validate.
5. Commit (server commits itself, then sends commit to children; the decision is not persisted, see section 12; FIFO links guarantee no host receives a new-code-version root before committing): each host in one synchronous step installs migrated cell values and cell versions, installs implementations as code version E', swaps registry tables, restarts tasks with new code, rebinds listeners, pushes shape/reset to subscribers, opens gates. E' current, E previous.
   The coordinator's result carries `children`: each participating child's prepared report (its vote).
6. Retire: when no roots of `previous` remain (and, on a child, the parent retired it), drop its implementations and release declarations only it declared. The next reload first waits for that, at most `retireDeadline`; then it aborts the roots still running on `previous` (their ctx signals), gives them up to 1 s to stop, and retires anyway. A coordinator retires before it sends `prepare`, so its `retire` frames reach the children first.

Compatible changes (no state bump, no exclusive resource change) skip the gate: no waiting.

State compatibility rule: reload prepare compares each cell's old and new schema and version. Unchanged: compatible (no gate). Version raised: gate + `migrate` (or the kept value), validated against the new schema. Schema changed without a raised version: reload refused. A lowered version: refused. A change of meaning with an identical schema needs a bump too (undetectable; author's responsibility). Initial values and migrate outputs are validated; per-write validation in dev mode.

## 8. Registries

```ts
export const Routes = defineRegistry<RouteHandler>("http.routes", { conflict: "error" });
self.register(Routes, { "GET /download": handler });       // in a `lifetime: "host"` object; keys are the registry's keys
host.registry(Routes).get("GET /download", ctx);            // table of ctx.codeVersion (or current without ctx)
host.registry(Routes).subscribe((table, codeVersion) => ...);     // bridges for imperative consumers (Durable)
```

Per-code-version immutable tables; order = first registration order, kept on replace. An application can implement Durable's `RegistryReader` from the table (snapshot per code version) so phases pin a complete snapshot; Chord does not ship that bridge.

## 9. Hosts and links

- `createHost({ name, self, principalKey, upstream?: { link, principal } })`; `host.accept(link, { principal })` for children; `host.connect(link, { principal })` for the parent; `host.route(prefix, { authorize(principal, hostName), resolve(hostName) => Promise<Link>, principal(hostName) })`.
- Links: `memoryLinkPair()` (tests), Node IPC (child_process), WebSocket (server `ws`, browser `WebSocket`).
- Principal stamping: the accepting side stamps the principal of what connects (from its authenticator); forwarded principals accepted only from the parent link; the parent's own requests (no forwarded principal) act as the principal given to `connect`; payload principal fields ignored.
- A child that connects behind its parent's code version is fenced (nothing routed to it) and reconciled by a reload of its modules to the parent's code version. Calls its roots of the old code version make upstream are admitted in the parent's current code version (the parent never ran that code version), not rejected `superseded`.
- Relay: server forwards a hold to the child link of its target host (`at`, resolved by the consumer from the contract's placement and the normalized input, and checked against both), mapping references per origin connection; authorizes before resolving/spawning and re-checks after.
- Wire frames (JSON): `hello`/`bye`, `hold`/`release` (a reference over a link: `hold` returns `shape` or `gone`; there is no separate `get`), `shape`, `call`/`result`/`cancel`, `sub`/`unsub`/`resync` and `state`, `gone`, `root_end`, `retire`, `invalidate`, `ping`/`pong`, `ack`, reload control (`prepare`/`vote`/`commit`/`abort`).
- State: a `hold` implies the state of its variant (`state: false`: none until `sub`; `unsub` stops it). The provider answers with units: a `shape` whose `state` lists the members the consumer lacks, followed by one `state` frame `as: "snap"` per listed member; the consumer applies the shape once those snapshots are here. Later `state` frames of a member (addressed by hold id and member `m`) are `ops` (per-stream delta encoder), `reset`, or `error`; a `snap`/`reset` without `value` carries `undefined`. A failed snapshot before the first hydration ends the reference with its error. A reload or variant change sends a unit with the members that are new; members that left stop. `again` marks a re-hold after a link loss (the consumer has values). `origin` names the client connection a hold comes from (stamped by the host that accepted the client, forwarded by relays, honored only from the parent link).
- Protocol version: `hello` carries `protocol` (`PROTOCOL_VERSION`, now 4; absent means 1). A side that sees another version processes nothing more, calls `LinkOptions.onProtocolMismatch({ local, peer })` and closes the link with reason `protocol-version <its version>`; the other side's connection reads that reason and reports the mismatch too. Peers do not negotiate: the outdated side must load the current code (a browser reloads its page). Frame fields follow the version: the `shape` frame names the variant `variant`, code versions travel as `codeVersion` (2); remote contract tokens carry their placement (`host`), and a `hold` carries the input normalized by the consumer (3); a hold implies its state, units, `origin`, and `shape` without a code version (4).
- Flow control: both ends announce `acks` in their hello and acknowledge what they processed (`ack`, a cumulative count of every frame but `ack`). While the frames not yet acknowledged exceed the window (`window`, default 256 KiB of JSON text), state waits at the sender in slots flushed in creation order: one per member stream (ops are appended, a snapshot or reset replaces it, a release or `unsub` drops it) and one per hold for a unit (lazy: built from the current values when sent; a newer unit merges into it). Waiting ops are capped per link (`pendingCap`, default four windows): beyond, the oldest streams become a reset of their current value built at flush (a relay sends `resync` downstream and drops that member's ops until the reset arrives). The first unit of a hold that is not `again` and every frame but state are sent at once. Links that report no frame sizes (IPC) are never windowed; a peer without `acks` is neither windowed nor acknowledged. An acceptor can limit the calls a peer has in progress (`maxCalls`); calls beyond it are answered at once with `unavailable/too_many_calls`. Nothing outside the connection may add frames to a link: acknowledgements count them.

## 10. Host manager (library)

`createHostManager({ driver, keepAlive })`: fork driver (entry, init, lock, env), serialized start/stop/replace, exit-before-replace, process-tree kill after grace, control channel (ready/fatal/shutdown), liveness callback (booting, activeCalls, viewers with heartbeats, durable tasks, idleFor).

## 11. Test coverage

The tests cover at least: lifetime/references/linger/forced disposal/gone; activation coalescing and abandonment; principals and variants; remote calls over memory links incl. relay and principal forgery attempts; state snap/ops/reset over a link with reconnect; registries per code version; reload: compatible (no wait, pinned roots), prepare isolation (writes throw, failing factory leaves everything unchanged), state bump with migrate and gate, `upgrade_conflict` for late old roots, deadline abort, exclusive resource replacement, cross-host commit ordering, two-version retirement and `superseded`.

## 12. Known limitations and decisions

### Still open

- **Retirement across hosts.** A child retires a code version only after its parent retired it (`retire` frame) and its own roots of that code version ended; the server decides from its own roots. A child that comes in step (hello or reconciliation) is told which code versions the parent retired before. A root started on a worker that calls up to a server which has already retired the code version both had still gets `superseded` (retryable).
- **The commit decision is not persisted** (section 7, step 5). A server crash between its own commit and a child's commit leaves that child on the old code version until it reconnects and is reconciled.
- **One level of reload participants.** Only the coordinator's direct child hosts take part; a child does not forward `prepare` to its own children.
- **Reconciliation needs the child's module list.** It is remembered from cluster reloads (`host.remoteModules`), so a server restart forgets it, and a child behind a restarted server then reloads no modules: it gets the code version id with its own code. The reconciliation vote deadline is fixed at 30 s; a failed reconciliation closes the link, so the host manager restarts the worker.
- **Links do not resume.** The provider releases everything held through a closed link at once, so re-held objects are new ones. Keeping references for a reconnect window would need session ids on links. Calls in flight when a link drops reject `unavailable`; whether they ran is unknown.
- **Refused clients cannot tell.** The WebSocket adapter closes unauthenticated sockets; the client sees a dropped upstream and its calls wait for a reconnect until their ctx is aborted.
- **The publication queue is process-wide and synchronous.** A slow observer delays every later notification in the process, including those of other hosts in the same process.
- **No automatic restart.** A terminal host failure is picked up by the host manager's `keepAlive` or `fatal` path, not inside Chord.
- **The Node loader leaks.** Every reload imports fresh module copies that are never evicted, and it does not isolate plugins (`TODO(loader)`).
- **Stale socket locks.** On Unix systems other than Linux, two processes that probe the same stale socket file at the same moment could both take the lock. Managers serialize starts per lock name.
- **Listener `select` identity.** A listener's subscription is kept across factory runs when its origin and `select` are unchanged; `select` counts as unchanged when identical or with the same source text, so a `select` whose implementation depends on captured values that change between runs is not detected.
- **Shutdown and dead links.** `host.close()` disposes objects in waves (referrers before what they reference) and closes links last. A `close` that awaits a remote call over a link that is already down waits for a reconnect; bound such calls.

### Decisions

- **Errors.** The guide's codes; a `reason` field carries the detail, for example `invalid/args`, `invalid/cycle`, `invalid/duplicate`, `invalid/read_only`, `invalid/not_host_lifetime`, `invalid/registry_conflict`, or `unavailable/unknown_type`. A `ChordError` thrown by a factory or a dependency keeps its code through every dependent; other errors become `unavailable`, with the original as `cause`.
- **Reload errors.** There is no `reload_aborted` code. A failed reload throws the cause's code and reason with the message `reload aborted: …` (the cause is attached). Reasons of its own are `aborted/gate_deadline` (with the blocking roots in `details`), `aborted/deadline`, `aborted/vote_deadline` and `unavailable/reload_running`. Across hosts, the message names the host that failed. A child cannot reload on its own (`unavailable/not_coordinator`).
- **New objects during prepare.** A reload pre-allocates the next code version ("pending"). Types the same reload adds are served from it; their objects install implementation only for the pending code version and are force-disposed if the reload aborts.
- **Gate admission.** From the gate until commit or abort, creating a new object of a changed type fails with `upgrade_conflict` (retryable, reason `gate`); nothing is paused, so nothing can deadlock. Gated objects get `minCodeVersion = E'`: calls and writes carrying an older code version are rejected `upgrade_conflict` permanently, and a gated object drops its previous-code-version implementation at commit. Only objects whose cell versions or exclusive resources change are gated.
- **Tasks and listeners during the gate.** Tasks of gated objects are aborted at the admission cut and restart with new code at commit, or with the old code on abort. Listener events for gated objects are queued and replayed through the new listener at commit, or the old one at abort.
- **Grandfathered roots** are the roots that called into the object and are still running at the cut. Every host remembers on which links a root's calls went out and sends `root_end` on them when the root ends, so leases outlive calls across hosts.
- **Removed types and missed retirement.** Objects of removed types are force-disposed at commit. When a retirement deadline is missed, retirement is forced: those roots are aborted first (their ctx signal, reason `superseded`; a relayed call's root cancels its downstream call), then what only that code version declared is closed, and their next call is `superseded`.
- **Joining during a reload.** Participants are the child hosts in step when a reload starts. A child whose hello arrives while it runs is decided when it ends: in step, or reconciled to the committed code version; a child already behind is fenced at once, so the calls its roots make meanwhile are admitted in the parent's code version. A reconciliation that is running when a reload starts syncs its child only after that reload ended, against the code version it committed. A reconciliation announces the parent's retired code versions before its `prepare`.
- **Two-version rule.** An object of a changed type created after a commit has only new code; a previous-code-version root calling it gets `superseded`.
- **Validation.** Remote calls are validated at reference dispatch, in-host too: a direct binding against the provider's schema, a binding through an adapter against the consumer's. A provider validates each snapshot and reset of a remote state member once per (re)subscription, against the consumer's contract through an `accepts` adapter and the provider's otherwise; ops are validated only in dev mode. At reload, the new provider's description must cover the old provider's when the version is unchanged, in addition to the check against live consumers and facets' `uses`.
- **Contracts.** Local contracts list their members, so a loading reference knows whether a member is a method, state or opaque. Canonical identity omits input fields equal to their default; with TypeBox, use `Type.Optional(Type.X({ default }))` to let callers omit them. Provider variants must cover consumer variants; members the consumer's contract does not list are hidden. Schema change detection compares canonical JSON, so reordering `anyOf` branches counts as a change. Fingerprints use a non-cryptographic 64-bit hash: synchronous and browser-safe; contracts are trusted.
- **Principals.** A root ctx at ingress acts as its principal (`host.root(fn, { principal })`); contexts inside objects act as `host`. The acceptor decides a link's kind and name (`accept(link, { principal, kind, name })`); only configured host links are addressable, carry roots and may vote, and control frames are accepted only from the parent. Clients never carry roots or code versions. Relaying needs a matching `route`; `authorize(principal, hostName)` runs before `resolve` and again after, and revoking or re-stamping a principal closes its relays at once. `invalidatePrincipal(match)` re-stamps or closes matching links and propagates pattern matches to child hosts.
- **Cells and readables.** A value returned from `change` replaces the value and is always validated; `replace` transfers ownership without copying; by default (`{ diff }` overrides) it publishes a diff when the new value reuses a container of the old one at the same key, else `r`. `subscribe(fn)` delivers values, starting with the current one; `events(fn)` delivers `snap`, then `ops`, or `reset`. Reference state members are stable readables that throw `not_ready` while loading and `not_in_variant` outside the variant, and reset when their source moves; a listener added before they are readable gets its snapshot then. Remote state members stay hydrated while the reference is held.
- **References and calls.** A reference's identity is its address; a second `self.get` of the same address in one run returns the same reference. A reference call without ctx, or with a task ctx, starts a fresh root in the current code version; a ctx whose call or root already settled is refused (`aborted/expired`), one from another host `invalid/foreign_ctx`. Calling a reference inside a factory throws `not_ready`.
- **Resources and disposal.** New and replaced exclusive resources open at the gate, and so do non-exclusive resources of the same object that depend on them. A new object for an address that is still being disposed waits for that disposal. A resource open that completes after its signal aborted closes its value at once.
- **Links and the host manager.** Every received frame is validated against its schema; malformed frames, duplicate ids and control frames from the wrong side close the link. Each connection pings every `pingInterval` and closes after `pingTimeout` without a frame. The child holds a kernel lock (an abstract socket on Linux and Android, a named pipe on Windows, a probed socket file elsewhere), acquired by `childControl().lock()` before storage opens. The manager kills the child's process group on every exit path and derives `booting` and `idleFor` from the child's liveness reports. WebSocket support is structural, so Chord does not depend on `ws`.
- **Flow control holds back state only.** A relay (Cloudflare to a browser) can hide a slow reader, so transport backpressure cannot be relied on; acknowledgements are end to end. Results must not wait behind state, so links are FIFO except that waiting state frames can be overtaken: a result may arrive before state changes made before it. Frames of one subscription stay in order. Waiting state is coalesced rather than queued and capped per link, so a stalled peer costs bounded memory, and the next frame it gets is current. The first unit of a new reference is not held back, so a `get` never waits behind other streams.
- **The state API stays.** Objects keep named cells and unnamed derivations; giving each object exactly one state value was rejected. Do not reopen this without a new, concrete problem.
