import type { McpConfig, McpServerDefinition } from "./config.js";
import type { McpStatusSnapshot } from "./status.js";

export interface FigmaPilotServer {
	serverName: string;
	url: string;
}

export interface FigmaPilotStatusInput {
	serverName: string;
	hasConfiguredServer: boolean;
	hasAuthenticatedConnection: boolean;
	hasStoredCredentials: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeFigmaRemoteServer(serverName: string, definition: McpServerDefinition): boolean {
	if (serverName.toLowerCase() === "figma") return true;
	return typeof definition.url === "string" && definition.url.includes("mcp.figma.com/mcp");
}

export function detectFigmaPilotServer(config: McpConfig): FigmaPilotServer | null {
	if (!isRecord(config?.mcpServers)) return null;

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		if (!definition || typeof definition !== "object") continue;
		const typedDefinition = definition as McpServerDefinition;
		if (typedDefinition.disabled) continue;
		if (!looksLikeFigmaRemoteServer(serverName, typedDefinition)) continue;
		if (typeof typedDefinition.url !== "string" || typedDefinition.url.trim().length === 0) continue;
		return { serverName, url: typedDefinition.url };
	}

	return null;
}

export function buildFigmaPilotStatus(input: FigmaPilotStatusInput): McpStatusSnapshot {
	if (!input.hasConfiguredServer) {
		return { state: "connected", connectedCount: 0, totalCount: 0 };
	}

	if (input.hasAuthenticatedConnection) {
		return {
			state: "connected",
			serverName: input.serverName,
			connectedCount: 1,
			totalCount: 1,
		};
	}

	// Check if we have stored OAuth credentials
	if (input.hasStoredCredentials) {
		return {
			state: "auth_expired", // Credentials exist but connection not verified
			serverName: input.serverName,
			connectedCount: 0,
			totalCount: 1,
		};
	}

	return {
		state: "auth_required",
		serverName: input.serverName,
		connectedCount: 0,
		totalCount: 1,
	};
}
