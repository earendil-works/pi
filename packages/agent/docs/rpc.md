# Facet Service RPC

Chord owns the application-neutral service semantics and pluggable strict-JSON connection
boundary. Pi owns the concrete wire envelope, routing, attachment state, and error adapters
described here. The current implementation treats `JsonValue` as a static contract and defers
runtime rejection of unsupported values to the concrete serializer.

> **Status:** Design specification for experimental facet-service RPC semantics.

## Role

`provide()`/`use()` and `provideMany().spawn()`/`observe()` are the facet system's hidden RPC. Facets share TypeScript service contracts, while the transport carries service/member identifiers, strict JSON values, request/subscription correlation, keyed generations, and binding control messages. Hosts construct the typed local implementation or facade; TypeScript types and arbitrary objects never cross the wire. Independently loaded processes may temporarily run different source generations, so their service contracts must remain forward compatible across the supported skew window; version negotiation remains deferred.

```text
session/server facet: provide() / provideMany().spawn()
                    ↕ hidden service RPC
presentation/session facet: use() / observe()
```

The service system is the extension boundary. Presentation facets receive semantic services and replicated state; they never receive a raw Harness, Session, tool registry, hook registry, credential store, or storage handle.

## Non-goals

Do not serialize `Context`, `AbortSignal`, telemetry objects, callbacks, tools, hooks, functions, or arbitrary object graphs. Do not make core Harness or Session implementations aware of transport mechanics. Do not make disconnect perform durable or service-owned cancellation. Do not build per-method codecs for values already constrained to JSON.

## Service contracts and typed facades

A service token is a shared TypeScript contract and stable service ID. It is not a generated descriptor and creates no provider. Tokens are remotely publishable by default; process-local tokens declare `{ local: true }`. `provide()` adds one singleton implementation to the host graph. `provideMany()` registers one multi-instance service owner during facet setup and returns a `ServiceSpawner` whose later `spawn()` calls publish instances. The host automatically publishes every non-local provision. A token has one mode in one host service graph: mixing singleton and keyed use is an error.

The provider classifies every exposed implementation member as a method or Chord-created `ReplicatedState` and publishes that member table in subscription snapshots. The consumer obtains member names from ordinary property access—for example, a JavaScript `Proxy` receives `"state"` for `models.state` and `"refresh"` for `models.refresh(context)`. Accessed slots are validated against the provider-announced kind when the facade binds.

Local and remote `use()` both return a stable, lazy typed facade shared by consumers of that token. During synchronous facet setup the facade is disconnected, so setup can capture it but cannot invoke methods, read state, or register member subscriptions. After assembly, a local facade resolves through a direct process-local implementation slot and a remote facade binds through the host's connected services. Reloading the providing facet temporarily marks that same facade unavailable, then swaps its target; RPC singletons clear readiness and install a complete replacement snapshot on their existing subscription so captured methods and member facades address the replacement. While no provider is bound, invoking a method fails and state remains unhydrated; no call is queued merely because it was made through a proxy.

Remote methods return promises and accept and return strict JSON apart from their declared `Context`; `void` is a successful response without a result field. Private returned references are not supported. The client removes the context before transport and the receiving host constructs a fresh local context. The contract position is host-controlled and must be consistent; the examples use one required trailing `Context`. Business absence is JSON `null` or an options object, never transported `undefined`.

Use static assertions and runtime validation. Static checks constrain remote methods and replicated-state members; runtime boundaries reject unsupported members and non-JSON arguments, results, and state values. TypeScript supplies typed facades but does not authenticate a peer or create runtime metadata.

`{ local: true }` removes only remote publication and its wire-contract restrictions. Local and non-local provisions otherwise use the same dependency ledger, activation order, stable singleton slots, keyed-instance generations, observer cancellation, disposal, and provider-facet reload. Local singleton slots and the local keyed registry hold arbitrary object contracts directly; non-local provisions additionally install their implementations in the remote provider.

## Dependency ledger

Type erasure does not hide service identity: every service token retains its stable ID at runtime. Facet environments are created by the host with a non-forgeable owner identity, and their setup-time service methods append to a generation-scoped ledger:

- `provide()` records a singleton provision;
- `provideMany()` records a keyed provision;
- `use()` records a singleton requirement; and
- `observe()` records a keyed requirement.

Facets always call unqualified `env.use()` or `env.observe()`; routing is not encoded in the call. These operations return source-independent disconnected handles during setup. After setup, each connection returns its provider-generated service catalogue, and the host binds every requirement to its local provision or exactly one connected provider. The method supplies the mode and the token supplies the ID. The host therefore needs no reflection over the erased `T` and no handwritten parallel dependency list.

First acquisition or provision is permitted only during facet setup. Later commands, hooks, and activation callbacks use setup-acquired singleton facades, observer registrations, or `ServiceSpawner` capabilities. In particular, dynamic instances are spawned through the capability returned by `provideMany()`; late spawning cannot introduce a previously undeclared provision.

After setup, each host privately resolves the recorded requirements against local provisions and connection catalogues to reject missing providers, duplicate remote offers, and mode mismatches and to derive lifecycle edges. A selected-Session connection with no live attachment may provisionally accept unresolved requirements as unavailable; attachment validates them against the worker's generated catalogue and caches that catalogue for later detached generations. Connection bindings are generation-owned and include only selected requirements, so failed or retired generations release their subscriptions without disposing the underlying transport connection. This internal service graph is distinct from the module loader's source import graph; it is not a facet-authored or facet-visible plan.

## Bindings and identity

A presentation host combines services from its connected server and selected Session in one graph. All of its facets use the same unqualified environment API. A Session-service call never accepts a client-selected durable `sessionId`; the server authorizes and routes the presentation's selected Session binding to its worker.

### Server control plane

Session listing and management are ordinary server singleton services, not generic remote `Session` methods. `SessionDirectory` exposes presentation-safe session summaries as replicated state. `SessionManagement` exposes `create`, `remove`, `attach`, and `detach` methods. A TUI or web facet consumes both through its environment:

```ts
const directory = env.use(SessionDirectory);
const management = env.use(SessionManagement);
```

The server binds one service provider to each presentation connection. It derives workspace and client authority from locally authenticated connection identity, not from summary fields or method arguments. It may project directory state per client; either way, summaries never expose server-private fields such as owner IDs or working directories.

`management.attach(sessionId, context)` changes the selected-Session services in the presentation host. The server closes the presentation's previous Session-scoped requests, subscriptions, and observer tasks, binds the presentation's Session services to the worker, then hydrates their singleton state and keyed-instance directory. The server authorizes the selected Session against the connection identity. Attachment state is host control state reporting this selection and its health; it is not a directory service. `detach()` performs the same cleanup without a replacement.

The host needs a private, host-owned binding incarnation for that route. It changes when the presentation attaches, detaches, switches session, or replaces a failed worker. Its representation is deliberately unspecified. The binding prevents a delayed frame for the old selected session from being applied to the new one; it is not a facet-visible service value or a substitute for authorization.

A replicated-state source has structural identity:

```text
(provider binding, service ID, optional instance key + generation, member name)
```

There is no separately discoverable state ID. An added instance key is an application-level logical key. Its host-owned generation changes when a closed key is reused, so a stale proxy cannot call the replacement. `requestId` identifies one transport invocation for response and cancellation. A Harness/tool `invocationId` may be a useful instance key—as in the question example—but it does not replace the service, binding, or generation parts of the live address.

## Calls, context, and routing

A call carries enough control-plane information to select a provider binding, service, optional keyed instance, and member, plus a request ID, JSON arguments, and trace carrier. The server may parse those control-plane fields to route a Session call, but it does not parse facet business payloads or load facet contracts. The service endpoint validates the member and values, creates a request-local abort controller and `Context`, installs authenticated identity, and invokes the local implementation.

The client maps `context.abortSignal` to cancellation of that one request. Disconnect cancels that connection's active calls and closes its subscriptions. Neither action cancels service-owned work or writes durable Harness cancellation. Per-client request correlation reaches the worker so request IDs from different presentations cannot collide.

## Replicated state and keyed instances

`ReplicatedState` is authoritative latest-value replication, not event history, durable storage, a CRDT, or multi-writer state. A cold replica has `value === undefined`; subscribing before hydration records a listener without invoking it. Hydration installs a complete snapshot atomically before later updates are delivered, so there is no snapshot/update gap. Once hydrated, `value` is synchronous and subscribing reports the current value followed by later updates. The first snapshot callback uses a fresh hydration context; an already hydrated replica uses a fresh local delivery context rather than retaining the original write context. State values are borrowed immutable JSON and are not defensively cloned; callers must not mutate or retain them.

Remote hydration uses a fresh delivery context parented to the subscription, while updates reconstruct fresh delivery contexts from source trace metadata. Disconnect, provider withdrawal, replacement, and route switching clear readiness. Reconnect or replacement installs a complete snapshot before later updates. The transport buffers updates that race hydration and checks their sequence. Acknowledgements, flow control, and gap recovery remain separate protocol mechanics.

`observe()` is keyed-instance discovery, not a `ReplicatedState` containing proxies. It reconciles a complete initial directory with ordered additions, replacements, and removals. Each instance's initial state members hydrate before its observer task starts. Closing an instance rejects new calls, aborts only that instance's observer task, and allows admitted calls to settle. A Session facet's `env.observe()` registration aborts old tasks when that facet generation closes; the replacement generation reconciles the fresh directory.

## Private returned references

Private returned references are outside the initial service contract. Prefer keyed services for discoverable live instances. If a concrete feature requires caller-private remote identity, its reference must be passed explicitly rather than discovered by `observe()` and scoped to the recipient and provider binding.

No generic Harness projection is part of this design. Raw Harness, Session, lane, tool, hook, and storage objects remain local authority. If a future integration needs a remote callback or a general object capability, it needs a separate explicit protocol and policy; it is not an extension of service RPC.

## Context, cancellation, and telemetry

Every remote method receives a fresh local `Context`; the sender's object, signal, telemetry implementation, and arbitrary typed values never cross the wire. The client maps the call's abort signal to that request and injects a trace carrier. The endpoint constructs a request-local abort signal and telemetry parent. Cancellation is forwarded through the server to Session workers and remains isolated by client plus request ID.

The span relationship is:

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ service implementation
```

Three cancellation domains remain separate: aborting one RPC invocation; explicitly cancelling service-owned work such as `job.cancel()`; and durable Harness cancellation such as `requestAbort()`. Transport cancellation and disconnect perform only the first. Work that outlives a call must detach into a service-owned task with its own controller and telemetry root.

## Security and lifecycle

Only loaded service tokens not marked local may be registered at the remote boundary. Only the owning `ServiceSpawner` may spawn instances. Services marked `{ local: true }` are never discoverable remotely. Local services may use unrestricted object contracts. Remote providers validate member kinds, while concrete serializers enforce JSON business values. Clients cannot forge control envelopes as ordinary values, choose instance generations, select a different Session route in a service call, or cancel another client's request.

The server authenticates connections, authorizes attachment, and reconstructs client identity in the service `Context`. Ordinary business arguments never carry authority. Credentials, prompts, completions, tool data, filesystem contents, and other sensitive values require an explicit presentation-safe contract.

Facet environments own registrations, added service instances, observations, and resources explicitly registered through `own()`. Connection bindings own their transport subscriptions and active request controllers. Already-admitted inbound calls are not attached to the providing facet lifecycle: provider withdrawal rejects new calls, but an admitted method may continue while the old facet deactivates. The provider's own Session work remains alive unless its lifecycle policy stops it.

## Tests

The facet-facing semantics are tested over loopback and framed transports:

- setup-time dependency-ledger ownership, rejection of late acquisition, local and remote `use()`, keyed-provider ownership, singleton/keyed mode validation, token-driven RPC publication, lazy member access, stable local and RPC singleton facades across provider-facet replacement, and `{ local: true }` services remaining unreachable remotely;
- strict JSON boundaries, method context reconstruction, and request cancellation isolation without serializing context values;
- server/Session facet isolation, selected-Session switching, stale-frame rejection, and worker-side per-client request correlation;
- cold and hydrated `ReplicatedState`, snapshot/update race freedom, fresh delivery contexts, and clearing/re-hydration on disconnect, reconnect, and provider replacement;
- instance directory hydration, ordered reconciliation, state hydration before observer tasks, generation-based stale rejection, and task cleanup on close or switch.

Additional tests cover authenticated attachment and identity, telemetry propagation, flow control and gap recovery, plus the question and shared-review application patterns. If private references are added, they require separate lifetime and isolation coverage.

## Open protocol mechanics

Exact service call, cancellation, subscription, snapshot/update, keyed-instance, unavailable, and replacement frames are defined in `packages/protocol/src/protocol.ts`. Provider and namespace layers own member classification, lazy facades, buffering, and sequencing.

Still open are acknowledgements, flow control, sequence-gap recovery, reference collection if references are added, protocol-version negotiation, and how a future multi-pane presentation represents more than one selected Session. Singleton provider replacement must continue to install a complete replacement snapshot on the existing subscription so method and state member slots retain identity.

## Example: directory and selected session

The directory and management services are normal server services. Their contracts carry only presentation-safe values:

```ts
interface SessionSummary {
	serverId: string;
	sessionId: string;
	createdAt: string;
}

interface SessionDirectory {
	readonly state: ReplicatedState<{ revision: number; sessions: SessionSummary[] }>;
}

interface SessionManagement {
	create(options: { id?: string }, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");
const SessionManagement = defineService<SessionManagement>("pi.session-management");
```

A server facet derives the client from an authenticated `Context`, authorizes the requested Session, and performs the binding transition:

```ts
serverContext.provide(SessionDirectory, { state: directoryState });
serverContext.provide(SessionManagement, {
	async attach(sessionId, context) {
		const client = requireClientIdentity(context);
		authorizeSession(client, sessionId);
		await attachments.bind(client.clientId, sessionId, context);
	},
	async detach(context) {
		await attachments.unbind(requireClientIdentity(context).clientId, context);
	},
});
```

A presentation facet renders and selects Sessions:

```ts
setup(env) {
	const directory = env.use(SessionDirectory);
	const management = env.use(SessionManagement);
	const tui = env.use(Tui);

	tui.commands.register("sessions.switch", async (operation) => {
		const snapshot = directory.state.value;
		if (snapshot === undefined) return;
		const sessionId = await tui.select(
			"Sessions",
			snapshot.sessions.map((session) => ({ label: session.sessionId, value: session.sessionId })),
			{ signal: operation.abortSignal },
		);
		if (sessionId !== undefined) await management.attach(sessionId, operation);
	});
}
```

Another facet in the same presentation acquires Session services through the same API:

```ts
setup(env) {
	const models = env.use(Models);
	// After attach() settles, `models` addresses the selected worker.
}
```

The presentation never routes `models` with a selected `sessionId`; its host routes each service token and transport retains the selected-Session binding. The server closes the prior Session binding's resources before hydrating the new one.
