// The owner's MCP configuration, `<P2_DATA_DIR>/mcp.json` (a trust boundary): the shared `mcpServers` shape checked by
// pi-mcp, p2's own fields (`shared`, `runOn`) checked here, and the file followed while the server runs.

import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	type McpHttpServerConfig,
	type McpStdioServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import { Observer, optionalText, stripBom, stripJsonComments } from "@p2/app/v1/node";

/** Where a stdio server runs: where the conversation works, on the p2 host, or on an environment of `envs.json`. */
type RunOn = "location" | "host" | { readonly env: string };

/** One server of the owner's configuration, validated. */
export type OwnerServer =
	| {
			readonly name: string;
			readonly kind: "stdio";
			readonly config: McpStdioServerConfig;
			/** `"enabled": false` keeps it off, unless a project's `mcp.json` turns it on where it applies. */
			readonly enabled: boolean;
			/** One process for every session (`"shared": true`), else one per session and location. */
			readonly shared: boolean;
			readonly runOn: RunOn;
	  }
	| {
			readonly name: string;
			readonly kind: "http";
			readonly config: McpHttpServerConfig;
			readonly enabled: boolean;
			/** One connection for every session (the default), else one per session. */
			readonly shared: boolean;
	  };

/** The owner's servers and why entries were skipped. */
export type OwnerConfig = { readonly servers: readonly OwnerServer[]; readonly errors: readonly string[] };

/** The file as last read: the last valid servers and their errors, and why the last read failed (null: it did not). */
export type OwnerConfigState = OwnerConfig & { readonly failure: string | null };

/**
 * The owner's configuration in `text` (`{ "mcpServers": { name: entry } }`, comments allowed): invalid entries are
 * skipped and reported in `errors`; disabled ones are kept (a project may turn them on). Throws when the file itself is
 * not such an object.
 */
export function parseOwnerConfig(text: string): OwnerConfig {
	const servers: OwnerServer[] = [];
	const errors: string[] = [];
	const namespaces = new Map<string, string>();
	for (const [name, raw] of Object.entries(serverEntries(text, "mcp.json"))) {
		const entry = ownerServer(name, raw);
		if (entry.kind === "invalid") {
			errors.push(entry.error);
			continue;
		}
		// Tool names and code mode namespaces replace `-` by `_`: both spellings would collide.
		const taken = namespaces.get(mcpNamespace(name));
		if (taken !== undefined) {
			errors.push(`server "${name}": its tools would be named like those of "${taken}"`);
			continue;
		}
		namespaces.set(mcpNamespace(name), name);
		servers.push(entry.server);
	}
	return { servers, errors };
}

/**
 * The `mcpServers` entries of `text`, a configuration file named `file` (comments allowed); throws when the file is not
 * such an object.
 */
export function serverEntries(text: string, file: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(stripJsonComments(stripBom(text)));
	} catch {
		throw new Error(`Invalid ${file} syntax`);
	}
	if (!isRecord(value)) throw new Error(`${file} must be an object`);
	const entries = value.mcpServers ?? {};
	if (!isRecord(entries)) throw new Error(`${file}: "mcpServers" must be an object`);
	return entries;
}

/** One entry of the configuration, checked. */
type Entry =
	| { readonly kind: "server"; readonly server: OwnerServer }
	| { readonly kind: "invalid"; readonly error: string };

/** One entry: the server, or why it is invalid. */
function ownerServer(name: string, raw: unknown): Entry {
	const invalid = (error: string): Entry => ({ kind: "invalid", error: `server "${name}": ${error}` });
	const result = validateMcpServerConfig(name, raw);
	if (result.kind === "invalid") return { kind: "invalid", error: result.error };
	// The entry keeps fields pi-mcp does not know (p2's `shared` and `runOn` among them), unused from here on.
	const { shared, runOn } = result.config;
	const enabled = result.config.enabled !== false;
	if (shared !== undefined && typeof shared !== "boolean") return invalid("shared must be a boolean");
	if (result.kind === "http") {
		if (runOn !== undefined) return invalid("runOn is for stdio servers");
		return { kind: "server", server: { name, kind: "http", config: result.config, enabled, shared: shared ?? true } };
	}
	const placement = runOnOf(runOn);
	if (placement.kind === "invalid")
		return invalid('runOn must be "location", "host" or { "env": "<name in envs.json>" }');
	if (shared === true && placement.kind === "set" && placement.runOn === "location")
		return invalid('a shared server cannot run where each conversation works (use runOn "host" or an env)');
	const defaultRunOn: RunOn = shared ? "host" : "location";
	return {
		kind: "server",
		server: {
			name,
			kind: "stdio",
			config: result.config,
			enabled,
			shared: shared ?? false,
			runOn: placement.kind === "set" ? placement.runOn : defaultRunOn,
		},
	};
}

/** `runOn` as configured: absent (the default applies), set, or invalid. */
function runOnOf(value: unknown): { kind: "absent" } | { kind: "set"; runOn: RunOn } | { kind: "invalid" } {
	if (value === undefined) return { kind: "absent" };
	if (value === "location" || value === "host") return { kind: "set", runOn: value };
	if (isRecord(value) && Object.keys(value).length === 1 && typeof value.env === "string" && value.env !== "")
		return { kind: "set", runOn: { env: value.env } };
	return { kind: "invalid" };
}

/** Whether `value` is a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` with every `${NAME}` replaced by the p2 host's environment variable (the owner's configuration only); an
 * unset variable throws, naming it.
 */
export function expandHostVariables(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const variable = process.env[name];
		if (variable === undefined) throw new Error(`environment variable ${name} is not set`);
		return variable;
	});
}

/** `mcp.json`, watched (a missing file is no servers); one process reads it (the server's manager). */
export class OwnerConfigFile {
	/** Watches the file and reads it at each change; `start()` reads it the first time, `close()` stops. */
	readonly observer: Observer;
	#state: OwnerConfigState;
	readonly #listeners = new Set<() => void>();

	/**
	 * `last`: the servers last read validly before this reader existed (a restarted manager's: its new reader may first
	 * see a save caught half-way, and keeps them then).
	 */
	constructor(dataDir: string, last: OwnerConfig) {
		const path = join(dataDir, "mcp.json");
		this.#state = { ...last, failure: null };
		this.observer = new Observer(
			[{ env: new NodeExecutionEnv({ cwd: dataDir }), targets: () => [{ path }] }],
			async (retrying) => {
				try {
					this.#state = { ...parseOwnerConfig((await optionalText(path)) ?? "{}"), failure: null };
				} catch (error) {
					// A save caught half-way is read once more before it counts; an invalid read keeps the last valid servers.
					if (!retrying) return true;
					this.#state = { ...this.#state, failure: error instanceof Error ? error.message : String(error) };
				}
				for (const listener of this.#listeners) listener();
				return false;
			},
			2000,
		);
	}

	get state(): OwnerConfigState {
		return this.#state;
	}

	/** `listener` hears of every read from now on; the result stops it. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
