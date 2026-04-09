import { loadOAuthCredentials } from "@kennyfrc/mu-ai";
import type { McpServerDefinition } from "../../mcp/config.js";
import { loadMcpConfig } from "../../mcp/config.js";
import { buildFigmaPilotStatus } from "../../mcp/figma-pilot.js";
import { createMcpProxyTool } from "../../mcp/proxy-tool.js";
import { McpServerManager } from "../../mcp/server-manager.js";
import { buildMcpStatusLabel } from "../../mcp/status.js";
import { getFigmaOAuthAccessToken, onFigmaOAuthStateChange } from "../../oauth/figma-mcp.js";
import type { ExtensionFactory } from "../types.js";
import { eraseAgentTool } from "../types.js";

function isEnabledServer(definition: McpServerDefinition): boolean {
	return definition.disabled !== true;
}

function isRealFigmaRemoteServer(serverName: string, definition: McpServerDefinition): boolean {
	if (serverName.toLowerCase() !== "figma" && typeof definition.url !== "string") {
		return false;
	}
	return typeof definition.url === "string" && definition.url.includes("mcp.figma.com/mcp");
}

function buildToolInventoryDescription(
	serverDefinitions: Map<string, McpServerDefinition>,
	discoveredTools: Map<string, string[]>,
): string {
	const configuredServers = Array.from(serverDefinitions.keys());
	const inventory = configuredServers
		.map((serverName) => {
			const tools = discoveredTools.get(serverName) ?? [];
			return tools.length > 0 ? `${serverName}[${tools.join(", ")}]` : serverName;
		})
		.join("; ");

	return inventory
		? `Call a tool on a configured MCP server. Available servers/tools: ${inventory}.`
		: "Call a tool on a configured MCP server.";
}

const mcpExtension: ExtensionFactory = async (mu) => {
	const manager = new McpServerManager();
	const config = await loadMcpConfig();
	const serverDefinitions = new Map(
		Object.entries(config.mcpServers).filter(([, definition]) => isEnabledServer(definition)),
	);
	const discoveredTools = new Map<string, string[]>();
	const failedServers = new Map<string, string>();

	const refreshDiscoveredTools = (serverName: string): void => {
		const connection = manager.getConnection(serverName);
		if (!connection) return;
		discoveredTools.set(
			serverName,
			connection.tools
				.map((tool) => tool.name)
				.filter((name, index, arr) => typeof name === "string" && arr.indexOf(name) === index),
		);
	};

	const buildSnapshot = async () => {
		const totalCount = serverDefinitions.size;
		const connectedEntries = Array.from(serverDefinitions.keys()).filter((serverName) => {
			const connection = manager.getConnection(serverName);
			return connection?.status === "connected";
		});
		const connectedCount = connectedEntries.length;

		const figmaServer = Array.from(serverDefinitions.entries()).find(([serverName, definition]) =>
			isRealFigmaRemoteServer(serverName, definition),
		);
		if (figmaServer) {
			const [serverName] = figmaServer;
			const storedCredentials = loadOAuthCredentials("figma-mcp");
			const hasStoredCredentials = storedCredentials !== null;
			if (connectedEntries.includes(serverName)) {
				return buildFigmaPilotStatus({
					serverName,
					hasConfiguredServer: true,
					hasAuthenticatedConnection: true,
					hasStoredCredentials,
				});
			}
			return buildFigmaPilotStatus({
				serverName,
				hasConfiguredServer: true,
				hasAuthenticatedConnection: false,
				hasStoredCredentials,
			});
		}

		if (failedServers.size > 0) {
			return {
				state: "degraded" as const,
				connectedCount,
				totalCount,
				serverName: failedServers.keys().next().value,
			};
		}

		return { state: "connected" as const, connectedCount, totalCount };
	};

	const refreshStatus = async (): Promise<void> => {
		const snapshot = await buildSnapshot();
		mu.updateExtensionIndicator("mcp-status", {
			label: buildMcpStatusLabel(snapshot),
			color:
				snapshot.state === "auth_failed" || snapshot.state === "auth_expired"
					? "warning"
					: snapshot.state === "degraded"
						? "error"
						: snapshot.totalCount > 0
							? "accent"
							: "muted",
		});
	};

	const ensureConnected = async (serverName: string) => {
		const existing = manager.getConnection(serverName);
		if (existing?.status === "connected") return existing;

		const definition = serverDefinitions.get(serverName);
		if (!definition) {
			throw new Error(`MCP server "${serverName}" is not configured`);
		}

		if (isRealFigmaRemoteServer(serverName, definition)) {
			const hasToken =
				typeof definition.bearerToken === "string" ||
				(definition.bearerTokenEnvVar ? typeof process.env[definition.bearerTokenEnvVar] === "string" : false) ||
				(await getFigmaOAuthAccessToken().catch(() => null));
			if (!hasToken) {
				failedServers.set(serverName, "auth_failed");
				await refreshStatus();
				throw new Error(`Figma MCP is not authenticated for server "${serverName}"`);
			}
		}

		try {
			const connection = await manager.connect(serverName, definition);
			failedServers.delete(serverName);
			refreshDiscoveredTools(serverName);
			await refreshStatus();
			return connection;
		} catch (error) {
			failedServers.set(serverName, error instanceof Error ? error.message : String(error));
			await refreshStatus();
			throw error;
		}
	};

	const refreshFigmaAuthStatus = async (): Promise<void> => {
		const figmaServer = Array.from(serverDefinitions.entries()).find(([serverName, definition]) =>
			isRealFigmaRemoteServer(serverName, definition),
		);
		if (!figmaServer) {
			await refreshStatus();
			return;
		}

		const [serverName] = figmaServer;
		await manager.close(serverName);
		discoveredTools.delete(serverName);
		failedServers.delete(serverName);

		const storedCredentials = loadOAuthCredentials("figma-mcp");
		if (!storedCredentials) {
			await refreshStatus();
			return;
		}

		try {
			await ensureConnected(serverName);
		} catch {
			await refreshStatus();
		}
	};

	onFigmaOAuthStateChange(() => {
		void refreshFigmaAuthStatus();
	});

	for (const [serverName] of serverDefinitions) {
		try {
			await ensureConnected(serverName);
		} catch {
			// Leave status truthful but don't fail extension load.
		}
	}

	const initialSnapshot = await buildSnapshot();
	const initialLabel = buildMcpStatusLabel(initialSnapshot);

	mu.registerTool(
		eraseAgentTool(
			createMcpProxyTool(manager, {
				description: buildToolInventoryDescription(serverDefinitions, discoveredTools),
				ensureConnected,
			}),
		),
	);
	mu.registerCommand({
		name: "mcp",
		description: "Show MCP status",
		execute: async (_argString, ctx) => {
			const snapshot = await buildSnapshot();
			ctx.print(buildMcpStatusLabel(snapshot));
			for (const [serverName, tools] of discoveredTools.entries()) {
				if (tools.length === 0) continue;
				ctx.print(`${serverName}: ${tools.join(", ")}`, { color: "dim" });
			}
		},
	});
	mu.registerExtensionIndicator({
		id: "mcp-status",
		label: initialLabel,
		color:
			initialSnapshot.state === "auth_failed" || initialSnapshot.state === "auth_expired"
				? "warning"
				: initialSnapshot.state === "degraded"
					? "error"
					: initialSnapshot.totalCount > 0
						? "accent"
						: "muted",
		priority: 20,
	});
};

export default mcpExtension;
