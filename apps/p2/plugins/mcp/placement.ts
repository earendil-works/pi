// Where each MCP instance runs and which leases share it: for every session's lease at a location, the owner's servers
// it enables (one process per session and location, or one for everybody) and its project's own servers (always at
// that location), each with how it connects: a program on the p2 host or on an environment, or an HTTP server.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpStdioServerConfig } from "@earendil-works/pi-mcp";
import { type Location, locationText } from "@p2/app/v1";
import { envRevision } from "@p2/app/v1/node";
import type { EnvConfig } from "../envs/config.ts";
import type { OwnerConfig, OwnerServer } from "./config.ts";
import type { RunsOn } from "./contract.ts";
import type { Lease } from "./leases.ts";
import { type ProjectConfig, type ProjectServer, parseProjectConfig } from "./project.ts";
import type { OAuthServer } from "./sign-in.ts";

/** A program on an environment, started through its pi-env daemon; paths resolve once the daemon tells its system. */
export type RemoteConnect = {
	readonly kind: "remote";
	/** The environment's name in envs.json, and its configuration there. */
	readonly environment: string;
	readonly config: EnvConfig;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	/** As configured (`.` when not): relative to `base`, `~` the remote home. */
	readonly cwd: string;
	/** The location's cwd when the location is on this environment (also the client's root), else null: the home. */
	readonly base: string | null;
	/** `${NAME}` in `env` values comes from the p2 host's environment (the owner's servers only). */
	readonly hostVariables: boolean;
};

/** How an instance connects: a program on the p2 host or on an environment, an HTTP server, or why it cannot run. */
export type Connect =
	| {
			readonly kind: "host";
			readonly command: string;
			readonly args: readonly string[];
			readonly env: Readonly<Record<string, string>>;
			readonly cwd: string;
			/** `file://` URLs offered as the client's roots (an instance on its location's machine only). */
			readonly roots: readonly string[];
			/** `${NAME}` in `env` values comes from the p2 host's environment (the owner's servers only). */
			readonly hostVariables: boolean;
	  }
	| RemoteConnect
	| {
			readonly kind: "http";
			readonly url: string;
			readonly headers: Readonly<Record<string, string>>;
			/** Signs in with OAuth (no `Authorization` header configured), as in pi. */
			readonly oauth: OAuthServer | undefined;
	  }
	| { readonly kind: "unplaced"; readonly reason: string };

/** One instance to run: its identity and where and how it runs. Equal configuration and key give an equal ID. */
export type InstanceSpec = {
	readonly id: string;
	readonly server: string;
	readonly source: "owner" | "project";
	readonly location: Location | null;
	readonly runsOn: RunsOn;
	readonly connect: Connect;
	/** Per-request timeout from the configuration, in milliseconds. */
	readonly timeoutMs: number | undefined;
};

/** One lease placed: the instance of each server it uses, by server name, and why entries of its project were refused. */
export type PlacedLease = {
	readonly lease: Lease;
	readonly servers: ReadonlyMap<string, string>;
	readonly errors: readonly string[];
};

/** What the leases need: the instances each lease uses, and the shared instances that may stay without one. */
export type Placement = {
	readonly instances: ReadonlyMap<string, InstanceSpec>;
	readonly leases: readonly PlacedLease[];
	/** Shared instances of enabled owner servers: they stay running while configured, leased or not. */
	readonly kept: ReadonlySet<string>;
};

/**
 * The environments each session's conversations work on, by session, as the server records them (the session's own,
 * its subagents' own locations'); null is the p2 host.
 */
export type WorkEnvironments = Readonly<Record<string, readonly (string | null)[]>>;

/**
 * The instances `config`'s servers and the leases' projects need, on the environments of `envs`. A lease at a location
 * on an environment its session does not work on (`work`) gets no servers: a worker can only lease where its
 * conversations can already run commands.
 */
export function place(
	config: OwnerConfig,
	leases: readonly Lease[],
	envs: Readonly<Record<string, EnvConfig>>,
	work: WorkEnvironments,
): Placement {
	const instances = new Map<string, InstanceSpec>();
	const kept = new Set<string>();
	for (const server of config.servers)
		if (server.enabled && server.shared) {
			const spec = ownerSpec(server, undefined, envs);
			kept.add(spec.id);
			instances.set(spec.id, spec);
		}
	const placed = leases.map((lease): PlacedLease => {
		const where = locationText(lease.location);
		if (!(work[lease.session] ?? []).includes(lease.location.env))
			return { lease, servers: new Map(), errors: [`${where}: not where this session works`] };
		const project = projectOf(lease, config);
		const servers = new Map<string, string>();
		const use = (spec: InstanceSpec): void => {
			instances.set(spec.id, spec);
			servers.set(spec.server, spec.id);
		};
		for (const server of config.servers)
			if (project.enabled.get(server.name) ?? server.enabled) use(ownerSpec(server, lease, envs));
		for (const server of project.servers) use(projectSpec(server, lease, envs));
		return { lease, servers, errors: project.errors.map((error) => `${where}: ${error}`) };
	});
	return { instances, leases: placed, kept };
}

/** The project configuration the lease's worker sent, checked. */
function projectOf(lease: Lease, config: OwnerConfig): ProjectConfig {
	const { project } = lease;
	if (project.kind === "file") return parseProjectConfig(project.text, config);
	return {
		servers: [],
		enabled: new Map(),
		errors: project.kind === "unreadable" ? [`.pi/mcp.json: ${project.error}`] : [],
	};
}

/** The instance of owner server `server` that `lease` uses (shared: everybody's, `lease` unused). */
function ownerSpec(
	server: OwnerServer,
	lease: Lease | undefined,
	envs: Readonly<Record<string, EnvConfig>>,
): InstanceSpec {
	const timeoutMs = server.config.timeout === undefined ? undefined : server.config.timeout * 1000;
	const owned = server.shared ? undefined : lease;
	if (server.kind === "http") {
		const { url, headers = {}, oauth } = server.config;
		// Unshared HTTP servers are one per session, wherever its conversations work.
		const hash = hashOf({ url, headers, ...(oauth === undefined ? {} : { oauth }), timeoutMs: timeoutMs ?? null });
		const key = ["http", server.name, owned?.session ?? null, hash];
		return {
			id: idOf(key),
			server: server.name,
			source: "owner",
			location: null,
			runsOn: "host",
			connect: { kind: "http", url, headers, oauth: oauthServerOf(server) },
			timeoutMs,
		};
	}
	const at = owned?.location ?? null;
	const runsOn: RunsOn = server.runOn !== "location" ? server.runOn : at?.env ? { env: at.env } : "host";
	const placed = { server: server.name, source: "owner" as const, session: owned?.session ?? null, location: at };
	return stdioSpec(placed, runsOn, server.config, timeoutMs, envs);
}

/** How owner server `server` signs in with OAuth: as in pi, an HTTP server without an `Authorization` header. */
export function oauthServerOf(server: OwnerServer): OAuthServer | undefined {
	if (server.kind !== "http") return undefined;
	const { url, headers = {}, oauth } = server.config;
	if (Object.keys(headers).some((header) => header.toLowerCase() === "authorization")) return undefined;
	return { name: server.name, url, config: oauth };
}

/** The instance of project server `server` at `lease`'s location: always there, for that session alone. */
function projectSpec(server: ProjectServer, lease: Lease, envs: Readonly<Record<string, EnvConfig>>): InstanceSpec {
	const timeoutMs = server.config.timeout === undefined ? undefined : server.config.timeout * 1000;
	const { session, location } = lease;
	const runsOn: RunsOn = location.env === null ? "host" : { env: location.env };
	return stdioSpec(
		{ server: server.name, source: "project", session, location },
		runsOn,
		server.config,
		timeoutMs,
		envs,
	);
}

/** Who a stdio instance is for: its server, the configuration it comes from, and its session and location if unshared. */
type StdioPlaced = {
	readonly server: string;
	readonly source: "owner" | "project";
	readonly session: string | null;
	readonly location: Location | null;
};

/** A stdio instance on `runsOn`; on its location's machine its cwd is the base of relative paths and the root. */
function stdioSpec(
	{ server, source, session, location }: StdioPlaced,
	runsOn: RunsOn,
	config: McpStdioServerConfig,
	timeoutMs: number | undefined,
	envs: Readonly<Record<string, EnvConfig>>,
): InstanceSpec {
	const { command, args = [], env = {}, cwd } = config;
	const hash = hashOf({ command, args, env, cwd: cwd ?? null, timeoutMs: timeoutMs ?? null });
	const owner = session === null ? null : [session, location];
	const machine = runsOn === "host" ? null : runsOn.env;
	const base = location !== null && location.env === machine ? location.cwd : null;
	const hostVariables = source === "owner";
	if (runsOn === "host") {
		const key = ["stdio", source, server, owner, runsOn, hash];
		const spec = { id: idOf(key), server, source, location, runsOn, timeoutMs };
		return {
			...spec,
			connect: {
				kind: "host",
				command: expandHome(command),
				args: args.map(expandHome),
				env,
				cwd: resolve(base ?? homedir(), expandHome(cwd ?? ".")),
				roots: base === null ? [] : [pathToFileURL(base).href],
				hostVariables,
			},
		};
	}
	const envConfig = Object.hasOwn(envs, runsOn.env) ? envs[runsOn.env] : undefined;
	// An edited environment is another connection: its instances start again on it.
	const key = ["stdio", source, server, owner, runsOn, envConfig === undefined ? null : envRevision(envConfig), hash];
	const spec = { id: idOf(key), server, source, location, runsOn, timeoutMs };
	if (envConfig === undefined)
		return { ...spec, connect: { kind: "unplaced", reason: `environment "${runsOn.env}" is not in envs.json` } };
	return {
		...spec,
		connect: {
			kind: "remote",
			environment: runsOn.env,
			config: envConfig,
			command,
			args,
			env,
			cwd: cwd ?? ".",
			base,
			hostVariables,
		},
	};
}

/** `~` and `~/…` name the home directory, as in a shell (and in pi). */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/**
 * The configuration hash: what makes another process or connection (command, args, env, cwd; URL, headers and OAuth
 * client settings; the timeout).
 */
function hashOf(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** An instance's ID from its key. */
function idOf(key: unknown): string {
	return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}
