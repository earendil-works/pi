// The MCP plugin's server facet: the manager (the owner's configuration, the leases of session workers with their
// projects' configurations, the environments and where sessions work, the supervisor of instances, the OAuth sign-ins)
// and its view per principal: a session worker's (its locations and calls, fenced to the session's current worker; its
// leases released when the view ends) and the owner's (every instance with its errors and sign-ins, restart, signing in
// and out); and the sign-in routes browsers open.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arr, int, obj, str, union, unknown } from "@earendil-works/pi-schema";
import {
	type Ctx,
	contribute,
	defineFacet,
	defineTypedState,
	deriveTyped,
	type Facet,
	type Factory,
	followNative,
	forbidden,
	type HandleOf,
	isOwner,
	isWorker,
	type Location,
	LocationSchema,
	literal,
	locationText,
	nativeOf,
	PluginError,
	type Ref,
	type Self,
	type SessionLock,
	sameLocation,
	signalOf,
	unsafe,
	until,
	type Watchable,
	type WorkerPrincipal,
} from "@p2/app/v1";
import { Hosts, Server, type WorkerState } from "@p2/app/v1/server";
import type { EnvConfig } from "../envs/config.ts";
import { EnvManagers, EnvService } from "../envs/contract.ts";
import { Catalog, type Session, SessionLocks } from "../sessions/contract.ts";
import { type Child, ChildStore } from "../subagents/contract.ts";
import { type OwnerConfig, OwnerConfigFile, type OwnerConfigState, type OwnerServer } from "./config.ts";
import { type Instance, InstanceSchema, MCP_ACCEPTS, Mcp, McpManager, type ProjectFile } from "./contract.ts";
import { McpCredentials } from "./credentials.ts";
import type { ConnectEnv } from "./environments.ts";
import { type ClientInfo, Instances, RECONNECT } from "./instances.ts";
import { heldLease, type Lease, type ProjectSource, releaseGeneration, setLocations } from "./leases.ts";
import { oauthServerOf, type Placement, place, type WorkEnvironments } from "./placement.ts";
import { LoopbackProbe } from "./probe.ts";
import { signInRoutes } from "./routes.ts";
import { type OAuthServer, SIGN_IN_TIMEOUT_MS, type SignInRedirect, SignIns } from "./sign-in.ts";

/** A tool call as the worker's view takes it; the manager's adds the caller. */
type CallArgs = { location: Location; server: string; tool: string; args: Record<string, unknown> };
/** Who calls the manager: a session's worker generation and incarnation. */
type Caller = { session: string; generation: number; incarnation: string };
/** Where a session works, and its project files there. */
type LocationsArgs = { locations: Location[]; projects?: ProjectFile[] };

/** How the manager reaches environments, given its object (whose `EnvService` it declared). */
export type EnvConnector = (self: Self) => ConnectEnv;

/** How long a worker's view outlives its last reference: a worker object restarting does not end its leases. */
const VIEW_LINGER_MS = 30_000;

/**
 * Environments of envs.json through the envs plugin's SSH manager (its keys and known hosts; read at each connect, as
 * it reopens with a reload).
 */
const sshEnvironments: EnvConnector = (self) => {
	const managers = nativeOf(self, EnvManagers, "The SSH manager");
	return (name, config) => managers().manager.connection(name, config);
};

export default mcpServerFacet(VIEW_LINGER_MS, sshEnvironments);

/**
 * The facet, with views lingering `viewLingerMs` after their last reference, reaching environments through `connector`
 * (tests shorten the one and replace the other).
 */
export function mcpServerFacet(viewLingerMs: number, connector: EnvConnector): Facet {
	return defineFacet((host) => {
		host.serve(McpManager, managerFactory(connector));
		host.serve(Mcp, view, { linger: viewLingerMs, accepts: MCP_ACCEPTS });
		contribute(host, "p2.mcp-routes", signInRoutes);
	});
}

/** The leases of session workers; kept across a reload of the plugin, so the new supervisor starts what they use. */
const Leased = defineTypedState("p2.mcp.leases", {
	schema: obj({
		leases: arr(
			obj({
				session: str(),
				location: LocationSchema,
				project: union([
					obj({ kind: literal("none") }),
					obj({ kind: literal("file"), text: str() }),
					obj({ kind: literal("unreadable"), error: str() }),
				]),
				generation: int(),
				incarnation: str(),
			}),
		),
	}),
	version: 1,
	initial: (): { leases: Lease[] } => ({ leases: [] }),
});

/**
 * What a restarted manager's natives start from (in memory, kept across a reload's restart; never shown): the servers
 * last read validly (a new reader may first see a save caught half-way) and the instances as last listed (their tools
 * stay listed until their servers answer again).
 */
const Memento = defineTypedState("p2.mcp.memento", {
	schema: obj({ servers: unsafe<OwnerServer[]>(unknown()), errors: arr(str()), instances: arr(InstanceSchema) }),
	version: 1,
	initial: () => ({ servers: [], errors: [], instances: [] }),
});

/**
 * The manager: the file, the supervisor and the sign-ins as natives it follows, the leases as its document, and the
 * routine that starts and closes instances as they change.
 */
function managerFactory(connector: EnvConnector): Factory<typeof McpManager> {
	return (_params, self) => {
		const server = self.get(Server, {});
		const envs = self.get(EnvService, {});
		const catalog = self.get(Catalog, {});
		const store = self.get(ChildStore, {});
		const work = deriveTyped(self, [catalog.sessions, store.children], ([sessions, children]) =>
			workEnvironments(sessions, children),
		);
		const locks = self.get(SessionLocks, {});
		const leased = self.state(Leased);
		const memento = self.state(Memento);
		const placed = placements();
		const connect = connector(self);
		const file = self.open(
			async () => {
				const opened = new OwnerConfigFile(server.info.value.dataDir, memento.value);
				await opened.observer.start();
				return opened;
			},
			(opened) => opened.observer.close(),
		);
		const signIns = self.open(
			async () =>
				new SignIns(
					new McpCredentials(server.info.value.dataDir),
					"p2",
					(name) => instances.value.reconnect(name),
					SIGN_IN_TIMEOUT_MS,
				),
			(opened) => opened.close(),
		);
		const instances = self.open(
			async () => {
				const info = await clientInfo(server.info.value.app);
				const opened = new Instances(info, RECONNECT, memento.value.instances, connect, (oauth) =>
					signIns.value.authProvider(oauth),
				);
				// What the leases use now starts at once (after a restart with the tools listed before), so the supervisor's
				// first list already shows it; derives compute only after the natives opened, so placed from the sources.
				const at = workEnvironments(catalog.sessions.value, store.children.value);
				opened.reconcile(placed(file.value.state, leased.value.leases, envs.configs.value, at, locks.locks.value));
				return opened;
			},
			(opened) => opened.close(),
		);
		const probe = self.open(
			async () => new LoopbackProbe(),
			(opened) => opened.close(),
		);
		// The file, the supervisor and the sign-ins as they are: every method's change is made before it returns.
		const configured = followNative(
			self,
			(changed) => file.value.subscribe(changed),
			() => file.value.state,
		);
		const listed = followNative(
			self,
			(changed) => {
				const stops = [instances.value.subscribe(changed), signIns.value.subscribe(changed)];
				return () => {
					for (const stop of stops) stop();
				};
			},
			() => ({ instances: instances.value.list(), signIns: signIns.value.list() }),
		);
		keepMemento(self, memento, configured, listed);
		const placement = () =>
			placed(configured.value, leased.value.leases, envs.configs.value, work.value, locks.locks.value);
		// The current configuration, leases, environments and places of work, then every change of them, start and close
		// instances; methods that change leases reconcile at once too, so a call right after `setLocations` finds its
		// instance.
		const inputs = deriveTyped(
			self,
			[configured, leased, envs.configs, work, locks.locks],
			([config, { leases }, configs, at, locked]) => ({
				config,
				leases,
				envs: configs,
				work: at,
				locks: locked,
			}),
		);
		self.on(inputs, async ({ value }) =>
			instances.value.reconcile(placed(value.config, value.leases, value.envs, value.work, value.locks)),
		);
		const leases = deriveTyped(self, [inputs], ([value]) =>
			placed(value.config, value.leases, value.envs, value.work, value.locks).leases.map(
				({ lease, servers, errors }) => ({
					session: lease.session,
					location: lease.location,
					instances: [...new Set(servers.values())],
					errors: [...errors],
				}),
			),
		);
		return {
			instances: deriveTyped(self, [listed], ([value]) => value.instances),
			signIns: deriveTyped(self, [listed], ([value]) => value.signIns),
			leases,
			errors: self.derive([configured], ([{ errors, failure }]) =>
				failure === null ? [...errors] : [...errors, `${failure}; keeping the last valid servers`],
			),
			...managerMethods(leased, () => instances.value, placement),
			...signInMethods(
				configured,
				() => signIns.value,
				() => probe.value,
			),
		};
	};
}

/**
 * Keeps the memento a restarted manager's natives start from: the servers of each valid read, and the instances once
 * one of them lists other tools (instances closing change no tools, so a manager ending writes nothing).
 */
function keepMemento(
	self: Self,
	memento: HandleOf<typeof Memento>,
	configured: Watchable<OwnerConfigState>,
	listed: Watchable<{ readonly instances: readonly Instance[] }>,
): void {
	self.on(configured, async ({ value: { servers, errors, failure } }, ctx) => {
		if (failure === null) await memento.change((draft) => Object.assign(draft, { servers, errors }), ctx);
	});
	self.on(listed, async ({ value: { instances } }, ctx) => {
		const remembered = new Map(memento.value.instances.map((instance) => [instance.id, toolNames(instance)]));
		if (instances.some((instance) => remembered.get(instance.id) !== toolNames(instance)))
			await memento.change((draft) => Object.assign(draft, { instances }), ctx);
	});
}

/** The names of the tools `instance` lists, as one string. */
const toolNames = (instance: Instance): string => instance.tools.map((tool) => tool.name).join("\n");

/** The environments each session's conversations work on, as the catalog and the subagent store record them. */
function workEnvironments(
	sessions: readonly Session[],
	children: Readonly<Record<string, readonly Child[]>>,
): WorkEnvironments {
	return Object.fromEntries(
		sessions.map((session) => [session.id, sessionEnvironments(session, children[session.id])]),
	);
}

/** The environments of `session`'s conversations: its own, then its subagents' own locations' (archived ones too). */
function sessionEnvironments(session: Session, children: readonly Child[] | undefined): (string | null)[] {
	return [...new Set([session.env ?? null, ...(children ?? []).flatMap((child) => child.location?.env ?? [])])];
}

/**
 * `place`, computed once per input: the routine, the leases' view and the methods share it. Where sessions work is
 * compared by content: the catalog changes with every turn's activity, mostly without moving a session.
 */
function placements(): (
	config: OwnerConfig,
	leases: readonly Lease[],
	envs: Readonly<Record<string, EnvConfig>>,
	work: WorkEnvironments,
	locks: Readonly<Record<string, SessionLock>>,
) => Placement {
	let last:
		| { config: OwnerConfig; leases: readonly Lease[]; envs: object; work: string; placement: Placement }
		| undefined;
	return (config, leases, envs, work, locks) => {
		const at = JSON.stringify([work, locks]);
		if (last?.config !== config || last.leases !== leases || last.envs !== envs || last.work !== at)
			last = { config, leases, envs, work: at, placement: place(config, leases, envs, work, locks) };
		return last.placement;
	};
}

/** The manager's methods: the lease rules applied on the leases' line, calls through the leased instance, restarts. */
function managerMethods(leased: HandleOf<typeof Leased>, instances: () => Instances, placement: () => Placement) {
	return {
		setLocations: async ({ locations, projects = [], ...caller }: Caller & LocationsArgs, ctx: Ctx) => {
			const places = locations.map((location) => ({ location, project: projectAt(location, projects) }));
			let refused: string | undefined;
			// Decided on the object's line: two generations' concurrent calls see each other's leases.
			await leased.change((draft) => {
				const result = setLocations(draft.leases, caller, places);
				if (result.kind === "refused") refused = result.reason;
				else draft.leases = result.leases;
			}, ctx);
			if (refused !== undefined) throw forbidden(refused);
			instances().reconcile(placement());
			return null;
		},
		releaseLeases: async ({ session, generation }: { session: string; generation: number }, ctx: Ctx) => {
			await leased.change((draft) => {
				draft.leases = releaseGeneration(draft.leases, session, generation);
			}, ctx);
			instances().reconcile(placement());
			return null;
		},
		call: async ({ location, server: name, tool, args, ...caller }: Caller & CallArgs, ctx: Ctx) => {
			const held = heldLease(leased.value.leases, caller, location);
			if (held.kind === "stale") throw forbidden("Another worker of this session holds its MCP servers");
			if (held.kind === "none") throw new Error(`No MCP servers are leased at ${locationText(location)}`);
			const id = placement()
				.leases.find((placed) => placed.lease === held.lease)
				?.servers.get(name);
			if (id === undefined) throw new Error(`MCP server "${name}" is not configured at ${locationText(location)}`);
			return instances().call(id, tool, args, signalOf(ctx));
		},
		restart: async ({ instance }: { instance: string }) => {
			instances().restart(instance);
			return null;
		},
	};
}

/** The manager's sign-in methods: flows of the owner's OAuth servers, the callback route's completion, the probe. */
function signInMethods(configured: Watchable<OwnerConfigState>, signIns: () => SignIns, probe: () => LoopbackProbe) {
	const oauthServer = (name: string): OAuthServer => {
		const server = configured.value.servers.find((candidate) => candidate.name === name);
		const oauth = server === undefined ? undefined : oauthServerOf(server);
		if (oauth === undefined) throw new PluginError("not_found", `No MCP server "${name}" signs in with OAuth`);
		return oauth;
	};
	return {
		// The flow is listed before the answer: a caller following `signIns` for its end sees it under way first.
		beginSignIn: ({ server, redirect }: { server: string; redirect: SignInRedirect }) =>
			asPluginError(signIns().begin(oauthServer(server), redirect)),
		completeSignIn: ({ state, code, iss, error }: { state: string; code?: string; iss?: string; error?: string }) =>
			signIns().complete(
				error !== undefined || code === undefined
					? { state, error: error ?? "The authorization response has no code" }
					: { state, code, ...(iss === undefined ? {} : { iss }) },
			),
		pasteSignIn: async ({ id, redirectUrl }: { id: string; redirectUrl: string }) => {
			await signIns().paste(id, redirectUrl);
			return null;
		},
		cancelSignIn: async ({ id }: { id: string }) => {
			signIns().cancel(id);
			return null;
		},
		signOut: async ({ server }: { server: string }) => {
			await asPluginError(signIns().signOut(oauthServer(server)));
			return null;
		},
		probe: async ({ origin }: { origin: string }) => ({ url: await probe().url(origin) }),
	};
}

/** `promise`, its failures as the caller's errors with their messages (a discovery that failed, an unset variable). */
async function asPluginError<T>(promise: Promise<T>): Promise<T> {
	try {
		return await promise;
	} catch (error) {
		if (error instanceof PluginError) throw error;
		throw new PluginError("sign_in", error instanceof Error ? error.message : String(error));
	}
}

/** The project configuration the worker found at `location`: none, the file's text, or why it could not read it. */
function projectAt(location: Location, projects: readonly ProjectFile[]): ProjectSource {
	const file = projects.find((candidate) => sameLocation(candidate.location, location));
	if (file === undefined) return { kind: "none" };
	return "text" in file ? { kind: "file", text: file.text } : { kind: "unreadable", error: file.error };
}

/** The view: the owner's, a session worker's, nobody else's. */
const view: Factory<typeof Mcp> = (_params, principal, self) => {
	if (!isOwner(principal) && !isWorker(principal))
		throw forbidden("MCP servers are for the owner and session workers");
	const manager = self.get(McpManager, {});
	if (isOwner(principal))
		return {
			variant: "owner",
			members: {
				instances: manager.instances,
				errors: deriveTyped(self, [manager.errors, manager.leases], ([errors, leases]) => [
					...errors,
					...leases.flatMap((lease) => lease.errors.map((error) => `session ${lease.session}: ${error}`)),
				]),
				signIns: manager.signIns,
				restart: (args, ctx) => manager.restart(args, ctx),
				signIn: ({ server }, ctx) => manager.beginSignIn({ server, redirect: { kind: "loopback" } }, ctx),
				paste: (args, ctx) => manager.pasteSignIn(args, ctx),
				cancelSignIn: (args, ctx) => manager.cancelSignIn(args, ctx),
				signOut: (args, ctx) => manager.signOut(args, ctx),
			},
		};
	return { variant: "worker", members: workerView(principal, manager, self) };
};

/** A session worker's view: its session's servers (without the owner's errors), its locations and calls. */
function workerView(principal: WorkerPrincipal, manager: Ref<typeof McpManager>, self: Self) {
	const { session, generation } = principal;
	const current = currentWorker(self.get(Hosts, {}), principal);
	// When the view ends (its worker's link went, and the linger passed), its leases go. A reload keeps them: the next
	// attempt is the same worker.
	self.open(
		async () => null,
		async (_value, reason, context) => {
			if (reason.kind === "end") await manager.releaseLeases({ session, generation }, context);
		},
	);
	return {
		servers: deriveTyped(self, [manager.instances, manager.leases], ([instances, leases]) => {
			const used = new Set(leases.filter((lease) => lease.session === session).flatMap((lease) => lease.instances));
			return instances.filter((instance) => used.has(instance.id)).map(({ error: _error, ...instance }) => instance);
		}),
		errors: deriveTyped(self, [manager.leases], ([leases]) =>
			leases.filter((lease) => lease.session === session).flatMap((lease) => lease.errors),
		),
		setLocations: async (args: LocationsArgs, ctx: Ctx) => {
			await current(ctx);
			return manager.setLocations({ session, generation, incarnation: ctx.incarnation, ...args }, ctx);
		},
		call: async ({ location, server, tool, args }: CallArgs, ctx: Ctx) => {
			await current(ctx);
			return manager.call({ session, generation, incarnation: ctx.incarnation, location, server, tool, args }, ctx);
		},
	};
}

/**
 * Refuses all but the session's running current generation, as the location tools do. A worker may ask before the
 * server published its start: the check waits for that (the wait ends with the caller's call).
 */
function currentWorker(
	hosts: Ref<typeof Hosts>,
	{ session, generation }: WorkerPrincipal,
): (ctx: Ctx) => Promise<void> {
	const known = (state: WorkerState | undefined) =>
		state !== undefined && (state.generation > generation || (state.generation === generation && state.running));
	return async (ctx) => {
		const published = hosts.workers.value[session];
		const state = known(published)
			? published
			: (await until(hosts.workers, (workers) => known(workers[session]), ctx))[session];
		if (!state?.running || state.generation !== generation) throw forbidden("stale worker");
	};
}

/** p2 as MCP servers see it: its name and the app's version. */
async function clientInfo(app: string): Promise<ClientInfo> {
	// The app's own package.json: a version string.
	const { version } = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as { version: string };
	return { name: "p2", version };
}
