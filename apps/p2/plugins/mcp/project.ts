// A project's MCP configuration, `<cwd>/.pi/mcp.json` as a session's worker read it at one location (a trust boundary:
// a repository wrote it, and the agent can edit it). It may add stdio servers, which run at that location only, and
// turn the owner's servers on or off there; everything else is refused and reported.

import {
	isMcpServerOverride,
	type McpStdioServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import { isRecord, type OwnerConfig, serverEntries } from "./config.ts";

/** One stdio server a project adds, validated; it runs where the project is. */
export type ProjectServer = { readonly name: string; readonly config: McpStdioServerConfig };

/** A project's own servers, its choice of `enabled` per owner server, and why entries were refused. */
export type ProjectConfig = {
	readonly servers: readonly ProjectServer[];
	readonly enabled: ReadonlyMap<string, boolean>;
	readonly errors: readonly string[];
};

/**
 * The project configuration in `text`, checked against `owner`'s servers:
 *
 * - an entry without `command`, `url` or `type` overrides only `enabled` of the owner's server of that name (as in pi);
 * - an entry defining a server the owner defines is refused (the owner's entry wins);
 * - stdio servers only, without `runOn` and `shared`: a project's server runs at its location, where the agent already
 *   runs commands, never on the p2 host or another machine for a repository's sake;
 * - no `auth` or `oauth`: a repository does not choose where a credential goes;
 * - `${NAME}` is never expanded: `env` values reach the program as written, in the location's own environment.
 */
export function parseProjectConfig(text: string, owner: OwnerConfig): ProjectConfig {
	let entries: Record<string, unknown>;
	try {
		entries = serverEntries(text, ".pi/mcp.json");
	} catch (error) {
		return { servers: [], enabled: new Map(), errors: [error instanceof Error ? error.message : String(error)] };
	}
	const servers: ProjectServer[] = [];
	const enabled = new Map<string, boolean>();
	const errors: string[] = [];
	const namespaces = new Map(owner.servers.map((server) => [mcpNamespace(server.name), server.name]));
	for (const [name, raw] of Object.entries(entries)) {
		const entry = projectEntry(name, raw, owner);
		if (entry.kind === "invalid") errors.push(`.pi/mcp.json: ${entry.error}`);
		else if (entry.kind === "override" && entry.enabled !== undefined) enabled.set(name, entry.enabled);
		if (entry.kind !== "server") continue;
		const taken = namespaces.get(mcpNamespace(name));
		if (taken !== undefined) {
			errors.push(`.pi/mcp.json: server "${name}": its tools would be named like those of "${taken}"`);
			continue;
		}
		namespaces.set(mcpNamespace(name), name);
		servers.push(entry.server);
	}
	return { servers, enabled, errors };
}

/** One entry of a project's configuration: a server, an override, disabled, or why it is refused. */
type Entry =
	| { readonly kind: "server"; readonly server: ProjectServer }
	| { readonly kind: "override"; readonly enabled: boolean | undefined }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly error: string };

/** The owner's fields a project may not set, and why. */
const OWNER_ONLY: readonly (readonly [string, string])[] = [
	["runOn", "a project's server runs where the project is"],
	["shared", "a project's server runs for its session alone"],
	["auth", "credentials are for the owner's mcp.json"],
	["oauth", "credentials are for the owner's mcp.json"],
];

/** One entry checked against the rules of `parseProjectConfig`. */
function projectEntry(name: string, raw: unknown, owner: OwnerConfig): Entry {
	const refused = (why: string): Entry => ({ kind: "invalid", error: `server "${name}": ${why}` });
	const defined = owner.servers.some((server) => server.name === name);
	if (isRecord(raw) && isMcpServerOverride(raw)) {
		if (!defined) return refused('needs "command", or a server of the owner\'s mcp.json to override');
		if (Object.keys(raw).some((key) => key !== "enabled")) return refused('an override can only set "enabled"');
		if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return refused("enabled must be a boolean");
		return { kind: "override", enabled: raw.enabled };
	}
	if (defined) return refused('the owner\'s mcp.json defines it; a project can only set its "enabled"');
	const result = validateMcpServerConfig(name, raw);
	if (result.kind === "invalid") return { kind: "invalid", error: result.error };
	if (result.kind === "http")
		return refused("HTTP servers are for the owner's mcp.json (the p2 host would make the requests)");
	for (const [field, why] of OWNER_ONLY)
		if (result.config[field] !== undefined) return refused(`"${field}" is for the owner's mcp.json: ${why}`);
	if (result.config.enabled === false) return { kind: "disabled" };
	return { kind: "server", server: { name, config: result.config } };
}
