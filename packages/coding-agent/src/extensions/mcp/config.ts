/**
 * MCP server configuration.
 *
 * Servers are read from `mcp.json` in the agent directory and, for trusted projects, from
 * `<project>/.pi/mcp.json`. Both use the `mcpServers` shape shared by other MCP clients, so
 * existing configurations can be copied over. Project entries replace global entries with the
 * same name.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (`/mcp login`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";

/**
 * - `codemode`: tools are only callable from codemode scripts and are not declared to the model.
 * - `direct`: tools are declared to the model like any other tool (and callable from codemode).
 */
export type McpExposure = "codemode" | "direct";

interface McpServerConfigBase {
	/** Default: `codemode`. */
	exposure?: McpExposure;
	/** Set to false to keep the entry without connecting. Default: true. */
	enabled?: boolean;
	/** Per-request timeout in seconds. Progress notifications from the server reset it. Default: 60. */
	timeout?: number;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	env?: Record<string, string>;
	/** Relative paths resolve against the session working directory. */
	cwd?: string;
}

/** OAuth client settings for servers that do not support dynamic client registration. */
export interface McpOAuthConfig {
	/** Pre-registered client id. Without it, pi registers a client with the authorization server. */
	clientId?: string;
	/** May reference environment variables (`${NAME}`) or commands (`!cmd`). */
	clientSecret?: string;
	/** Fixed loopback callback port, for clients registered with an exact redirect URI. */
	callbackPort?: number;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry. */
	source: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	errors: string[];
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		return "oauth.clientSecret must be a string";
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	return undefined;
}

function validateServer(name: string, value: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(value)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, timeout } = value;
	if (exposure !== undefined && exposure !== "codemode" && exposure !== "direct") {
		return `server "${name}": exposure must be "codemode" or "direct"`;
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			return `server "${name}": headers must map names to strings`;
		}
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

function readConfigFile(path: string, servers: Map<string, McpServerEntry>, errors: string[]): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const config = validateServer(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		servers.set(name, { name, config, source: path });
	}
}

/** Load global and (when trusted) project MCP configuration. Disabled servers are omitted. */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const servers = new Map<string, McpServerEntry>();
	const errors: string[] = [];
	readConfigFile(join(options.agentDir, "mcp.json"), servers, errors);
	if (options.projectTrusted) readConfigFile(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), servers, errors);
	return { servers: [...servers.values()].filter((entry) => entry.config.enabled !== false), errors };
}
