import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerConfig {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
}

export interface McpConfig {
	servers: McpServerConfig[];
}

/** Expand ${ENV_VAR} placeholders in a string using process.env. */
export function resolveEnvValue(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

function resolveServerEnv(server: McpServerConfig): McpServerConfig {
	return {
		...server,
		command: server.command !== undefined ? resolveEnvValue(server.command) : undefined,
		args: server.args?.map(resolveEnvValue),
		url: server.url !== undefined ? resolveEnvValue(server.url) : undefined,
		env: server.env
			? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, resolveEnvValue(v)]))
			: undefined,
	};
}

function readServers(filePath: string): McpServerConfig[] {
	if (!existsSync(filePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"servers" in parsed &&
			Array.isArray((parsed as { servers: unknown }).servers)
		) {
			const entries = (parsed as { servers: Array<Record<string, unknown>> }).servers;
			return entries.filter(
				(s): s is McpServerConfig => typeof s.name === "string" && s.name.length > 0,
			);
		}
		return [];
	} catch {
		return [];
	}
}

/**
 * Load MCP server configuration.
 * Reads ~/.pi/agent/mcp.json (global) then .pi/mcp.json (project-local).
 * Project servers with the same name override global servers.
 * ${ENV_VAR} in command, args, url, and env values is interpolated from process.env.
 */
export function loadConfig(cwd: string): McpConfig {
	const globalPath = join(homedir(), ".pi", "agent", "mcp.json");
	const projectPath = join(cwd, ".pi", "mcp.json");

	const all = [
		...readServers(globalPath),
		...readServers(projectPath),
	].map(resolveServerEnv);

	// Deduplicate by name: project-local entries (appended last) override global ones.
	const seen = new Set<string>();
	const servers = all.slice().reverse().filter((s) => {
		if (seen.has(s.name)) return false;
		seen.add(s.name);
		return true;
	}).reverse();

	return { servers };
}
