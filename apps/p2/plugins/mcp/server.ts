// The MCP plugin's server facet: the manager (the owner's configuration, the leases of session workers with their
// projects' configurations, the environments and where sessions work, the supervisor of instances) and its view per
// principal: a session worker's (its locations and calls, fenced to the session's current worker; its leases released
// when the view ends) and the owner's (every instance with its errors, restart).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arr, int, nul, obj, str, union, unknown } from "@earendil-works/pi-schema";
import {
	type Ctx,
	defineFacet,
	defineTypedState,
	deriveTyped,
	type Facet,
	type Factory,
	forbidden,
	type HandleOf,
	isOwner,
	isWorker,
	type Location,
	LocationSchema,
	literal,
	locationText,
	type Native,
	nativeOf,
	type Ref,
	type Self,
	sameLocation,
	signalOf,
	unsafe,
	until,
	untilAborted,
	type Watchable,
	type WorkerPrincipal,
} from "@p2/app/v1";
import { Hosts, Server, type WorkerState } from "@p2/app/v1/server";
import type { EnvConfig } from "../envs/config.ts";
import { EnvManagers, EnvService } from "../envs/contract.ts";
import { Catalog, type Session } from "../sessions/contract.ts";
import { type Child, ChildStore } from "../subagents/contract.ts";
import { type OwnerConfig, OwnerConfigFile, type OwnerServer } from "./config.ts";
import { InstanceSchema, Mcp, McpManager, type ProjectFile } from "./contract.ts";
import type { ConnectEnv } from "./environments.ts";
import { type ClientInfo, Instances, RECONNECT } from "./instances.ts";
import { heldLease, type Lease, type ProjectSource, releaseGeneration, setLocations } from "./leases.ts";
import { type Placement, place, type WorkEnvironments } from "./placement.ts";

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
		host.serve(Mcp, view, { linger: viewLingerMs });
	});
}

/**
 * The owner's configuration as last validly read, and why the last read failed (null: it did not). In memory, kept
 * across a reload: a new reader seeing a save caught half-way keeps these servers.
 */
const Configured = defineTypedState("p2.mcp.config", {
	schema: obj({ servers: unsafe<OwnerServer[]>(unknown()), errors: arr(str()), failure: union([str(), nul()]) }),
	version: 1,
	initial: () => ({ servers: [], errors: [], failure: null }),
});

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

/** The supervisor's instances as it last listed them; a reload's new supervisor starts with their tools. */
const Listed = defineTypedState("p2.mcp.instances", {
	schema: obj({ instances: arr(InstanceSchema) }),
	version: 1,
	initial: () => ({ instances: [] }),
});

/** The manager: its documents, the file and the supervisor as natives, and the routines that keep them in step. */
function managerFactory(connector: EnvConnector): Factory<typeof McpManager> {
	return (_params, self) => {
		const server = self.get(Server, {});
		const envs = self.get(EnvService, {});
		const work = workEnvironments(self.get(Catalog, {}), self.get(ChildStore, {}), self);
		const configured = self.state(Configured);
		const leased = self.state(Leased);
		const listed = self.state(Listed);
		const placed = placements();
		const placement = () => placed(configured.value, leased.value.leases, envs.configs.value, work.value);
		const connect = connector(self);
		const file = self.open(
			async () => {
				const opened = new OwnerConfigFile(server.info.value.dataDir);
				await opened.observer.start();
				return opened;
			},
			(opened) => opened.observer.close(),
		);
		const instances = self.open(
			async () => {
				// After a reload the leases are still here: the routine below starts what they use, with the tools listed
				// before. Not here: natives open before derives compute.
				const info = await clientInfo(server.info.value.app);
				return new Instances(info, RECONNECT, listed.value.instances, connect);
			},
			(opened) => opened.close(),
		);
		self.onLive((ctx) => followNatives(file, instances, configured, listed, ctx));
		// The current configuration, leases, environments and places of work, then every change of them, start and close
		// instances; methods that change leases reconcile at once too, so a call right after `setLocations` finds its
		// instance.
		const inputs = deriveTyped(
			self,
			[configured, leased, envs.configs, work],
			([config, { leases }, configs, at]) => ({
				config,
				leases,
				envs: configs,
				work: at,
			}),
		);
		self.on(inputs, async ({ value }) =>
			instances.value.reconcile(placed(value.config, value.leases, value.envs, value.work)),
		);
		const leases = deriveTyped(self, [inputs], ([value]) =>
			placed(value.config, value.leases, value.envs, value.work).leases.map(({ lease, servers, errors }) => ({
				session: lease.session,
				location: lease.location,
				instances: [...new Set(servers.values())],
				errors: [...errors],
			})),
		);
		return {
			instances: deriveTyped(self, [listed], ([value]) => value.instances),
			leases,
			errors: self.derive([configured], ([{ errors, failure }]) =>
				failure === null ? [...errors] : [...errors, `${failure}; keeping the last valid servers`],
			),
			...managerMethods(leased, () => instances.value, placement),
		};
	};
}

/** The environments each session's conversations work on, as the catalog and the subagent store record them. */
function workEnvironments(
	catalog: Ref<typeof Catalog>,
	store: Ref<typeof ChildStore>,
	self: Self,
): Watchable<WorkEnvironments> {
	return deriveTyped(self, [catalog.sessions, store.children], ([sessions, children]) =>
		Object.fromEntries(sessions.map((session) => [session.id, sessionEnvironments(session, children[session.id])])),
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
) => Placement {
	let last:
		| { config: OwnerConfig; leases: readonly Lease[]; envs: object; work: string; placement: Placement }
		| undefined;
	return (config, leases, envs, work) => {
		const at = JSON.stringify(work);
		if (last?.config !== config || last.leases !== leases || last.envs !== envs || last.work !== at)
			last = { config, leases, envs, work: at, placement: place(config, leases, envs, work) };
		return last.placement;
	};
}

/** Copies what the file reads and the supervisor lists into the manager's documents until `ctx` ends. */
async function followNatives(
	file: Native<OwnerConfigFile>,
	instances: Native<Instances>,
	configured: HandleOf<typeof Configured>,
	listed: HandleOf<typeof Listed>,
	ctx: Ctx,
): Promise<void> {
	// Changes heard while this routine stops would change state with an ended ctx.
	const show = (): void => {
		if (signalOf(ctx).aborted) return;
		void listed
			.change((draft) => {
				draft.instances = instances.value.list();
			}, ctx)
			.catch(() => {});
	};
	const stops = [
		file.value.subscribe((read) => {
			if (signalOf(ctx).aborted) return;
			void configured
				.change((draft) => {
					// An invalid read keeps the servers last read validly.
					if (read.kind === "invalid") draft.failure = read.failure;
					else if (read.kind === "valid")
						Object.assign(draft, {
							servers: [...read.config.servers],
							errors: [...read.config.errors],
							failure: null,
						});
				}, ctx)
				.catch(() => {});
		}),
		instances.value.subscribe(show),
	];
	show();
	try {
		await untilAborted(ctx);
	} finally {
		for (const stop of stops) stop();
	}
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
				restart: (args, ctx) => manager.restart(args, ctx),
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
