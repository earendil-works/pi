// Locals, registries and natives the server host provides to plugins (Chord v2), and the server's core facet.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { constant, defineRegistry, defineState, local, method, untilAborted } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { CredentialStore, ModelsStore } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { arr, bool, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { Access } from "./access.ts";
import {
	type Ctx,
	defineFacet,
	type Facet,
	type FacetHost,
	forbidden,
	type Host,
	keyedRegistry,
	type Self,
	serveKeyed,
	signalOf,
} from "./chord.ts";
import { isGuest, isOwner, type P2Principal } from "./principals.ts";
import { record } from "./schema.ts";

export const ServerInfoSchema = obj({
	/** The p2 app directory (`apps/p2`): its sources, docs and vendored files, for facets that start or describe them. */
	app: str(),
	dataDir: str(),
	fake: bool(),
	/** Hosts reachable through a trusted HTTPS tunnel besides loopback (`P2_ALLOWED_HOSTS`). */
	allowedHosts: arr(str()),
	/** The listening port. */
	port: num(),
});
export type ServerInfo = Static<typeof ServerInfoSchema>;

/**
 * The server process (lifetime "host"): its configuration (constant), and revocation. `revokeGuests` ends every object
 * of one guest's principals, here and in workers: their references end `forbidden/revoked`, and the server closes
 * their sockets.
 */
export const Server = local("p2.server", {
	version: 2,
	params: {},
	members: {
		info: ServerInfoSchema,
		/** Ends remote owners' live links and objects (one device, or every remote owner). */
		revokeOwners: method(obj({ device: opt(str()) })),
		revokeGuests: method(obj({ id: str() })),
	},
});

/** Overrides of p2's Resources (tests only): e.g. `createModels` with a fixture provider. */
export type ServerResourceOptions = {
	readonly createModels?: (credentials: CredentialStore, modelsStore: ModelsStore) => MutableModels;
};

/** A lifecycle step of a running worker that the server calls over its route (`WorkerBoundary`). */
export type RelocationSteps = {
	readonly prepare: () => Promise<string | undefined>;
	readonly update: () => Promise<void>;
	readonly move: () => Promise<void>;
	readonly cancel: () => Promise<void>;
};

/** The session workers (the server's `SessionWorkers`): their generations, and the lifecycle steps plugins run. */
export interface SessionWorkerControl {
	/** Generation of the session's latest worker (0: never started). */
	generation(session: string): number;
	/** Sessions whose worker is running now. */
	running(): string[];
	/**
	 * Moves a session, serialized with starts, stops and pauses: a stopped worker only gets `update`; a running one is
	 * fenced (`prepare`), updated, then follows in place (`move`), restarted from the catalog when it cannot.
	 */
	relocate(session: string, steps: RelocationSteps): Promise<void>;
	/** Runs `work` while the session's worker is stopped (its store closed), restarting one that ran afterwards. */
	pause(
		session: string,
		prepare: () => Promise<string | undefined>,
		work: () => Promise<void>,
		doing: string,
	): Promise<void>;
	/** Owner-requested retry: stops the previous instance and clears the failure before a fresh reference. */
	retry(session: string): Promise<void>;
	stop(session: string): Promise<void>;
	/** Every change of a worker's state. */
	subscribe(listener: (event: HostEvent) => void): () => void;
}

/** The server's natives, contributed by the core facet from the start. */
export type ServerParts = {
	readonly resourceOptions: ServerResourceOptions;
	readonly workers: SessionWorkerControl;
	/**
	 * Runs `fn` in a root of the server's own (`SERVER`), not a caller's: lifecycle steps a caller giving up (an aborted
	 * call, a closed tab) must not cut off, and code outside Chord calls (Durable tools, routes). `signal` ends it early.
	 */
	readonly root: <T>(fn: (ctx: Ctx) => Promise<T>, signal?: AbortSignal) => Promise<T>;
};
export const ServerNatives = defineRegistry<ServerParts, ServerParts | undefined>("p2.server-natives", { version: 1 });

/** The server's natives for a factory (the core contributes them before anything activates). */
export function serverOf(self: Self): () => ServerParts {
	const natives = self.registry(ServerNatives);
	return () => {
		const parts = natives.value;
		if (parts === undefined) throw new Error("No server natives (the core facet contributes them)");
		return parts;
	};
}

/** Where a request came from: loopback (`http://127.0.0.1:<port>`), or an allowed tunnel host (always https). */
export type RequestOrigin = {
	readonly origin: string;
	readonly remote: boolean;
	readonly port: number;
	/** The Radius shell origin allowed to frame the UI (relayed requests only); everything else may not frame it. */
	readonly relayShellOrigin?: string;
	/**
	 * A signed-in Radius user other than the owner (relayed requests only). Radius verified who they are and admitted
	 * them because a session is shared with their email; authenticators map them to what is shared with them now.
	 */
	readonly relayUser?: RelayUser;
};

/** A person Radius authenticated: their Radius user ID and normalized, verified email. */
export type RelayUser = { readonly id: string; readonly email: string };

/** Who sent an HTTP request (undefined: nobody authenticated, e.g. a guest before joining) and from where. */
export type RequestAccess = { readonly principal: P2Principal | undefined; readonly origin: RequestOrigin };

/**
 * Trusted transports may authenticate a marked loopback request as remote, before ordinary Host checks. Without a
 * principal, the authenticators decide who the request is (a relayed Radius user: see `RequestOrigin.relayUser`).
 */
export type RequestResolver = (request: IncomingMessage, ctx: Ctx) => RequestAccess | undefined;
export const RequestResolvers = keyedRegistry<RequestResolver>("p2.request-resolvers");

/**
 * HTTP handlers by `METHOD /path`, or `METHOD /prefix/*` for every path below a prefix (the longest match wins).
 * The server dispatches each request in a root of its code version; handlers authorize the request themselves.
 */
export type RouteHandler = (
	request: IncomingMessage,
	response: ServerResponse,
	access: RequestAccess,
	ctx: Ctx,
) => void | Promise<void>;
export const Routes = keyedRegistry<RouteHandler>("p2.routes");

/** Authorized WebSocket upgrades by exact path. Plugins own their byte channels, not the server host. */
export type UpgradeHandler = (
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	principal: P2Principal,
	ctx: Ctx,
) => void | Promise<void>;
export const Upgrades = keyedRegistry<UpgradeHandler>("p2.upgrades");

/** The handler for `method` and `path`: exact, then `/a/b/*`, `/a/*`, `/*`. */
export function findRoute(
	table: ReadonlyMap<string, RouteHandler>,
	method: string,
	path: string,
): RouteHandler | undefined {
	const exact = table.get(`${method} ${path}`);
	if (exact !== undefined) return exact;
	const segments = path.split("/");
	for (let end = segments.length - 1; end >= 1; end--) {
		const route = table.get(`${method} ${segments.slice(0, end).join("/")}/*`);
		if (route !== undefined) return route;
	}
	return undefined;
}

/**
 * Authenticates requests from tunnel hosts (loopback is the device owner): the first principal returned wins.
 * Example: the sharing plugin maps a guest cookie to its current grant.
 */
export type Authenticator = (
	request: IncomingMessage,
	origin: RequestOrigin,
	ctx: Ctx,
) => P2Principal | undefined | Promise<P2Principal | undefined>;
export const Authenticators = keyedRegistry<Authenticator>("p2.authenticators");

/**
 * Where people a session is shared with by email open it, through a transport that authenticates them (the brain's
 * page in the Radius shell), or undefined while unknown. Without one, sharing with people is unavailable.
 */
export type ShareUrl = (session: string) => string | undefined;
export const ShareUrls = keyedRegistry<ShareUrl>("p2.share-urls");

/**
 * Whether a principal other than the owner may reach a session (its worker host, its files): any entry saying yes
 * admits. Example: the sharing plugin admits a guest of that session whose grant is current.
 */
export type SessionAuthorizer = (principal: P2Principal, session: string, ctx: Ctx) => boolean | Promise<boolean>;
export const SessionAccess = keyedRegistry<SessionAuthorizer>("p2.session-access");

/** Owner, the server's own code, or a principal some `SessionAccess` entry (the registry's value) admits to `session`. */
export async function mayReach(
	access: ReadonlyMap<string, SessionAuthorizer>,
	principal: P2Principal,
	session: string,
	ctx: Ctx,
): Promise<boolean> {
	if (isOwner(principal) || principal.kind === "host" || principal.kind === "server") return true;
	if (!isGuest(principal)) return false;
	for (const authorize of access.values()) {
		if (await authorize(principal, session, ctx)) return true;
	}
	return false;
}

/**
 * Contributions to a worker's spawn parameters (`WorkerInit.values[key]`). Each runs before a session worker
 * starts; a throw refuses the start (e.g. an archived or unknown session).
 */
export type WorkerInitContribution = (session: string, context: Context) => JsonValue | Promise<JsonValue>;
export const WorkerInitValues = keyedRegistry<WorkerInitContribution>("p2.worker-init");

export const WorkerStateSchema = obj({
	running: bool(),
	generation: num(),
	pid: opt(num()),
	/** A failed start is sticky until an explicit retry. */
	error: opt(str()),
});
export type WorkerState = Static<typeof WorkerStateSchema>;
export type HostEvent = { readonly session: string } & WorkerState;

/** Session worker processes: which run (by session ID), and stopping one (archive). */
export const Hosts = local("p2.hosts", {
	version: 2,
	params: {},
	members: {
		workers: record(WorkerStateSchema),
		stop: method(obj({ session: str() })),
	},
});

const Workers = defineState("p2.hosts.workers", {
	schema: obj({ workers: record(WorkerStateSchema) }),
	version: 1,
	initial: () => ({ workers: {} }),
});

/** Serves the base keyed registries of the server (the core facet; test hosts without one). */
export function serveServerRegistries(facet: FacetHost): void {
	for (const registry of [
		RequestResolvers,
		Routes,
		Upgrades,
		Authenticators,
		ShareUrls,
		SessionAccess,
		WorkerInitValues,
	])
		serveKeyed(facet, registry as typeof Routes);
}

/**
 * The server's core facet: its start data and revocation (`Server`), its natives, the base registries, the workers'
 * states (`Hosts`) and who the caller is (`Access`).
 */
export function serverCore(host: Host, info: ServerInfo, parts: ServerParts): Facet {
	return defineFacet((facet, self) => {
		serveServerRegistries(facet);
		facet.serve(ServerNatives, { compose: (table) => table[0]?.value });
		self.contribute(ServerNatives, parts);
		facet.serve(Server, () => ({
			info: constant(info),
			revokeOwners: async ({ device }, ctx) => {
				if (device !== undefined) host.revoke({ device }, ctx);
				else host.revoke({ owners: "remote" }, ctx);
				return null;
			},
			revokeGuests: async ({ id }, ctx) => {
				host.revoke({ guest: id }, ctx);
				return null;
			},
		}));
		facet.serve(Hosts, (_params, self) => {
			const state = self.state(Workers);
			self.onLive(async (ctx) => {
				const stop = parts.workers.subscribe(({ session, ...worker }) => {
					// An exit heard while this routine stops would change the state with an ended ctx.
					if (signalOf(ctx).aborted) return;
					void state
						.change((draft) => {
							// A late exit of an older generation never overwrites a newer worker.
							if ((draft.workers[session]?.generation ?? 0) > worker.generation) return;
							draft.workers[session] = worker;
						}, ctx)
						.catch(() => {});
				});
				try {
					await untilAborted(ctx);
				} finally {
					stop();
				}
			});
			return {
				workers: self.derive([state], ([value]) => value.workers),
				stop: async ({ session }) => {
					await parts.workers.stop(session);
					return null;
				},
			};
		});
		facet.serve(Access, (_params, principal) => {
			if (isOwner(principal)) return { variant: "owner", members: {} };
			if (!isGuest(principal)) throw forbidden("owners and guests only");
			// One object per grant revision: the grant never changes within it.
			const { id, name, email, home, sessions } = principal;
			return {
				variant: "guest",
				members: {
					grant: constant({
						id,
						name,
						session: home,
						mode: sessions[home] ?? "view",
						sessions,
						...(email === undefined ? {} : { email }),
					}),
				},
			};
		});
	});
}
