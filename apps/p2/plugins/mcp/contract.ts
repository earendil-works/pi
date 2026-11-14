// MCP servers' contracts: the server's manager (host-internal: every MCP connection and process, by instance and lease,
// and the OAuth sign-ins) and its view per principal (`Mcp`: a session worker sets its locations and calls tools; the
// owner sees and restarts instances and signs in and out of HTTP servers).

import type { CallToolResult, ToolAnnotations } from "@earendil-works/pi-mcp";
import { arr, int, nul, obj, oneOf, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	evolve,
	LocationSchema,
	literal,
	local,
	method,
	record,
	remote,
	serverHost,
	unsafe,
} from "@p2/app/v1";

/** An MCP tool as its server lists it (`tools/list`). */
const ToolSchema = obj({
	name: str(),
	title: opt(str()),
	description: opt(str()),
	inputSchema: unsafe<Record<string, unknown>>(unknown()),
	outputSchema: opt(unsafe<Record<string, unknown>>(unknown())),
	annotations: opt(unsafe<ToolAnnotations>(unknown())),
});
/** An MCP tool as its server lists it: name, title, description, schemas and annotations. */
export type McpTool = Static<typeof ToolSchema>;

/** Where an instance runs: the p2 host, or an environment of `envs.json`. */
const RunsOnSchema = union([literal("host"), obj({ env: str() })]);
/** Where an instance runs: `"host"` (the p2 host) or `{ env }` (an environment of `envs.json`). */
export type RunsOn = Static<typeof RunsOnSchema>;

/** One running (or failed) server process or connection, as `Mcp` version 2 (b4afdddf4) released it. */
const InstanceSchemaV2 = obj({
	id: str(),
	server: str(),
	source: oneOf(["owner", "project"]),
	location: union([LocationSchema, nul()]),
	runsOn: RunsOnSchema,
	auth: opt(literal("oauth")),
	status: oneOf(["starting", "connected", "sign-in", "failed"]),
	error: opt(str()),
	tools: arr(ToolSchema),
});

/** One running (or failed) server process or connection, as `Mcp` version 3 (6f1a96e1d) released it. */
const InstanceSchemaV3 = obj({
	id: str(),
	server: str(),
	source: oneOf(["owner", "project"]),
	location: union([LocationSchema, nul()]),
	runsOn: RunsOnSchema,
	auth: opt(literal("oauth")),
	status: oneOf(["starting", "connected", "sign-in", "failed"]),
	error: opt(str()),
	tools: arr(ToolSchema),
	instructions: opt(str()),
});

/** One running (or failed) server process or connection. */
export const InstanceSchema = obj({
	id: str(),
	server: str(),
	source: oneOf(["owner", "project"]),
	/** The location it serves; null: shared by every session, or an HTTP server. */
	location: union([LocationSchema, nul()]),
	runsOn: RunsOnSchema,
	/** `oauth`: an HTTP server that signs in with OAuth (no `Authorization` header configured). */
	auth: opt(literal("oauth")),
	/** `sign-in`: the HTTP server asked for authorization. */
	status: oneOf(["starting", "connected", "sign-in", "failed"]),
	error: opt(str()),
	/** Kept while it reconnects. */
	tools: arr(ToolSchema),
	/** The server's instructions from `initialize`, if it sent any; kept while it reconnects. */
	instructions: opt(str()),
	/** What the server offers, in a sentence, as its configuration's `description` says (absent: not configured). */
	description: opt(str()),
});
/**
 * One instance as the manager lists it: its server, where it runs, its status, error, tools, instructions and
 * configured description.
 */
export type Instance = Static<typeof InstanceSchema>;

/**
 * A sign-in to an HTTP server under way (`waiting`: for the browser's redirect back or a pasted redirect URL) or failed,
 * one per server: returning to a loopback callback on the p2 host, or to p2's `/mcp/callback` route. No URL, state or
 * code.
 */
export const SignInSchema = obj({
	id: str(),
	server: str(),
	via: oneOf(["loopback", "route"]),
	status: oneOf(["waiting", "failed"]),
	error: opt(str()),
});
/** A sign-in as the owner sees it. */
export type SignIn = Static<typeof SignInSchema>;

/** A begun sign-in: signed in at once (stored tokens refreshed), or the authorization URL to open. */
const SignInStartSchema = union([obj({ kind: literal("authorized") }), obj({ kind: literal("redirect"), url: str() })]);

/** Completes sign-in `id` with the final redirect URL the owner copied from the browser's address bar. */
const PasteSchema = obj({ id: str(), redirectUrl: str({ maxLength: 8192 }) });

/** The instances one session's lease at a location uses, and why entries of its project were refused. */
const LeaseViewSchema = obj({ session: str(), location: LocationSchema, instances: arr(str()), errors: arr(str()) });

/** The largest project `mcp.json` a worker sends. */
export const PROJECT_FILE_MAX_CHARS = 256 * 1024;

/**
 * A project's `<cwd>/.pi/mcp.json` at one of the locations, as the worker read it there: its text (checked by the
 * manager: a trust boundary), or why it could not be read.
 */
const ProjectFileSchema = union([
	obj({ location: LocationSchema, text: str({ maxLength: PROJECT_FILE_MAX_CHARS }) }),
	obj({ location: LocationSchema, error: str({ maxLength: 2000 }) }),
]);
/** A project's `mcp.json` at a location: its text, or why it could not be read. */
export type ProjectFile = Static<typeof ProjectFileSchema>;

/** Where a session's conversations work, and the project files found there (absent: none). */
const Locations = { locations: arr(LocationSchema), projects: opt(arr(ProjectFileSchema)) };

/** `tools/call`'s result as the server sent it. */
const CallResultSchema = unsafe<CallToolResult>({ type: "object" });

/** Tool arguments: any JSON object (a record of any values); the MCP server checks them. */
const ArgsSchema = record(unknown());

/** What every worker request names: the session's worker it comes from (filled in by the view). */
const Caller = { session: str(), generation: int(), incarnation: str() };

/**
 * The MCP manager (server, host lifetime): the owner configuration, the instances and their leases. Every MCP process
 * and connection is here; session workers reach it only through `Mcp`.
 *
 * Authority: a lease places servers only at a location on an environment the session's conversations work on as the
 * server records them (the catalog's session location, the subagent store's own locations); the cwd there is the
 * worker's to choose, as its agent can run commands anywhere on that machine. A project's servers are code the worker
 * names (it reads the file), so this fences stale or confused workers to their machines, not a compromised worker
 * process: it runs unsandboxed on the p2 host, its subagent store entries are its own reports, and its location tool
 * moves the session to any configured environment.
 */
export const McpManager = local("p2.mcp.manager", {
	// 3: an instance's `instructions`; 4: its configured `description`.
	version: 4,
	params: {},
	members: {
		instances: arr(InstanceSchema),
		signIns: arr(SignInSchema),
		/** The leases of every session and location, with the instances each uses. */
		leases: arr(LeaseViewSchema),
		/** Why entries of `mcp.json` were skipped (the leases' projects' errors are in `leases`). */
		errors: arr(str()),
		/**
		 * Leases the configured servers (and the projects') at exactly `locations` for the caller's session (its leases
		 * elsewhere end); a newer generation's leases refuse an older generation.
		 */
		setLocations: method(obj({ ...Caller, ...Locations })),
		/** Ends the leases of one worker generation (its view ended). */
		releaseLeases: method(obj({ session: str(), generation: int() })),
		/** Calls `tool` of `server` at `location`, through the instance the lease there uses. */
		call: method(
			obj({ ...Caller, location: LocationSchema, server: str(), tool: str(), args: ArgsSchema }),
			CallResultSchema,
		),
		restart: method(obj({ instance: str() })),
		/**
		 * Begins a sign-in to HTTP server `server`, replacing its current one: the browser returns to a loopback callback on
		 * the p2 host, or to p2's callback route at `url`.
		 */
		beginSignIn: method(
			obj({
				server: str(),
				redirect: union([obj({ kind: literal("loopback") }), obj({ kind: literal("route"), url: str() })]),
			}),
			SignInStartSchema,
		),
		/** Completes the route sign-in whose `state` the authorization response on the callback route carries. */
		completeSignIn: method(
			obj({ state: str(), code: opt(str()), iss: opt(str()), error: opt(str()) }),
			obj({ server: str() }),
		),
		pasteSignIn: method(PasteSchema),
		cancelSignIn: method(obj({ id: str() })),
		/** Forgets the server's OAuth credentials; its instances reconnect without them. */
		signOut: method(obj({ server: str() })),
		/**
		 * A loopback probe URL for a sign-in page on `origin`: only a browser on the p2 host reaches it (see
		 * `LoopbackProbe`).
		 */
		probe: method(obj({ origin: str() }), obj({ url: str() })),
	},
});

/** `Mcp` version 2, as b4afdddf4 released it (pages built before version 3 still hold it). */
const McpV2 = remote("p2.mcp", {
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			state: {
				/** The instances the session's leases use, shared ones included; `error` is the owner's only. */
				servers: arr(InstanceSchemaV2),
				/** Why the session's leases refused entries of its projects' `mcp.json` (or a location). */
				errors: arr(str()),
			},
			methods: {
				/**
				 * Where the session's conversations work now, with the project files there: its servers are leased there,
				 * and only there.
				 */
				setLocations: method(obj(Locations)),
				call: method(
					obj({ location: LocationSchema, server: str(), tool: str(), args: ArgsSchema }),
					CallResultSchema,
				),
			},
		},
		owner: {
			/** `errors`: the owner's `mcp.json`'s, then every lease's (by session). */
			state: { instances: arr(InstanceSchemaV2), errors: arr(str()), signIns: arr(SignInSchema) },
			methods: {
				restart: method(obj({ instance: str() })),
				/**
				 * Begins a sign-in returning to a loopback callback on the p2 host (pasting its final URL works from anywhere).
				 * Browsers open `/mcp/sign-in/<server>` instead, which also finds out where the browser runs.
				 */
				signIn: method(obj({ server: str() }), SignInStartSchema),
				paste: method(PasteSchema),
				cancelSignIn: method(obj({ id: str() })),
				signOut: method(obj({ server: str() })),
			},
		},
	},
});

/** `Mcp` version 3, as 6f1a96e1d released it: instances with the server's `instructions`. */
const McpV3 = evolve(McpV2, (e) =>
	e.state("worker", "servers", arr(InstanceSchemaV3)).state("owner", "instances", arr(InstanceSchemaV3)),
);

/** One of a session's leases as its worker sees it: the location and the instances it uses, one per server. */
const SessionLeaseSchema = obj({ location: LocationSchema, instances: arr(str()) });
/** A lease of the worker's session: where, and the IDs of the instances it uses (one per server). */
export type SessionLease = Static<typeof SessionLeaseSchema>;

/**
 * MCP servers as a principal sees them: a session worker sets its locations and calls tools (its session, generation
 * and incarnation from the link), the owner sees every instance with its errors and sign-ins, restarts them and signs in
 * and out of HTTP servers. Nobody else gets one. 3: an instance's `instructions` (the server's own, from `initialize`);
 * 4: its configured `description`, and the worker's `leases` (which instances each location uses: a project override
 * decides per lease, also for instances serving every location); the provider still serves 2 and 3 (`MCP_ACCEPTS`).
 */
export const Mcp = evolve(McpV3, (e) =>
	e
		.state("worker", "servers", arr(InstanceSchema))
		.addState("worker", "leases", arr(SessionLeaseSchema))
		.state("owner", "instances", arr(InstanceSchema)),
);

/** What `Mcp` versions 2 and 3's holders get: instances without what those versions lack. */
export const MCP_ACCEPTS: AcceptsTable<typeof Mcp> = {
	2: { state: { worker: { servers: asV2 }, owner: { instances: asV2 } } },
	3: { state: { worker: { servers: asV3 }, owner: { instances: asV3 } } },
};

function asV2(instances: readonly Instance[]) {
	return instances.map(({ instructions: _instructions, description: _description, ...instance }) => instance);
}

function asV3(instances: readonly Instance[]) {
	return instances.map(({ description: _description, ...instance }) => instance);
}

/** The p2 page that signs the owner in to HTTP server `server` (relative: it opens on the origin the viewer uses). */
export function signInLink(server: string): string {
	return `/mcp/sign-in/${encodeURIComponent(server)}`;
}
