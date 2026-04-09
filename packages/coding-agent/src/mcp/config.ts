import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface McpServerDefinition {
	type?: string;
	command?: string;
	args?: string[];
	url?: string;
	disabled?: boolean;
	cwd?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	bearerToken?: string;
	bearerTokenEnvVar?: string;
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		clientSecretEnv?: string;
		redirectUri?: string;
	};
	[key: string]: unknown;
}

export interface McpConfig {
	mcpServers: Record<string, McpServerDefinition>;
	settings?: Record<string, unknown>;
}

export interface McpConfigPaths {
	userConfigPath?: string;
	projectDir?: string;
	factoryConfigPath?: string;
	codexConfigPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") return undefined;
		out[key] = entry;
	}
	return out;
}

function normalizeServerDefinition(value: unknown): McpServerDefinition | null {
	if (!isRecord(value)) return null;
	const out: McpServerDefinition = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "headers" || key === "http_headers") {
			const headers = asStringRecord(entry);
			if (!headers) return null;
			out.headers = headers;
			continue;
		}

		if (key === "args") {
			if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) return null;
			out.args = entry;
			continue;
		}

		if (key === "env") {
			const env = asStringRecord(entry);
			if (!env) return null;
			out.env = env;
			continue;
		}

		if (key === "disabled") {
			if (typeof entry !== "boolean") return null;
			out.disabled = entry;
			continue;
		}

		if (key === "bearerToken") {
			if (typeof entry !== "string") return null;
			out.bearerToken = entry;
			continue;
		}

		if (key === "bearerTokenEnvVar" || key === "bearer_token_env_var") {
			if (typeof entry !== "string") return null;
			out.bearerTokenEnvVar = entry;
			continue;
		}

		if (key === "oauth") {
			if (!isRecord(entry)) return null;
			const oauth: NonNullable<McpServerDefinition["oauth"]> = {};
			if (entry.clientId !== undefined) {
				if (typeof entry.clientId !== "string") return null;
				oauth.clientId = entry.clientId;
			}
			if (entry.clientSecret !== undefined) {
				if (typeof entry.clientSecret !== "string") return null;
				oauth.clientSecret = entry.clientSecret;
			}
			if (entry.clientSecretEnv !== undefined) {
				if (typeof entry.clientSecretEnv !== "string") return null;
				oauth.clientSecretEnv = entry.clientSecretEnv;
			}
			if (entry.redirectUri !== undefined) {
				if (typeof entry.redirectUri !== "string") return null;
				oauth.redirectUri = entry.redirectUri;
			}
			out.oauth = oauth;
			continue;
		}

		if (key === "oauth_client_id" || key === "oauthClientId") {
			if (typeof entry !== "string") return null;
			out.oauth = { ...(out.oauth ?? {}), clientId: entry };
			continue;
		}

		if (key === "oauth_client_secret" || key === "oauthClientSecret") {
			if (typeof entry !== "string") return null;
			out.oauth = { ...(out.oauth ?? {}), clientSecret: entry };
			continue;
		}

		if (key === "oauth_client_secret_env_var" || key === "oauthClientSecretEnv") {
			if (typeof entry !== "string") return null;
			out.oauth = { ...(out.oauth ?? {}), clientSecretEnv: entry };
			continue;
		}

		if (key === "oauth_redirect_uri" || key === "oauthRedirectUri") {
			if (typeof entry !== "string") return null;
			out.oauth = { ...(out.oauth ?? {}), redirectUri: entry };
			continue;
		}

		if (key === "type" || key === "command" || key === "url" || key === "cwd") {
			if (typeof entry !== "string") return null;
			out[key] = entry;
			continue;
		}

		out[key] = entry;
	}
	return out;
}

function normalizeConfig(raw: unknown): McpConfig {
	if (!isRecord(raw)) return { mcpServers: {} };

	const rawServers = raw.mcpServers;
	const servers: Record<string, McpServerDefinition> = {};
	if (isRecord(rawServers)) {
		for (const [serverName, definition] of Object.entries(rawServers)) {
			const normalized = normalizeServerDefinition(definition);
			if (normalized) {
				servers[serverName] = normalized;
			}
		}
	}

	const settings = isRecord(raw.settings) ? raw.settings : undefined;
	return {
		mcpServers: servers,
		...(settings ? { settings } : {}),
	};
}

function loadJsonConfig(path: string | undefined): McpConfig {
	if (!path || !existsSync(path)) return { mcpServers: {} };
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return normalizeConfig(raw);
}

function parseTomlValue(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return {};
		const out: Record<string, string> = {};
		for (const part of inner.split(",")) {
			const eqIndex = part.indexOf("=");
			if (eqIndex <= 0) continue;
			const key = part.slice(0, eqIndex).trim().replace(/^"|"$/g, "");
			const value = parseTomlValue(part.slice(eqIndex + 1));
			out[key] = typeof value === "string" ? value : String(value);
		}
		return out;
	}
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map((part) => {
			const value = parseTomlValue(part);
			return typeof value === "string" ? value : String(value);
		});
	}
	return trimmed;
}

function stripTomlComment(line: string): string {
	let inString = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (ch === '"' && line[i - 1] !== "\\") {
			inString = !inString;
			continue;
		}
		if (ch === "#" && !inString) {
			return line.slice(0, i).trim();
		}
	}
	return line.trim();
}

export function parseCodexMcpToml(text: string): Record<string, McpServerDefinition> {
	const servers: Record<string, McpServerDefinition> = {};
	let currentServerName: string | null = null;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripTomlComment(rawLine);
		if (!line) continue;

		const sectionMatch = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
		if (sectionMatch) {
			currentServerName = sectionMatch[1] ?? null;
			if (currentServerName && !servers[currentServerName]) {
				servers[currentServerName] = {};
			}
			continue;
		}

		if (/^\[/.test(line)) {
			currentServerName = null;
			continue;
		}

		if (!currentServerName) continue;

		const eqIndex = line.indexOf("=");
		if (eqIndex <= 0) continue;

		const key = line.slice(0, eqIndex).trim();
		const valueText = line.slice(eqIndex + 1).trim();
		servers[currentServerName]![key] = parseTomlValue(valueText);
	}

	const normalized: Record<string, McpServerDefinition> = {};
	for (const [serverName, definition] of Object.entries(servers)) {
		const parsed = normalizeServerDefinition(definition);
		if (parsed) {
			normalized[serverName] = parsed;
		}
	}
	return normalized;
}

function loadCodexConfig(path: string | undefined): McpConfig {
	if (!path || !existsSync(path)) return { mcpServers: {} };
	const text = readFileSync(path, "utf8");
	return { mcpServers: parseCodexMcpToml(text) };
}

function mergeConfigs(base: McpConfig, overlay: McpConfig): McpConfig {
	return {
		mcpServers: {
			...base.mcpServers,
			...overlay.mcpServers,
		},
		settings: {
			...(base.settings ?? {}),
			...(overlay.settings ?? {}),
		},
	};
}

export function getDefaultMcpConfigPaths(params?: { homeDir?: string; projectDir?: string }): Required<McpConfigPaths> {
	const homeDir = resolve(params?.homeDir ?? homedir());
	const projectDir = resolve(params?.projectDir ?? process.cwd());
	return {
		userConfigPath: join(homeDir, ".mu", "agent", "mcp.json"),
		projectDir,
		factoryConfigPath: join(homeDir, ".factory", "mcp.json"),
		codexConfigPath: join(homeDir, ".codex", "config.toml"),
	};
}

export async function loadMcpConfigFromPaths(paths: McpConfigPaths = {}): Promise<McpConfig> {
	const resolved = getDefaultMcpConfigPaths({
		homeDir: paths.userConfigPath ? dirname(dirname(dirname(paths.userConfigPath))) : undefined,
		projectDir: paths.projectDir,
	});

	const userConfigPath = paths.userConfigPath ?? resolved.userConfigPath;
	const projectDir = paths.projectDir ?? resolved.projectDir;
	const factoryConfigPath = paths.factoryConfigPath ?? resolved.factoryConfigPath;
	const codexConfigPath = paths.codexConfigPath ?? resolved.codexConfigPath;
	const projectConfigPath = join(projectDir, ".mu", "mcp.json");

	let config: McpConfig = { mcpServers: {} };
	config = mergeConfigs(config, loadJsonConfig(factoryConfigPath));
	config = mergeConfigs(config, loadCodexConfig(codexConfigPath));
	config = mergeConfigs(config, loadJsonConfig(userConfigPath));
	config = mergeConfigs(config, loadJsonConfig(projectConfigPath));
	return config;
}

export async function loadMcpConfig(): Promise<McpConfig> {
	return loadMcpConfigFromPaths();
}
