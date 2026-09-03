# Coding-Agent Application Hosts and Facets

The application-neutral facet, service, and replicated-state runtime is provided by
`@earendil-works/chord`. This document specifies how Pi composes that runtime with Pi-owned
service contracts, process roles, routing, and lifecycle policy.

> **Status:** Design specification for the experimental facet and service architecture.

This document assumes you already understand `AgentHarness`, `AgentLane`, `Session`, `Branch`, `SessionRepo`, and invocation `Context`. Read `rpc.md` for service transport semantics and `telemetry.md` for the telemetry model.

## Bird's-eye view

The coding agent is assembled independently in several processes. Three layers:

1. The **facet kernel** owns service-aware lifecycle mechanics: synchronous setup, dependency assembly, local and connected service binding, activation, scoped resource ownership, setup-failure cleanup, reload, and reverse-order disposal. It knows about services and remote service sources, but not about Harness, tools, TUI components, or coding-agent policy.
2. An **application host** owns one concrete runtime and contributes runtime facets that provide its concrete services. The **session host** normally runs in a dedicated session worker and owns session authority — the real Harness. A **presentation host** (TUI today, web later) owns a user interface. A **server host** owns server-wide authority: session records (`SessionRepo`), session-worker management, authentication, attachment, and routing between presentations and session workers.
3. An **extension** may distribute independent host-specific bundles containing **facets**. No aggregate extension object is loaded into all processes. Each host loads only facets built for that process and those facets can use only services available in that host graph.

The initial topology has one server and no server-to-server links:

```text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
```

A presentation and a session worker each connect to the server. There is no direct presentation→session-worker connection; the server routes service calls to the selected worker. The server lists and manages only its own sessions. Multi-server routing and server hierarchies are out of scope.

A session worker normally owns one session, and each session facet is instantiated for that session. A server facet is instantiated once per server process and is shared across every session and presentation connected to it. Server facets should therefore be rare and limited to inherently server-wide concerns. Per-session feature state belongs in session facets; dedicated workers provide the preferred lifecycle, crash, and state isolation. Future co-location may preserve the same logical service graph without changing what objects a facet can access.

**Host** and **client** are roles per connection, not fixed process kinds. The server hosts presentation and session-worker connections. A session worker serves its provided session services and may consume server-provided services over the same RPC binding mechanism. "Client" below always names the connection role, never a kind of extension.

## Why this shape

- **Authority stays where it belongs.** Provider credentials, tool execution, and per-session extension data exist only in the session worker; session records and worker control exist only in the server. Nothing reaches a presentation except through a deliberate contract.
- **One feature stays coherent.** The question extension's tool, dialog, and renderer ship in one package around one JSON contract, yet each facet is host-native code.
- **A new surface is presentation-only work.** A web facet for the question dialog or the session picker registers against existing tokens; session and server code do not change.
- **Server state stays server-wide.** A server facet is shared by all sessions and clients, so features use one only when their authority is inherently global to that server.
- **One facet mechanism.** Built-ins, runtime capabilities, and extensions use the same facet environment in every host.
- **Testable in pieces.** A facet tests against service-providing fixtures, a contract against loopback, and a routed TUI → server → session-worker path against a real transport — independently.

## One feature, several independently loaded facets

There is deliberately no `CodingAgentPlugin` runtime interface. A server, Session worker, TUI, and future web host execute different bundles in different processes, so they cannot share one loaded object containing all host facets.

The in-process unit is one facet:

```ts
interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}
```

Each process loads an ordered `Facet[]` appropriate to that process. Setup is synchronous declaration; asynchronous initialization belongs in `onActivate()`. A feature may consist of a shared contract bundle plus zero or more separately resolved server, Session, TUI, or web bundles. Their shared service IDs and wire contracts connect them, not an aggregate JavaScript object or a `definePlugin()` wrapper.

A package keeps shared wire contracts separate from host dependencies:

```text
question-extension/
  contract.ts       JSON DTOs and service tokens
  session.ts        dialog-service authority and tool contribution; imports agent/session code
  tui.ts            terminal dialog and renderer; imports TUI code
  web.ts            optional browser dialog and renderer
  package exports   unresolved mapping from host kind to independently loadable bundles
```

The browser build never imports `session.ts`; the session process never imports TUI or DOM code.

The question extension is this document's end-to-end example:

```text
model calls the question tool                                  (session facet)
→ session facet adds one invocation-keyed dialog service        (session authority)
→ every connected TUI/web facet observes the service instance   (keyed service)
→ the first accepted answer settles it for everyone
→ session facet returns the durable tool result
→ closing the instance closes every presentation's dialog
```

With no presentation connected, the question remains pending. A TUI or web facet that connects later obtains the same pending question.

The models service in the next sections illustrates services and replicated state; the [server section](#the-server-directory-management-and-routing) covers server-wide services and session routing; the [question section](#session-owned-deferred-interactions-the-question-extension) makes the full round trip concrete.

## Loading and connecting hosts

The loader abstraction is intentionally smaller than an extension manifest:

```ts
interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

interface FacetLoader {
	load(): Promise<LoadedFacets>;
}
```

Each host receives one or more static, combined, or extension-backed loaders. A loader owns the resources for one loaded module generation; the facet host owns the active facet environments. Initial startup loads facets, assembles the service graph, activates it, and disposes the loaded generation only after the host retires.

An extension resolver may add identity, ordering, version selection, package isolation, and process-specific source resolution. Its output remains independent `FacetLoader` inputs for each process rather than one cross-process extension object.

After transport setup, a host gives the kernel its loaded facets, runtime facets that provide concrete local services, and any host-selected remote service sources. The kernel runs every `setup()` in loader order, validates the complete service graph, binds dependencies, and then activates providers before consumers. Setup failure and normal shutdown dispose resources in reverse dependency order.

Exactly one process owns a Session's authority at a time. Worker replacement must close the old owner before a new process opens the same durable Session. Each presentation and Session worker uses one multiplexed connection to its server; facets never open private sockets or handle request IDs, cancellation frames, routing namespaces, or reconnect buffering.

Out of scope: arbitrary undeclared object remoting, serialized functions/classes/`Map`/`Set`, remote hook or tool execution, offline presentation writes or automatic mutation replay, a universal remote `AgentHarness`, and a serialized UI tree.

## Services connect host facets

Facets communicate across processes through **services**. One token type gives a service contract its identity:

```ts
function defineService<T>(id: string, options?: { local?: boolean }): Service<T>;
```

The declaration lives in the shared contract module and creates nothing. Services are remotely publishable by default; a process-local token declares `{ local: true }`. `provide(service, implementation)` adds one singleton to the host service graph. `provideMany(service)` registers ownership of a multi-instance service during facet setup and returns a `ServiceSpawner` whose later `spawn(key, implementation)` calls publish instances. The host publishes every non-local provision across its process boundary. Consumers select the same modes with `use(service)` or `observe(service, handler)`. Within one facet generation, a token must stay in one mode: mixing `provide`/`use` with `provideMany`/`observe` is an assembly or protocol error.

```ts
interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}
```

TypeScript types cannot produce runtime member metadata. Facet authors nevertheless declare no parallel member descriptor. When an exposed `provide()` implementation or `ServiceSpawner.spawn()` instance reaches the remote-service boundary, the runtime classifies functions as remote methods and recognizes Chord-created `ReplicatedState` values. It rejects unsupported members and announces the resulting member table over the transport. Process-local services may use arbitrary object contracts.

`use()` on a singleton returns a stable lazy proxy synchronously, even before a remote provider is attached. Member access creates local method or state slots as they are used; attachment validates those slots against the provider-announced kinds. A mismatch is an assembly or protocol error. This runtime mechanism is implemented once by the host rather than repeated in every service declaration.

### Dependency declaration and assembly

Service API calls made during facet setup are the dependency declarations. The kernel does not reflect on erased TypeScript interfaces, and facet authors do not maintain parallel `requires` and `provides` lists. A `Service<T>` retains its stable ID at runtime, and the API call supplies the mode. `use()` and `observe()` initially return source-independent disconnected handles. After all setup completes, the host matches unresolved requirements against provider-generated connection catalogues and binds each token to its local provision or exactly one connection.

The host records a private generation-scoped ledger:

```text
env.provide(Models, implementation)
→ @pi/providers-builtin:session provides pi.models/singleton

env.use(Models)
→ @pi/model-selection:tui requires pi.models/singleton

env.provideMany(QuestionDialogs)
→ @pi/question:session provides pi.question-dialog/keyed

env.observe(QuestionDialogs, handler)
→ @pi/question:tui requires pi.question-dialog/keyed
```

The first `provide()`, `provideMany()`, `use()`, or `observe()` for a token must occur during facet setup. Commands, hooks, event handlers, and activation callbacks use handles acquired during setup; they cannot introduce an undeclared service dependency later. Dynamic instances use the setup-owned `ServiceSpawner`, so spawning and closing instances do not change the graph.

After every facet has registered, the host generates its outgoing catalogue from non-local provisions, obtains catalogues from its remote service sources, resolves requirements to local or connected provisions, rejects missing providers, duplicate offers or singleton owners, singleton/keyed mismatches, invalid dependency cycles, and invalid remote service implementations, then records consumer-to-provider edges for lifecycle ordering. `use()` and `observe()` declare hard requirements; optional dependencies require a future distinct acquisition API rather than inference from call failure. The ledger and resulting graph are private kernel machinery, not a facet-facing plan or second declaration format.

Only dependencies acquired through `env.use()` or `env.observe()` belong to this lifecycle graph. Importing another extension's live implementation bypasses ownership and is unsupported. The module loader separately owns the ordinary source import graph. Reload therefore needs both loaded-source ownership and the generated service graph; see [Reloading facets](#reloading-facets).

The models service — the authority behind the model picker and thinking-level control — exercises methods, replicated state, and multiple consumers.

### Shared contract

```ts
export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelsState {
	catalog: { revision: number; availableModels: Array<ModelRef & { name: string; reasoning: boolean }> };
	configuration: { model: ModelRef | null; thinkingLevel: "off" | "low" | "high" };
	refresh:
		| { status: "idle" | "refreshing" | "done" }
		| { status: "warning"; errors: Record<string, string> };
}

export interface Models {
	readonly state: ReplicatedState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
}

export const Models = defineService<Models>("pi.models");
```

Everything transported in a remote contract is strict JSON: arguments, results, and replicated state. Business-level absence uses JSON `null`, never `undefined`. An unhydrated `ReplicatedState.value === undefined` is local control-plane readiness, not a transported state value. `Context` is control-plane data in a declared position; the proxy strips it and it is never serialized.

### Session facet

The snippets below use the facet shape but compress application details.

```ts
export const providersBuiltinSessionFacet = defineFacet({
	id: "@pi/providers-builtin",

	setup(env) {
		const providers = new ProviderRegistry(); // process-local, non-JSON
		const state = env.replicatedState<ModelsState>(initialModelsState());

		env.provide(Models, {
			state,

			async cycleThinking(context) {
				const { catalog, configuration } = state.value;
				if (configuration.model === null) return;
				const spec = findSpec(catalog, configuration.model);
				if (spec === undefined || !spec.reasoning) return;
				state.set(
					{
						...state.value,
						configuration: {
							...configuration,
							thinkingLevel: nextThinkingLevel(configuration.thinkingLevel),
						},
					},
					context,
				);
			},

			async select(model, context) {
				const spec = findSpec(state.value.catalog, model);
				if (spec === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
				const thinkingLevel = spec.reasoning ? state.value.configuration.thinkingLevel : "off";
				state.set({ ...state.value, configuration: { model, thinkingLevel } }, context);
			},

			async refresh(context) {
				state.set({ ...state.value, refresh: { status: "refreshing" } }, context);
				const errors = await providers.refresh(context.abortSignal);
				state.set({ ...state.value, catalog: providers.snapshot(), refresh: toRefreshStatus(errors) }, context);
			},
		});

		env.onActivate(() => providers.rebuild());
	},
});
```

### TUI facet

This shows the generic command-service pattern.

```ts
export const modelSelectionTuiFacet = defineFacet({
	id: "@pi/model-selection",

	setup(env) {
		const models = env.use(Models);
		const tui = env.use(Tui);

		tui.commands.register("models.select", async (context) => {
			const current = models.state.value;
			if (current === undefined) return;
			const selected = await tui.select(
				"Models",
				current.catalog.availableModels.map((model) => ({
					label: model.name,
					value: { provider: model.provider, modelId: model.modelId },
				})),
				{ signal: context.abortSignal },
			);
			if (selected !== undefined) await models.select(selected, context);
		});
		tui.commands.register("models.cycle-thinking", (context) => models.cycleThinking(context));
		env.own(models.state.subscribe((next) => renderModelSelector(next)));
	},
});
```

The TUI facet has no credentials, registry, or refresh logic: it calls a typed lazy proxy with the contract's method signatures and renders replicated state after hydration. A web facet would do the same through its web facet environment.

### Service semantics

A service has **one owner and many consumers**. In singleton mode, `providersBuiltinSessionFacet` provides `Models` and both model-selection commands consume it. In multi-instance mode, one owner may spawn instances `A` and `B`, and every observer sees the same two instances.

`use()` behaves differently by locality:

- **Local:** `use()` returns a stable lazy proxy backed by a direct process-local implementation slot. During synchronous setup it is disconnected; after assembly it binds to the local implementation without requiring provider-before-consumer setup order. Reload unbinds and rebinds that same slot.
- **Remote:** across a connection, `use()` returns the same kind of stable lazy proxy. Calls made while disconnected fail when invoked; state has no value until hydrated. Concurrent consumers of one token in one process share one proxy, one state replica, and one remote subscription.

Multi-instance services use `provideMany()` and `observe()`. The service is empty until its setup-owned `ServiceSpawner` calls `spawn()`; observing it never creates an instance. `spawner.spawn(key, implementation)` returns an idempotent close function, and the key must be unique among that service's live instances. Local observers use a direct process-local instance registry; non-local provisions additionally publish the same instance through RPC. `observe(service, handler)` reconciles current instances and then ordered additions, replacements, and removals. The handler receives the same `T` proxy shape as `use()`; instance keys remain provider-side addressing details. After an instance's initial state members hydrate, the host starts one handler task with a fresh `Context`. The facet lifecycle owns that observation. Closing the instance aborts its task context, rejects new calls, and lets already-admitted calls return. Cancellation from the instance context is normal task cleanup; other handler failures follow host failure policy. Reusing a closed key creates a new host-owned generation, so stale proxies cannot address the replacement.

An added instance member has structural identity `(service, key, generation, member)`. Its `ReplicatedState` members therefore need no independent IDs. The instance directory is control-plane metadata, not a facet-visible `ReplicatedState` containing proxies. Switching sessions aborts all observed instance tasks before hydrating the selected session's current instances.

Every facet uses the same unqualified `env.use()` and `env.observe()` operations. A presentation host combines its local services with connected server and selected-Session services, then routes each token internally. Provider facets resolve services from the same host graph. Transport binding and routing remain host infrastructure rather than facet API.

## What each facet kind grants

This is the most important boundary in the design.

**Session facets run beside the real thing.** They execute in the process that owns the concrete `AgentHarness`, `AgentLane`, `Session`, and Branches, and receive direct, process-local, scoped capabilities backed by those instances — not RPC proxies. Calls preserve real method signatures, `Context` propagation, `Result` types, and object identity. A session facet never RPCs back into its own process.

```ts
interface ScopedSessionData {
	readonly metadata: SessionMetadata;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	setValue<T>(address: Value<T>, value: T, context: Context): Promise<void>;
}

interface AgentFacetScope {
	readonly identity: SessionIdentity;
	readonly session: ScopedSessionData;
	readonly hooks: ScopedHooks;
	lane(name: string, context: Context): Promise<AgentLaneFacetView>;
}

const Agent = defineService<AgentFacetScope>("pi.local.agent", { local: true });
const Providers = defineService<ProviderContributionRegistry>("pi.local.providers", { local: true });
const Tools = defineService<ToolContributionRegistry>("pi.local.tools", { local: true });
```

"Local" and "unrestricted" are separate decisions. The scope narrows authority for lifecycle and composition — hooks and event subscriptions registered through it are automatically owned by the facet and disposed with it. `AgentLaneFacetView` exposes Branch methods directly alongside agent operations. `ScopedSessionData` exposes purpose-bounded durable operations. The host keeps the unrestricted concrete instances and reserves: `AgentHarness.close()` and `Session.close()`; raw `Session.mutate()`, `beginMutation()`, and `SessionMutator` (unless a narrowly trusted durability extension explicitly owns them); `idGenerator` and backend/storage objects; Branch creation; whole-registry setters such as `setTools()`; unscoped hook/event registration; transport exposure and remote-reference registration. This is a composition and lifecycle boundary, not a security sandbox: session facets are trusted code in the authoritative process. A future extension policy may explicitly grant broader local capability, but built-ins should receive no implicit bypass.

**Presentation facets hold none of this.** A TUI or web facet never receives the raw Harness, Session, tree, tool registry, hooks, or credentials. It uses host-local presentation services plus the semantic services and replicated state deliberately exposed by a Session or server facet.

```ts
interface FacetEnvironment extends FacetLifecycle {
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (service: T, context: Context) => void | Promise<void>,
	): void;
	provide<T>(service: Service<T>, implementation: T): void;
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	replicatedState<T>(initial: T): MutableReplicatedState<T>;
}

type AttachmentState = { status: "detached" } | { status: "attaching" | "attached" | "degraded"; sessionId: string };

interface SelectItem<T> {
	label: string;
	description?: string;
	value: T;
}

interface TuiModal {
	select<T>(title: string, items: SelectItem<T>[]): Promise<T | undefined>;
	input(title: string): Promise<string | undefined>;
	close(): void;
}

interface TuiHost {
	readonly attachment: ReplicatedState<AttachmentState>;
	readonly commands: CommandContributions;
	readonly toolRenderers: ToolRendererContributions;
	acquireModal(signal: AbortSignal): Promise<TuiModal>;
	select<T>(title: string, items: SelectItem<T>[], options: { signal: AbortSignal }): Promise<T | undefined>;
}

const Tui = defineService<TuiHost>("pi.local.tui", { local: true });
```

The first implemented presentation hookpoint is narrower than this eventual `TuiHost`: a process-local `SlashCommands` registry. Built-in presentation facets and plugin presentation facets acquire the same registry and add command metadata plus callbacks during activation. The returned cleanup removes the contribution, so facet reload and unload update autocomplete and dispatch without rebuilding the TUI. Command callbacks receive narrow selection, status, and prompt-submission operations rather than the raw renderer or editor.

Each plugin host facet is an independent loader entry. The example `/hello` presentation facet has one default facet export; a future package build emits that facet as one pre-bundled file. Session, server, web, and other presentation facets from the same plugin are separate bundle entries connected by shared service IDs, not one aggregate runtime plugin object.

`acquireModal()` waits in one presentation-owned queue and holds the modal slot across a multi-step interaction. Its signal removes a queued request or dismisses an active one, and `close()` is idempotent. `select()` is the one-step acquire/select/close convenience. Both return selected values directly, so feature code never recovers identity from a display label.

The TUI loads all of its facets into one generation. Its host routes `env.use(SessionDirectory)` to the connected server and `env.use(Models)` to the selected Session. While detached, Session calls fail with `session_not_attached` and replicated state has no value. Connection and attachment health are host-local services because they describe presentation control state. A future web host similarly binds local services for routes, views, and DOM dialogs. Its server and Session facets still use unqualified service operations.

`AgentController` is the presentation-safe command facade over the worker-owned main `AgentLane`. It exposes prompt, queue, abort, resume, compaction, and navigation operations as JSON-safe results. The Session runtime constructs it directly from the lane; it does not publish the raw Harness or lane as local facet services.

The runtime form is:

```ts
export function createAgentControllerRuntimeFacet(lane: AgentLane) {
	return defineFacet({
		id: "@pi/agent-controller-runtime",
		setup(env) {
			env.provide(AgentController, createAgentController(lane));
		},
	});
}
```

Its TUI facet consumes `AgentController` through `env.use()` exactly as the model picker consumes `Models`. It does not reveal the Harness object behind the controller; there is no universal remote Harness for arbitrary plugins. `rpc.md` may still define generic Harness proxies for other trusted integrations (an IDE bridge, an orchestrator) — deliberate, separate exposures, not the plugin boundary.

## Local services and narrow remote facades

Not every dependency should be remotely reachable. A **local service** is a token declared with `{ local: true }` and confined to its providing process. It may use synchronous methods and hold functions, classes, native objects, credentials, filesystem handles, or other non-JSON values. Remote `use()` cannot resolve it, and local services are never discoverable remotely. Local and non-local provisions share dependency ordering, stable handles, keyed generations, activation, disposal, and provider-facet reload; non-local services only add validation, replication, and RPC publication. The pattern for sensitive state is a local full service plus a narrow remote facade:

```ts
const Credentials = defineService<CredentialStore>("credentials", { local: true }); // get/set provider secrets

interface Accounts {
	readonly state: ReplicatedState<{ providers: Array<{ provider: string; configured: boolean }> }>;
	remove(provider: string, context: Context): Promise<void>;
}
const Accounts = defineService<Accounts>("pi.accounts");
```

The auth extension's Session facet uses `Credentials` directly; presentations see provider IDs and `configured` booleans — never secrets. If some settings must not be remotely writable, split them the same way; do not rely on presentation-side convention.

## Replicated state: `ReplicatedState`

`Models.state` is a `ReplicatedState<ModelsState>`: **authoritative latest-value replication** — not event history, durable storage, a CRDT, or a multi-writer mechanism.

```ts
interface ReplicatedState<T> {
	/** Borrowed immutable value, or `undefined` until hydration. Do not mutate or retain it. */
	readonly value: T | undefined;
	/** Listener values are borrowed and must not be mutated or retained. */
	subscribe(listener: (value: T, context: Context) => void): () => void;
}

interface MutableReplicatedState<T> extends ReplicatedState<T> {
	/** A providing state is always initialized. */
	readonly value: T;
	/** Transfers the JSON value to the state; the caller must not subsequently mutate it. */
	set(value: T, context: Context): void;
}
```

Required behavior:

1. The providing host owns one initialized authoritative value; remote consumers call methods rather than writing the replica.
2. A cold remote replica has no value. Its `.value` is `undefined`, and `subscribe()` registers the listener without invoking it. This `undefined` is local readiness state and never crosses the wire.
3. **Hydration** installs a complete snapshot atomically before updates flow. Subscribing before hydration is valid, and updates emitted concurrently with the snapshot are buffered, so the listener observes snapshot then updates with no gap.
4. Once hydrated, `.value` is synchronously readable and `subscribe()` immediately reports the current value, then future updates. Snapshot hydration uses a fresh delivery context parented to the subscription; later updates reconstruct fresh delivery contexts from source trace metadata.
5. State values are borrowed immutable JSON. The state runtime does not defensively clone reads, writes, snapshots, or listener deliveries. Callers transfer ownership to `set()` and must not mutate or retain values returned by `.value` or passed to listeners; copy explicitly when ownership is required. Process and transport serialization may naturally produce a detached value, but callers must not depend on object identity or detachment.
6. Disconnect, provider withdrawal, and route switching clear readiness, so `.value` becomes `undefined`. Reconnect or singleton replacement installs a complete fresh snapshot in the existing member facade before later updates flow. A presentation that wants stale display data must retain it separately alongside connection or attachment health.
7. `set(value, context)` passes its context to local source listeners and publishes source trace metadata. Remote delivery reconstructs a fresh local `Context`; it never retains the source context object.

Anything a consumer must recover after reconnect is exposed as replicated state or pulled through a remote method. Replicated state is latest-value replication, not by itself durable session storage; the providing facet must reconstruct its authoritative value after a worker restart.

Prefer several coarse independent cells over one giant value or a universal patch language, so a catalogue refresh does not retransmit unrelated configuration. High-frequency data such as transcript streaming needs a future snapshot-and-delta design rather than overloading `ReplicatedState`. Revision metadata, gap recovery, unchanged-value suppression, and demand-driven subscription belong to that future protocol, not individual facet authors.

## Contribution registries: many contributors, one result

Services fit one owner, many consumers. Providers and tools invert that: **many extensions contribute to one host-owned result**. A mutable global registry would make composition order-dependent and removal impossible. A contribution registry instead replays ordered contributions over a fresh draft:

```text
fresh ProviderDraft
→ built-in provider contribution        (@pi/providers-builtin)
→ remote catalogue contribution         (@pi/providers-catalog)
→ models.json transformation            (@pi/providers-models-json)
→ authentication/availability marking   (@pi/auth)
→ validated ProviderState
```

Removing an extension removes its contribution and rebuilds; nothing runs an inverse mutation. Tools follow the same model, including wrapping:

```ts
sessionContext.tools.add((draft) => {
	draft.set("review_add", reviewAddTool);
	draft.wrap("bash", (next) => async (invocation) => {
		await authorize(invocation);
		return next(invocation);
	});
});
```

Ordered wrappers compose deterministically — `telemetry(permission(sandbox(coreBash)))` — and if the permission extension disappears, rebuilding yields `telemetry(sandbox(coreBash))`. Only the host finalizes the draft and applies the complete registry to the Harness; facets never call `setTools()`. Contributions configure rebuilt behavior; hooks intercept live operations — separate mechanisms.

## Context, cancellation, and telemetry for facet authors

Every remote method receives a fresh local `Context` in its declared position. The proxy strips the caller's context from JSON arguments and maps `context.abortSignal` to cancellation of that one request. The receiving endpoint constructs a request-local abort signal; it never deserializes the sender's `Context` or arbitrary typed values. Shared service objects must not retain a caller's context.

The model refresh shows the whole author-visible surface:

```ts
const controller = new AbortController();
await uiTelemetry.startSpan({ name: "ui.models.refresh" }, async (span) => {
	const context = withAbortSignal(controller.signal, withTelemetryContext(span, BACKGROUND_CONTEXT));
	await models.refresh(context);
});
```

RPC telemetry composes with application spans as:

```text
ui.models.refresh
└─ rpc.client models.refresh
   └─ rpc.server models.refresh
      └─ plugin.models.refresh
```

`controller.abort()` cancels only that one request: the server's reconstructed `context.abortSignal` aborts, and no other caller is affected.

Three cancellation domains must never blur:

1. **Invocation cancellation** aborts one remote call or wait — the `controller.abort()` above.
2. **Service-owned cancellation** is an explicit method such as `job.cancel()` that stops a service-owned task.
3. **Durable Harness cancellation** — `requestAbort()`/`abort()` — writes durable `cancel_requested` and drives durable settlement.

A transport disconnect performs only the first for active requests and closes that client's subscriptions. It must not silently cancel service-owned work or write durable cancellation. Work intended to outlive its initiating request must deliberately detach into a service-owned task with its own controller and telemetry root.

## Service-owned jobs

Private returned references are outside the initial service contract. Prefer `provideMany()` for discoverable live instances. Add caller-private references only after a concrete feature establishes their ownership and collection requirements.

A possible long-running job contract is:

```ts
interface IndexJob {
	readonly progress: ReplicatedState<IndexProgress>;
	wait(context: Context): Promise<IndexProgress>; // aborting this context cancels only this wait
	cancel(context: Context): Promise<void>;        // cancels the job itself, for everyone
}
```

An `IndexService.start(root, context)` returning an `IndexJob` validates the root, creates its own `AbortController` and a detached telemetry root, and returns the job. The job crosses the wire as a private **remote object reference** (`rpc.md`) known only to that caller. If every attached presentation must discover a job, register a multi-instance service with `provideMany()` during setup and spawn an instance instead. Discovery is the distinction: returned references are passed explicitly; spawned instances appear in `observe()` hydration. Both make the cancellation domains concrete, and both need explicit lifetime cleanup.

## The server: directory, management, and routing

The server host does two jobs. It **owns server-wide services**—listing, creating, deleting, and attaching to sessions—and it **routes session traffic** between attached presentations and the session workers it manages. Routing is host infrastructure that facet code does not implement.

A server facet is shared by every session and presentation connected to the server. It should be used only for inherently server-wide features. Per-session feature data belongs in session facets.

### Server host services

```ts
interface FleetFacetScope {
	readonly managed: ManagedSessionsView;  // sessions managed by this server
	readonly attachments: AttachmentsView;  // bind/unbind a client's selected session
}

const Fleet = defineService<FleetFacetScope>("pi.local.fleet", { local: true });
```

The raw `SessionRepo`, storage handles, unrestricted process-kill authority, routing map, and routing machinery stay with the server application:

```ts
interface ManagedSessionRecord {
	sessionId: string;
	title: string;
	workspaceId: string;
	ownerId: string;
	cwd: string; // ownerId and cwd never leave the server
}

type ManagedSessionChange = { type: "created" | "changed" | "deleted"; record: ManagedSessionRecord };

interface ManagedSessionsView {
	snapshot(): ManagedSessionRecord[];
	onChanged(listener: (change: ManagedSessionChange, context: Context) => void): () => void;
	create(options: { title: string; workspaceId: string }, context: Context): Promise<ManagedSessionRecord>;
	remove(sessionId: string, context: Context): Promise<void>;
}
```

### Shared contract

The directory is read; management mutates and selects. Both are presentation-safe: `ownerId` and `cwd` are stripped from summaries.

```ts
export interface SessionRecordSummary {
	sessionId: string;
	title: string;
}

export interface SessionDirectory {
	readonly state: ReplicatedState<{ revision: number; sessions: SessionRecordSummary[] }>;
}

export const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");

export interface SessionManagement {
	create(options: { title: string }, context: Context): Promise<SessionRecordSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineService<SessionManagement>("pi.session-management");
```

### Server facet

```ts
// server.ts
export const sessionDirectoryServerFacet = defineFacet({
	id: "@pi/session-directory",
	setup(env) {
		const { managed, attachments } = env.use(Fleet);
		const state = env.replicatedState({ revision: 0, sessions: [] as SessionRecordSummary[] });

		function publish(_change: ManagedSessionChange, context: Context) {
			state.set({ revision: state.value.revision + 1, sessions: managed.snapshot().map(toSummary) }, context);
		}

		env.own(managed.onChanged(publish));
		env.onActivate(() =>
			state.set({ revision: 1, sessions: managed.snapshot().map(toSummary) }, BACKGROUND_CONTEXT),
		);

		env.provide(SessionDirectory, { state });
		env.provide(SessionManagement, {
			async create(options, context) {
				const client = requireClientIdentity(context);
				return toSummary(
					await managed.create({ title: options.title, workspaceId: client.workspaceId }, context),
				);
			},
			async remove(sessionId, context) {
				authorizeTarget(requireClientIdentity(context), managed.snapshot(), sessionId);
				await managed.remove(sessionId, context);
			},
			async attach(sessionId, context) {
				const client = requireClientIdentity(context);
				authorizeTarget(client, managed.snapshot(), sessionId);
				await attachments.bind(client.clientId, sessionId, context);
			},
			async detach(context) {
				await attachments.unbind(requireClientIdentity(context).clientId, context);
			},
		});
	},
});

function authorizeTarget(client: ClientIdentity, records: ManagedSessionRecord[], sessionId: string) {
	const record = records.find((candidate) => candidate.sessionId === sessionId);
	if (record === undefined || record.workspaceId !== client.workspaceId) {
		throw new RemoteServiceError("not_authorized", `Not accessible: ${sessionId}`);
	}
}

function toSummary({ sessionId, title }: ManagedSessionRecord): SessionRecordSummary {
	return { sessionId, title };
}
```

Every call is authorized against the client identity that transport policy installed server-locally, never against identity supplied in ordinary arguments.

### TUI facet: the picker

```ts
// tui.ts
export const sessionPickerTuiFacet = defineFacet({
	id: "@pi/session-picker",
	setup(env) {
		const directory = env.use(SessionDirectory);
		const management = env.use(SessionManagement);
		const tui = env.use(Tui);

		tui.commands.register("sessions.switch", async (context) => {
			const current = directory.state.value;
			const attachment = tui.attachment.value;
			if (current === undefined || attachment === undefined) return;
			const selected = await tui.select(
				"Sessions",
				current.sessions.map((session) => ({
					label: pickerLabel(session, attachment),
					value: session.sessionId,
				})),
				{ signal: context.abortSignal },
			);
			if (selected !== undefined) await management.attach(selected, context);
		});

		env.own(directory.state.subscribe((next) => renderSessionList(next)));
	},
});
```

The TUI facet consumes a service provided by the one connected server. There is no session facet in this plugin because sessions do not own discovery or attachment.

### Attaching and switching

`attach(sessionId)` selects the session for this presentation connection:

1. the server authorizes the client for one of its managed sessions;
2. it closes the client's previous session-scoped requests, subscriptions, and observed instance tasks;
3. it binds the presentation host's Session services to the selected Session worker;
4. the Session worker hydrates singleton state and current keyed instances from complete fresh snapshots; attachment state becomes `attached`.

Session service handles are stable across switches: a proxy returned once by a Session facet's `env.use(Models)` keeps working against the new Session, and `env.observe(QuestionDialogs, ...)` reconciles the new Session's instances. Frames belonging to closed subscriptions or requests are dropped.

### Routed session call

```text
TUI A (selected session S1): rpc.client agent-controller.prompt
server: authorize client for S1; route to session worker S1 with authenticated client identity
S1: rpc.server agent-controller.prompt — fresh local Context, validated JSON args → lane.prompt(...)
response returns S1 → server → TUI A
```

Aborting the TUI request sends cancellation through the server to S1, aborting the session-side request controller. `Context` and trace metadata are reconstructed at the service endpoint.

### Routing is host infrastructure

The server routes session traffic contract-agnostically. It parses protocol envelopes—frame kind, request ID, service ID, optional instance key/generation, and selected session—but not service business payloads. Validation happens at service endpoints, so the server can route a Session service without loading that session facet.

The server stamps routed calls with its authenticated client identity. The Session worker keys connection-owned requests per presentation route, preventing request-ID collisions and cross-client cancellation. No server facet participates in routing or re-provides session services.

## Session-owned deferred interactions: the question extension

Some session-side work must ask users for a decision. The existing `examples/extensions/question.ts` shows the experience: the model calls a `question` tool, a user selects an option or types an answer, and the tool returns that answer with a compact rendering.

A question is not a reverse RPC routed to one eligible presentation. The Session adds one temporary dialog service keyed by the invocation ID. Every connected TUI or web presentation observes that instance, a presentation connecting later discovers it through instance hydration, and the instance remains open while no users are connected.

### Shared contracts

```ts
const QuestionParamsSchema = Type.Object({
	question: Type.String(),
	options: Type.Array(
		Type.Object({
			label: Type.String(),
			description: Type.Union([Type.String(), Type.Null()]),
		}),
	),
});
type QuestionRequest = Static<typeof QuestionParamsSchema>;

type QuestionResponse =
	| { outcome: "selected"; index: number }
	| { outcome: "custom"; answer: string }
	| { outcome: "cancelled" };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
}

interface QuestionDialogs {
	readonly request: ReplicatedState<QuestionRequest>;
	submitAnswer(response: QuestionResponse, context: Context): Promise<void>;
}

const QuestionDialogs = defineService<QuestionDialogs>("pi.question-dialog");
```

`QuestionDialogs` declares only the contract. Each invocation explicitly adds one keyed instance. Its `request` state is addressed by the service, invocation key, hidden generation, and member name.

The tool-result helper remains session-local:

```ts
function questionResult(request: QuestionRequest, answer: string | null, wasCustom: boolean, text: string) {
	return {
		content: [{ type: "text", text }],
		details: { question: request.question, options: request.options.map((o) => o.label), answer, wasCustom },
	} satisfies AgentToolResult<QuestionDetails>;
}
```

### Session facet: add one dialog service

`memoOnce(name, candidate)` is an atomic invocation-memo operation. It keeps the first value, returns that durable winner to every caller, and reports all failures by rejecting its promise rather than throwing synchronously. `awaitAbortable()` is an ordinary shared cancellation utility.

```ts
// session.ts
export const questionSessionFacet = defineFacet({
	id: "@pi/question",
	setup(env) {
		const dialogs = env.provideMany(QuestionDialogs);
		const tools = env.use(Tools);

		tools.add((draft) => {
			draft.set("question", {
				label: "Question",
				description: "Ask users a question and wait for an answer.",
				executionMode: "sequential",
				replay: "safe",
				parameters: QuestionParamsSchema,

				async execute(_toolCallId, params, _onUpdate, _toolContext, invocation, context) {
					if (params.options.length === 0) {
						return questionResult(params, null, false, "No options provided");
					}

					const memoName = "pi.question.answer";
					let response = (await invocation.getMemo(memoName)) as QuestionResponse | undefined;

					if (response === undefined) {
						const completion = Promise.withResolvers<QuestionResponse>();
						const request = env.replicatedState<QuestionRequest>(params);
						const close = dialogs.spawn(invocation.invocationId, {
							request,
							async submitAnswer(candidate, _answerContext) {
								if (candidate.outcome === "selected" && params.options[candidate.index] === undefined) {
									throw new Error("Question response selected an invalid option");
								}
								const committed = invocation.memoOnce(memoName, candidate);
								completion.resolve(committed);
								await committed;
							},
						});

						try {
							response = await awaitAbortable(completion.promise, context.abortSignal);
						} finally {
							close();
						}
					}

					if (response.outcome === "cancelled") {
						return questionResult(params, null, false, "User cancelled the question");
					}
					if (response.outcome === "custom") {
						return questionResult(params, response.answer, true, `User wrote: ${response.answer}`);
					}
					const selected = params.options[response.index];
					if (selected === undefined) throw new Error("Question response selected an invalid option");
					return questionResult(params, selected.label, false, `User selected: ${response.index + 1}. ${selected.label}`);
				},
			});
		});
	},
});
```

`dialogs.spawn()` installs the instance before `execute()` waits. The returned close function is the single normal, cancellation, and error cleanup path. Concurrent submissions call `memoOnce()`, whose atomic first-writer rule prevents overwrite and returns the same durable winner. `completion.resolve(committed)` makes the local wait follow that durable operation: success resumes the tool, while failure rejects it and runs the same cleanup instead of leaving it suspended. Each service call also awaits its own `committed` promise, so it cannot report success before durability or leave an ignored rejection. Calls through a closed instance or an old generation fail as stale service calls.

### TUI and web facets: observe every dialog instance

```ts
// tui.ts
type QuestionChoice =
	| { outcome: "selected"; index: number }
	| { outcome: "custom" };

export const questionTuiFacet = defineFacet({
	id: "@pi/question",
	setup(env) {
		const tui = env.use(Tui);
		env.observe(QuestionDialogs, async (dialog, context) => {
			const request = dialog.request.value;
			if (request === undefined) throw new Error("Question dialog was observed before hydration");

			const modal = await tui.acquireModal(context.abortSignal);
			try {
				const choice = await modal.select<QuestionChoice>(
					request.question,
					[
						...request.options.map((option, index) => ({
							label: option.label,
							...(option.description === null ? {} : { description: option.description }),
							value: { outcome: "selected" as const, index },
						})),
						{ label: "Write a custom answer", value: { outcome: "custom" as const } },
					],
				);

				let response: QuestionResponse;
				if (choice === undefined) {
					response = { outcome: "cancelled" };
				} else if (choice.outcome === "selected") {
					response = choice;
				} else {
					const answer = await modal.input(request.question);
					response = answer === undefined ? { outcome: "cancelled" } : { outcome: "custom", answer };
				}

				await dialog.submitAnswer(response, context);
			} finally {
				modal.close();
			}
		});

		tui.toolRenderers.add<QuestionDetails>("question", questionRenderer);
	},
});
```

`observe()` runs one abortable task per open instance, including instances present in the hydration snapshot. Three concurrent tool invocations therefore produce three tasks keyed by their invocation IDs. The TUI modal queue displays them one at a time; a web host may render all three. Closing one instance aborts only its task in every presentation.

With no connected presentation, the added instance and unresolved tool remain Session-owned. A web facet observes the same service; a headless client may ignore it. Similar features—permissions, OAuth, or editor requests—may add their own service instances when all presentations need to discover temporary instances. Secrets still require narrow methods and presentation-safe state.

### Durability and worker replacement

The service instance is live process state; the invocation memo is the replay receipt. The Harness already persists a safe tool's effective arguments, stable invocation ID, `effect_pending` state, and memos. `memoOnce()` synchronously enters one atomic read-or-write on the invocation's Session mutation line and verifies that the same operation, turn, source position, and invocation still own the effect. It returns the existing value or commits and returns the candidate.

If the worker dies before the answer commit, the old instance and promise disappear. Safe replay reads no answer and adds the same logical key with a new generation. If it dies after the commit, replay reads the answer and returns without adding an instance. A client cannot answer while the worker is absent; calls through the old generation fail instead of locating an invocation by bare ID.

The memo has the existing invocation lifetime. Staging the tool result as `outcome_ready` atomically deletes it; cancellation and external finalization use the same cleanup. The question request is not copied into another memo because the Harness already persisted the effective tool arguments. Source reload uses this same durable worker-reconstruction path.

## Lifecycle and disposal

A facet environment owns service provisions, `provideMany()` instances, observations, and resources explicitly registered through `own()`. Facets must register state subscriptions, watchers, timers, subprocesses, overlays, and other external resources themselves. The host deactivates consumers before providers and runs each facet's owned cleanups in reverse registration order.

Already-admitted inbound RPC calls may continue while their providing facet deactivates. Withdrawing a provider rejects new calls. Code that requires stronger fencing needs an explicit lifecycle-owned controller.

## Reloading facets

Reload means replacing loaded facet source. It is not a transaction over durable Session state or external effects.

### Shape-preserving provider replacement

`FacetHost.reload()` replaces facets by `Facet.id` only when each replacement declares exactly the same service requirements, provisions, and singleton/keyed modes as the active facet. The tested sequence is:

```text
load replacement facets
→ run setup and validate the unchanged service shape
→ withdraw replaced singleton provisions
→ deactivate old facets in reverse dependency order
→ activate replacements in dependency order
→ rebind local implementation slots
→ publish complete RPC singleton replacement snapshots
→ dispose the retired LoadedFacets generation
```

The loader disposal is deliberately outside `FacetHost.reload()`: the coordinator that loaded a module owns that module. It must dispose the old `LoadedFacets` only after the old active facets retire, and dispose a failed candidate generation if setup or validation fails.

A singleton facade belongs to its consumer rather than a provider generation. Existing local proxies and captured local methods dispatch to the replacement implementation. Existing RPC proxies, captured methods, and replicated-state facades retain identity. During replacement they are unavailable: calls fail instead of queueing, and state becomes unhydrated until the complete replacement snapshot arrives.

Reload has no rollback guarantee after old-facet deactivation begins. A failed replacement leaves affected services unavailable or degraded. Already-admitted calls are not automatically replayed or cancelled; callers must reconcile uncertain durable outcomes through authoritative state or stable operation IDs.

### Shape changes and process replacement

Changing requirements, provisions, modes, facet membership, or process authority is structural. It requires a newly assembled graph or an ordinary process restart; `FacetHost.reload()` intentionally rejects it.

A reload coordinator lives outside the facet graph it replaces and follows these rules:

1. Reload control stays outside the facet graph being replaced.
2. It chooses a desired source generation, then independently loads the affected server, Session, and presentation bundles. There is no aggregate cross-process extension object.
3. Shape-preserving facets use the existing host reload primitive. Structural changes build and validate a candidate graph before switching. Session-authority changes stop the old worker and release Session ownership before opening the replacement.
4. Hosts may converge at different times, so shared service contracts and durable records must tolerate temporary source-generation skew.
5. Failure is reported without pretending to roll back committed Session records, filesystem writes, subprocess effects, or hosts that already switched.

`ReplicatedState` is a projection rather than storage. A replacement provider reconstructs authoritative state from durable Session records, configuration, or another owned source and publishes a complete snapshot. Keyed instances that must survive a worker restart likewise need durable application records and return as fresh live generations. Provider-local transport sequences and keyed generations may restart after rebinding and are never globally monotonic.

Exactly one worker may own an open Session. Worker replacement therefore has a route gap:

```text
old worker stops and releases Session ownership
→ selected Session remains logically selected but unavailable
→ replacement worker opens the Session and reconstructs services
→ server creates a fresh attachment binding
→ presentations hydrate fresh singleton and keyed snapshots
```

Reload never blindly retries an interrupted mutation. A request may have committed before its response was lost. Durable resumability belongs to Harness and application contracts, not facet cleanup.

## Connection loss, errors, and security

Disconnect behavior, from the facet author's perspective:

- **A presentation disconnects.** Its server aborts the client's active requests and closes its observed instance tasks and other session-routed resources. Session-owned work continues per application policy. An added question dialog remains Session-owned; the disconnected presentation loses its proxy and any in-flight `submitAnswer()` call fails.
- **A Session worker disconnects or crashes.** Its server fails routed in-flight calls and closes that worker's observed instance tasks. Attached presentations see `attachment.status === "degraded"` while the server connection stays healthy, so the directory still works and the user can attach elsewhere.
- **A process loses its server connection.** Its connected server and Session services become unavailable. A Session worker loses server services and all attached presentations at once; unattended-Session policy decides whether it exits.
- Reconnect and reattach always hydrate from a fresh authoritative snapshot; prior keyed proxies and attachment-bound frames are invalid. **Never blindly replay a mutation after an uncertain disconnect** — a replayed `select()` is harmless, a replayed `prompt()` is not. Reconnect, hydrate, and reconcile, or design the operation around a stable operation ID with explicit lookup semantics.

Errors cross the wire as a JSON envelope `{ code, message }` with stable protocol and service codes. Unexpected exceptions become `internal_error` without exposing stacks. Authentication and application errors use registered stable codes.

Boundary rules:

- remotely publishable service IDs come from trusted loaded service tokens; the remote boundary accepts only implementation functions and branded replicated-state members, instance generations are host-owned, and `{ local: true }` services are never discoverable remotely;
- business arguments, results, and state are validated as JSON; protocol envelopes cannot be forged as ordinary values;
- clients cannot choose context position, instance generations, selected-Session routing fields, or cancellation targets other than their own requests; and
- credentials, prompts, completions, tool arguments/results, and filesystem contents are not exposed unless an explicit contract permits them.

## Host composition

The facet kernel is service-aware but application-agnostic. A complete product should supply independently loaded facet sets for server authority, each Session worker, and each presentation. Shared contracts contain service tokens and JSON-safe DTOs; they do not imply that the providing and consuming facets share a bundle.

## Open decisions

Before the extension layer becomes normative:

- what an `Extension` identifies and how it maps a version to independently bundled host facets;
- the manifest/source-selection format, ordering rules, package export convention, trust policy, and cross-process version skew;
- how structural graph replacement preserves host control and reports partial convergence;
- the concrete scoped server, Session, TUI, and future web capabilities;
- whether directory state is projected per authenticated client or globally presentation-safe;
- authentication, authorization, protocol version negotiation, and expected application error registration;
- optional service dependencies, multi-Session presentations, replicated-state flow control, and gap recovery;
- whether private returned references are needed after keyed services cover concrete features; and
- package boundaries between the facet kernel, service RPC, coding-agent host integration, and extension contracts.

## Required tests

The test matrix covers:

- setup-derived provisions and requirements, late-access guards, missing and duplicate providers, mode validation, cycles, activation order, and reverse disposal;
- local and connected singleton calls, token-driven publication, strict JSON values, keyed instance hydration, generation fencing, cancellation, and selected-Session routing;
- cold state, snapshot/update races, buffering, update order, disconnect cleanup, and complete replacement snapshots; and
- static/combined loaders plus stable local and RPC singleton handles across shape-preserving provider reload.

It also covers extension discovery and isolated process-specific bundle loading; structural graph reassembly and reload coordination; worker handoff with preserved logical selection and fresh attachment fencing; scoped host capabilities and contribution-registry rebuilds; authenticated routing and telemetry propagation; keyed-provider replacement and activation failure; and the question and collaborative-review examples below.

## Collaborative diff review: a durable shared sidebar

A diff review starts in a presentation rather than in a tool invocation. A user asks to review the current working-tree diff; the session snapshots it and opens one shared review. Every attached TUI and web presentation renders the same patch and comments, and any authorized user may add a comment or submit the whole review as one prompt.

This uses two service modes:

```text
DiffReviewManager                         singleton service
  createReview()
    → persist immutable patch
    → add DiffReviews[reviewId]

DiffReviews[reviewId]                    keyed service
  document                               immutable patch state
  activity                               durable comments + status state
  addComment()                           commit, then publish
  submit()                               freeze, enqueue one prompt, close
```

The keyed instance is the live, reactive projection. An extension-owned record is the durable authority. Pending comments are not weakly persisted: each acknowledged comment survives a worker restart, but the record is deleted after its prompt is durably accepted.

### Shared remote contract

```ts
interface DiffCommentInput {
	commentId: string; // stable across an uncertain retry
	path: string;
	side: "old" | "new";
	line: number;
	body: string;
}

interface DiffComment extends DiffCommentInput {
	author: { userId: string; displayName: string };
	createdAt: string;
}

interface DiffReviewDocument {
	reviewId: string;
	patch: string;
}

interface DiffReviewActivity {
	revision: number;
	comments: DiffComment[];
	status: "open" | "submitting";
}

interface DiffReviewManager {
	createReview(context: Context): Promise<void>;
}

interface DiffReviews {
	readonly document: ReplicatedState<DiffReviewDocument>;
	readonly activity: ReplicatedState<DiffReviewActivity>;
	addComment(input: DiffCommentInput, context: Context): Promise<void>;
	submit(context: Context): Promise<void>;
}

const DiffReviewManager = defineService<DiffReviewManager>("pi.diff-review-manager");
const DiffReviews = defineService<DiffReviews>("pi.diff-review");
```

The client never supplies a patch, author, or review ID. The session computes a bounded immutable patch, creates the ID, and derives each author from the authenticated identity in `Context`. `commentId` is only an idempotency key; it grants no authority.

### Narrow local durability capabilities

Unlike a question, this interaction has no invocation memo. The Session facet uses three process-local capabilities: a diff source that snapshots the working tree, a review store that serializes record mutations, and a prompt queue with idempotent `enqueueOnce()`. One durable review record contains the immutable patch, revisioned comments, status, and an optional frozen `{ submissionId, prompt }`. These local capabilities are ordinary `{ local: true }` services; their repository APIs are not part of the extension's shared contract.

`DiffReviewRecords` serializes mutations per review. `addComment()` validates the anchor against the stored patch, stamps the authenticated author, deduplicates `commentId`, commits, and then returns the new revision. `freezeForSubmission()` atomically excludes later comments and stores a stable submission ID plus a prompt containing the immutable patch and that exact comment snapshot. If submission was already frozen, it returns the same record. `PromptQueue.enqueueOnce()` returns only after that logical prompt is durably accepted; retrying its submission ID cannot enqueue a second prompt.

### Why record mutations need a critical region

`DiffReviewRecords` builds on the facet's scoped Session data (`values.md`): typed durable values in an extension-owned namespace. Each storage call is atomic, but an application read-modify-write cycle spans multiple calls and therefore multiple awaits. Concurrent service calls can interleave between them.

Concrete failure without serialization — two users press submit at the same time:

```text
submit A: getValue(record)          → status "open"
submit B: getValue(record)          → status "open"
submit A: setValue(frozen, subm-A)
submit B: setValue(frozen, subm-B)  → overwrites A's freeze
→ enqueueOnce(subm-A) and enqueueOnce(subm-B) both run: two prompts for one review
```

Each `setValue()` was atomic; the *cycle* was not. The same window exists in `addComment()` between checking the status and replacing the record.

In the one-authoritative-worker model, the simplest fix is a per-review **critical region**: a FIFO, non-reentrant async mutex whose `run(signal, fn)` admits one pending function at a time. Every operation that reads and mutates an existing review — including `addComment()`, `freezeForSubmission()`, and `complete()` — uses the same region for that review ID:

```ts
async freezeForSubmission(reviewId, context) {
	return regionFor(reviewId).run(context.abortSignal, async () => {
		const stored = await session.getValue(reviewRecord(reviewId), context);
		if (stored === undefined) throw new RemoteServiceError("review_not_found", `Unknown review: ${reviewId}`);

		const current = stored.value;
		if (current.status === "submission_pending") return current; // idempotent retry

		const submissionId = newSubmissionId();
		const frozen = {
			...current,
			revision: current.revision + 1,
			status: "submission_pending",
			submission: {
				submissionId,
				prompt: renderReviewPrompt(current.patch, current.comments),
			},
		};
		await session.setValue(reviewRecord(reviewId), frozen, context);
		return frozen;
	});
}
```

`revision` is application-owned and monotonic per review. The region makes `current.revision + 1` unambiguous; the session-global storage `seq` remains storage ordering metadata and is not projected into the record. `publish()` may therefore compare returned record revisions directly.

A caller aborted while queued is removed from the FIFO and rejects without invoking `fn`. Once admitted, the region releases in `finally`; cancellation and storage failure may reject the operation, while each individual storage transition remains atomic. Stateful validation stays inside the region, but user interaction and unrelated I/O stay outside it. A repository method must not call another method that acquires the same non-reentrant region, and region entries may be discarded after a completed review has no owner or waiters.

The requirement is one linearizable read-modify-write path per review, not specifically a mutex. A storage compare-and-swap operation or a repository capability that serializes mutations could replace the process-local region. Durable settlement idempotency (`memoOnce()`, `enqueueOnce()`) solves crash and retry behavior after the record transition; it does not replace serialization of the transition itself.

### Session facet

The Session facet follows a short reconstruction algorithm:

```text
activation
→ list pending review records
→ add one DiffReviews instance per record
→ publish document and activity state
→ resume any frozen submission through enqueueOnce()

createReview()
→ snapshot the diff
→ create the durable record
→ add its DiffReviews instance

submit()
→ atomically freeze comments and submission ID
→ publish "submitting"
→ enqueueOnce(submission ID, prompt)
→ delete the completed record and close the instance
```

Every mutation commits before `publish()`. Concurrent comment and submit calls are ordered by the record repository: a comment committed first is in the frozen prompt; a comment arriving after the freeze receives `review_closed`. `complete()` deletes only the matching frozen record, and `close()` is idempotent.

The startup scan reconstructs every open keyed instance from durable records. A `submission_pending` record resumes delivery through `enqueueOnce()` and then closes. Thus a crash before prompt acceptance retries the prompt, while a crash after acceptance but before cleanup observes the same submission ID and only completes cleanup.

### TUI and web facets

The extension owns its TUI and browser widgets. TUI and web facets both `observe(DiffReviews, ...)`. Each observer opens a native panel from the hydrated document, subscribes to activity, forwards comment and submit actions to the service, and closes the panel when the instance context aborts. The TUI also registers a command that calls `DiffReviewManager.createReview()`; a web surface may expose the same operation as a button.

`observe()` begins only after both state members hydrate. The panel receives the immutable document once, and subscribing to `activity` immediately renders current comments without retransmitting the patch on every edit. A late client sees the same pending review. Activity updates continue while `nextAction()` waits. Each sidebar action carries a fresh presentation-created `Context`; the longer-lived observation context controls only panel lifetime. When submission closes the keyed instance, every panel's observation context aborts and its `finally` block disposes the subscription and widget.

The submitted prompt contains the immutable patch and all frozen comments in one request. Abbreviated:

```text
Review this patch and address all comments:

<stored immutable patch>

- src/parser.ts, new line 42 — Armin: Preserve the original error cause.
- src/ui.ts, new line 18 — Jane: Keep this state visible after reconnect.
```

Comment authors give the sidebar its basic multiplayer presence. A current-viewer roster or cursors would be separate live state and would not be written to the review record.

This is a shared review, not a generic room primitive. Keyed services provide discovery and reactive lifetime; the record repository provides temporary durability; the prompt queue provides idempotent handoff into the session.

## Deferred: delta-based replicated state

> **Deferred:** `DeltaState` is not part of the initial facet-service or RPC contract. Add it only after a concrete feature demonstrates that full-value `ReplicatedState` updates are too expensive and the same pattern appears in more than one feature.

A real replication gap remains. Some authoritative values are large, change frequently, and must support late joiners. `ReplicatedState` hydrates and reconnects correctly but sends a complete value on every update.

A canvas is one possible example: joining requires the complete document, while dragging a shape should ideally send only that operation. With today's primitives, the facet must accept complete `ReplicatedState` updates or keep the high-frequency projection process-local. A concrete feature should establish the snapshot, delta, gap-recovery, and flow-control requirements before another remote primitive is added.

### Possible future primitive

If repeated implementations justify extraction, a future `DeltaState<S, D>` could retain `ReplicatedState`'s synchronous value and snapshot hydration while delivering typed deltas after hydration. The provider would expose only `apply(delta, context)` and `replace(value, context)`; a shared pure reducer would update consumer replicas.

The shared reducer is pure and deterministic. `apply()` synchronously reduces the provider's value and publishes one delta; `replace()` publishes a new authoritative snapshot. Business snapshots and deltas contain no transport revision. The host stamps revisions within the provider binding, buffers updates racing hydration, applies only consecutive frames, and requests a fresh snapshot after a gap or reconnect.

Supporting this requires an explicit RPC member kind. The providing object carries the `DeltaState` definition ID; the provider announces that ID in member metadata; and the consuming host resolves the same imported definition before applying deltas locally. The contract is adopted only together with that registration and hydration protocol.

`DeltaState` would solve only live replication. It would not provide durable storage, mutation serialization, multi-writer merging, offline editing, or automatic mutation replay. A durable canvas would still serialize its own mutations, persist an admitted delta before publishing it, and coordinate log compaction with appends. Durable log cursors remain application/storage metadata and are independent of the host's transport revision.
