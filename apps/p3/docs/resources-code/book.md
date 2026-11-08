---
title: p3: resources in code
cover: Resources / In Code
kicker: A design sketch in code · p3 · 2026-11-08
subtitle: How model providers, MCP servers, machines, search and mail are defined on the server, selected for a session, and used by its worker, in about as much code as it takes
stats:
  - 5 | example resource kinds, each a plugin
  - 3 | core pieces: the vault, selectors, the selection
  - 1 | server view per kind per session (params {}, the worker's principal names the session)
  - 0 | credentials a worker can refresh
note: |
  A design sketch for the owner (2026-11-08), after the model stress test (`model-stress/report.md`) and the decision
  "no per-run authority; what is brought into a session is the control". It shows the shape in code; names are
  proposals, Chord and pi-ai APIs are real (`remote`, `local`, `defineTable`, `self.query`, keyed `at`, `self.on`,
  `self.writable`, `self.contribute`; pi-ai's `createProvider`, `AuthResult`). Single user first; what multi-user adds is
  marked. Not decided, not built.
colophon: p3 resources in code · sketch, first edition · 2026-11-08
---

# Before we begin {.preface}

A resource is something a session can use: a model provider, an MCP server, a machine, a search API, a mailbox. Every
kind is a plugin, and every plugin has the same three parts:

1. **On the server, its definitions:** a table of the resources of its kind, their secrets in the vault.
2. **On the server, one view per session:** a remote object with empty params whose worker variant knows its session
   from the worker's principal (the link stamped it), reads that session's selection, and gives the worker exactly what
   it may use: data, pushed credentials, or methods the server runs.
3. **On the worker, its use:** a host-lifetime object that holds that view and contributes to a registry (the
   harness's model providers, Durable extensions with tools, environments).

Core adds only what every kind needs: the **vault** (secrets, refreshed once, on the server), **selectors** (plugins say
which resources a session gets), and the **selection** (core composes the selectors per session, failing closed).

## Six things to know

:::findings
1. **A resource reference is a kind plus an id**: `{ kind: "p3.models", id: "anthropic" }`. Kinds are constants their
   plugins export; ids are the plugin's.
2. **A binding is a resource in one session's selection**, with the login it uses: none, lent (an account of its
   bringer), or the session owner's own.
3. **Selectors decide bindings.** Include selectors add, restrict selectors keep only what they allow. Core composes them
   per session on the server, live; until every selector has answered, a session's selection is empty (fail closed).
4. **Each kind serves one per-session view with params `{}`.** The worker holds `SessionModels {}`; the server's factory
   reads `principal.session` and that session's bindings. No dynamic params, no extra lookups on the worker.
5. **Two delivery patterns.** Pushed credentials when the worker does the work itself (model streams: pi-ai's
   `AuthResult` with an expiry, refreshed by the server). Server-run methods when the secret must not leave the server
   (search, mail, MCP): the worker calls, the server checks the selection and does it.
6. **Removing a resource from a session is a state change.** The view's state drops it, the worker's contribution
   follows; a call through a removed binding is refused by the server.
:::

# Core {#core lede="The vault, the selection, and the selectors: everything the kinds share."}

```ts
// @p3/app/v1: what every host sees

/** A resource: its kind (a constant of the plugin that owns it) and the plugin's id for it. */
export const ResourceRef = obj({ kind: str(), id: str() });
export type ResourceRef = Static<typeof ResourceRef>;

/** Which login a binding uses. */
export const Login = union([
	obj({ kind: lit("none") }),                                   // a local stdio server, a machine without a key
	obj({ kind: lit("lent"), account: str() }),                   // an account of whoever brought the resource in
	obj({ kind: lit("own") }),                                    // the session owner's own account for this service
]);

/** One resource in one session's selection. */
export const Binding = obj({ resource: ResourceRef, login: Login, by: str() });   // `by`: the selector's plugin
export type Binding = Static<typeof Binding>;
```

```ts
// @p3/app/v1/server: what server facets use

/** Secrets, per plugin, key and owner; one write at a time per entry (pi-ai's `CredentialStore.modify` semantics). */
export const Vault = local("p3.vault", {
	version: 1,
	params: {},
	members: {
		read: method(VaultKey, unknown()),
		/** Read, change and write one entry under its lock; the function runs on the server (a refresh happens once). */
		modify: method(obj({ key: VaultKey, change: str() }), unknown()),  // `change`: a registered changer, see below
	},
});
export const VaultKey = obj({ plugin: str(), key: str(), owner: union([obj({ user: str() }), obj({ instance: lit(true) })]) });

/**
 * A selector: for a session, its bindings (include) or the resources it allows (restrict), live. Contributed by
 * plugins; composed by core.
 */
export type Selector =
	| { readonly mode: "include"; select(session: SessionRef, self: Self): Watchable<readonly Binding[]> }
	| { readonly mode: "restrict"; select(session: SessionRef, self: Self): Watchable<readonly ResourceRef[]> };
export const Selectors = defineRegistry<Selector, readonly Selector[]>("p3.selectors", { version: 1 });

/** The composed selection of every session: a keyed member, one entry per session (pinned with `at(session)`). */
export const Selection = local("p3.selection", {
	version: 1,
	params: {},
	members: { bindings: keyed(arr(Binding)) },
});
```

Core's selection object, on the server:

```ts
// plugins/selection/server.ts (built-in)
host.serve(Selection, (_params, self) => {
	const selectors = self.registry(Selectors);
	const sessions = self.get(SessionCatalog, {});
	const bindings = self.state(SelectionDoc);           // keyed by session id, in memory: recomputed at start
	self.on(sessions.ids, async ({ value: ids }, ctx) => {
		for (const id of ids) await recompute(id, selectors.value, bindings, ctx);
	});
	// …and again whenever any selector's watchable for a session changes (one routine per session, elided)
	return { bindings };
});

/** Union of the includes, minus what any restrict leaves out; nothing until every selector answered (fail closed). */
function compose(includes: readonly (readonly Binding[])[], restricts: readonly (readonly ResourceRef[])[]): Binding[] {
	const allowed = (ref: ResourceRef) => restricts.every((list) => list.some((each) => same(each, ref)));
	return dedupe(includes.flat()).filter((binding) => allowed(binding.resource));
}
```

How a kind's server view uses it: the worker's principal names the session, the factory pins that session's
bindings and keeps those of its own kind.

```ts
// @p3/app/v1/server: a helper every kind uses
export function bindingsOf(self: Self, principal: P3Principal, kind: string): Watchable<readonly Binding[]> {
	if (principal.kind !== "worker") throw forbidden("session workers only");
	const selection = self.get(Selection, {});
	const mine = selection.bindings.at(principal.session);
	return self.derive([mine], ([all]) => all.filter((binding) => binding.resource.kind === kind));
}
```

# Model Providers {#models lede="Pushed credentials: the worker streams from the provider itself."}

```ts
// plugins/models/contract.ts
export const MODELS = "p3.models";

/** One provider as a session's worker may use it: its models and the request auth, refreshed by the server. */
export const ProviderForSession = obj({
	id: str(), label: str(), api: str(),                         // pi-ai api id: "anthropic", "openai-responses"
	models: arr(unknown()),                                       // pi-ai ProviderModel[] from the catalog
	auth: obj({ apiKey: opt(str()), headers: opt(map(str())), baseUrl: opt(str()), env: opt(map(str())), expires: opt(num()) }),
});

export const SessionModels = remote("p3.models.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { worker: { state: { providers: arr(ProviderForSession) }, methods: {} } },
});
```

```ts
// plugins/models/server.ts
const Providers = defineTable("p3.models.providers", {
	version: 1,
	columns: { id: str(), label: str(), api: str(), owner: json(Owner, { version: 1 }) },
	key: ["id"],
});

host.serve(ModelStore, (_params, self) => {            // host-lifetime: definitions, catalogs, auth refresh
	const providers = self.table(Providers);
	const vault = self.get(Vault, {});
	return {
		/** pi-ai request auth for one binding: the right login's credential, refreshed once if it expires soon. */
		authFor: async ({ binding, session }, ctx) => resolveAuth(binding, session, vault, ctx),   // pi-ai OAuthAuth.refresh / ApiKeyAuth.resolve
		catalog: async ({ id }, ctx) => catalogOf(id, ctx),
		// add, remove, … (the sheet's methods)
	};
});

host.serve(SessionModels, (_params, principal, self) => {
	const mine = bindingsOf(self, principal, MODELS);
	const store = self.get(ModelStore, {});
	const providers = self.state(Pushed);                        // in memory: what the worker gets
	self.on(mine, async ({ value: bindings }, ctx) => {
		for (;;) {
			const pushed = await Promise.all(bindings.map(async (binding) => ({
				...(await store.describe({ id: binding.resource.id }, ctx)),
				auth: await store.authFor({ binding, session: sessionOf(principal) }, ctx),
			})));
			await providers.change((draft) => { draft.list = pushed; }, ctx);
			await sleep(untilFirstExpiry(pushed) - 60_000, ctx);   // refresh a minute before the first expiry
		}
	});
	return { variant: "worker", members: { providers: self.derive([providers], ([p]) => p.list) } };
});
```

```ts
// plugins/models/worker.ts
host.serve(ModelsInSession, (_params, self) => {
	const session = self.get(SessionModels, {});
	const contributed = self.writable<readonly Provider[]>([]);
	self.contribute(ModelProviders, contributed);                // the harness composes pi-ai Models from these
	self.on(session.providers, ({ value }) => {
		contributed.set(value.map((pushed) => createProvider({
			id: pushed.id, name: pushed.label, models: pushed.models,
			api: streamsFor(pushed.api),                         // pi-ai's implementation for that API
			auth: { apiKey: { name: pushed.label, resolve: async () => {
				const current = session.providers.value.find((p) => p.id === pushed.id)?.auth;
				return current && { auth: current, source: "p3" };       // always the latest push
			} } },
		})));
	});
	return {};
});
```

# MCP Servers {#mcp lede="Server-run methods: processes and logins stay on the server; the worker sees tools and calls them."}

```ts
// plugins/mcp/contract.ts
export const MCP = "p3.mcp";
export const Tool = obj({ server: str(), name: str(), description: str(), schema: unknown() });

export const SessionMcp = remote("p3.mcp.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { tools: arr(Tool) },
			methods: { call: method(obj({ server: str(), tool: str(), args: unknown() }), unknown()) },
		},
	},
});
```

```ts
// plugins/mcp/server.ts
const Servers = defineTable("p3.mcp.servers", {              // definitions: one row per server resource
	version: 1,
	columns: {
		id: str(), label: str(), owner: json(Owner, { version: 1 }),
		// http: an address and a login; stdio: a program on the server machine (admin only)
		transport: json(union([obj({ kind: lit("http"), url: str() }), obj({ kind: lit("stdio"), command: str(), args: arr(str()) })]), { version: 1 }),
	},
	key: ["id"],
});
const Checkouts = defineTable("p3.mcp.checkouts", {          // a checkout's .pi/mcp.json on an env: enabled per checkout
	version: 1,
	columns: { env: str(), dir: str(), server: str(), enabled: bool(), config: json(unknown(), { version: 1 }) },
	key: ["env", "dir", "server"],
});

host.serve(SessionMcp, (_params, principal, self) => {
	const mine = bindingsOf(self, principal, MCP);
	const clients = self.get(McpClients, {});                  // the supervisor: one client per (server, login), on the server
	const tools = self.derive([mine, clients.tools], ([bindings, all]) => toolsOf(bindings, all));
	return {
		variant: "worker",
		members: {
			tools,
			call: async ({ server, tool, args }, ctx) => {
				// The selection is the authority: a binding removed a moment ago is refused here.
				const binding = mine.value.find((b) => b.resource.id === server);
				if (binding === undefined) throw forbidden(`${server} is not in this session`);
				return clients.call({ binding, session: sessionOf(principal), tool, args }, ctx);
			},
		},
	};
});
```

```ts
// plugins/mcp/worker.ts
host.serve(McpInSession, (_params, self) => {
	const session = self.get(SessionMcp, {});
	const extension = self.writable(mcpExtension([], session));
	self.contribute(Extensions, extension);                      // one Durable extension with every MCP tool of the session
	self.on(session.tools, ({ value }) => extension.set(mcpExtension(value, session)));
	return {};
});

/** Durable tools that call the server: `execute` is `session.call`, under the tool's Durable context. */
function mcpExtension(tools: readonly Tool[], session: Held<typeof SessionMcp>): Extension {
	return defineExtension({
		name: "mcp",
		tools: tools.map((tool) => defineTool({
			name: `${tool.server}_${tool.name}`, description: tool.description, parameters: tool.schema,
			execute: (args, api) => chord((ctx) => session.call({ server: tool.server, tool: tool.name, args }, ctx), api.context),
		})),
	});
}
```

A checkout's MCP servers run in its env: their client in the supervisor connects through that env's machine (the
machines kind below), and they are bindings only when the checkout's row is `enabled` and the env is in the session.

# Machines {#machines lede="Where tools run: the local machine, an SSH host, a sandbox."}

```ts
// plugins/machines/contract.ts
export const MACHINES = "p3.machines";
export const MachineForSession = obj({ id: str(), label: str(), kind: oneOf("local", "ssh", "sandbox"), home: str() });

export const SessionMachines = remote("p3.machines.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { machines: arr(MachineForSession) },
			methods: {
				/** Opens a channel to a machine for this session's tools: an exec/file stream the server relays (keys stay here). */
				open: method(obj({ machine: str() }), obj({ channel: str() })),
			},
		},
	},
});
```

```ts
// plugins/machines/worker.ts
host.serve(MachinesInSession, (_params, self) => {
	const session = self.get(SessionMachines, {});
	const environments = self.writable<ReadonlyMap<string, ExecutionEnv>>(new Map());
	self.contribute(Environments, environments);                // the harness's env lookup: a conversation's cwd names a machine
	self.on(session.machines, ({ value }) => environments.set(new Map(value.map((m) => [m.id, remoteEnv(m, session)]))));
	return {};
});
```

The local machine (the laptop p3 runs on, single user) is a machine with login `none`. An SSH machine's key stays in the
vault: the server holds the connection and relays the channel; the worker never sees the key. (Whether tool output
should stream directly from the env to the worker for speed is a measurement for later; the contract does not change.)

# Search and Mail {#proxy lede="Two more server-run kinds, to show how small a kind is."}

```ts
// plugins/web-search/server.ts: an instance key in the vault, a tool for sessions that have it
export const SEARCH = "p3.search";
host.serve(SessionSearch, (_params, principal, self) => {
	const mine = bindingsOf(self, principal, SEARCH);
	const vault = self.get(Vault, {});
	return { variant: "worker", members: {
		available: self.derive([mine], ([b]) => b.length > 0),
		search: async ({ query }, ctx) => {
			if (mine.value.length === 0) throw forbidden("search is not in this session");
			const key = await vault.read({ plugin: SEARCH, key: "brave", owner: { instance: true } }, ctx);
			return brave(query, key as string, ctx);
		},
	} };
});
// plugins/web-search/worker.ts: one tool, present while `available`
```

```ts
// plugins/gmail/server.ts: a user's Google login, server-run reads and drafts
export const GMAIL = "p3.gmail";
host.serve(SessionMail, (_params, principal, self) => {
	const mine = bindingsOf(self, principal, GMAIL);
	const accounts = self.get(GoogleAccounts, {});              // the Google login plugin's refresh, behind the vault
	return { variant: "worker", members: {
		boxes: self.derive([mine], ([b]) => b.map((x) => x.resource.id)),
		list: async ({ box, query }, ctx) => gmail(await accounts.tokenFor(bindingFor(mine, box), ctx)).list(query, ctx),
		draft: async ({ box, to, subject, body }, ctx) => gmail(await accounts.tokenFor(bindingFor(mine, box), ctx)).draft({ to, subject, body }, ctx),
	} };
});
```

# Selectors {#selectors lede="Who decides what a session gets: three small plugins."}

```ts
// plugins/defaults/server.ts: single user, no projects: my resources marked "default" go into every session of mine
self.contribute(Selectors, {
	mode: "include",
	select: (session, self) => {
		const defaults = self.get(MyDefaults, {});              // a table: resources the user marked default
		return self.derive([defaults.byUser], ([all]) => (all[session.owner] ?? []).map((resource) => ({
			resource, login: { kind: "own" }, by: "defaults",
		})));
	},
});

// plugins/projects/server.ts: a session in a project gets the project's resources, and only those
self.contribute(Selectors, { mode: "include", select: (session, self) => projectBindings(session, self) });
self.contribute(Selectors, { mode: "restrict", select: (session, self) => projectResourcesOrEverything(session, self) });

// plugins/lock-down/server.ts: a session can be narrowed to a chosen subset
self.contribute(Selectors, { mode: "restrict", select: (session, self) => chosenOrEverything(session, self) });
```

(A restrict for a session it does not concern allows everything: `projectResourcesOrEverything` returns every resource
for a session outside any project. A contributor contributes one value per registry, so a plugin with both an include
and a restrict contributes one entry holding both; shown as two for clarity.)

:::sequence animate | Colin removes his MCP server from the project while a session uses it.
actor page "page" "Colin" blue
actor projects "projects plugin" "server, facts" muted
actor selection "Selection" "server, core" accent
actor view "SessionMcp" "server, per session"
actor worker "session worker" "Durable"
page -> projects: remove { project pi, resource mcp:radius }
projects => projects: commit the fact
projects --> selection: its include selector's watchable changes
selection => selection: recompute S1: mcp:radius gone
selection --> view: bindings.at(S1) changes
view --> worker: state: tools without radius_*
worker -> worker: extension.set: the next phase has no radius tools
worker -> view: (a call already sent) call radius_search
view --> worker: refused: radius is not in this session
:::

# What Multi-User Adds {.epilogue lede="Single user needs everything above and nothing more."}

Single user: one user, the `defaults` selector, logins `none` or `own`, every resource the user's. Everything above
works as written.

Multi-user adds, without changing the shapes: lent logins (`login: { kind: "lent", account }`, resolved by `authFor` to
the bringer's account); global resources (owner `{ instance: true }`, their secrets the instance's); a policy plugin
that restricts (a selector in restrict mode: what the session's people may use) and decides who may bring what (the
projects plugin's methods ask it). The stress test's other multi-user findings stay their own design track: execution on
the server machine (server-run stdio servers, credential commands, checkout plugins), cloud credentials read from disk
(Bedrock, Vertex), SSH delegation, revocation (a reference keeps its last values: pushed credentials must expire or be
withdrawn by the server, never kept by a failed view).
