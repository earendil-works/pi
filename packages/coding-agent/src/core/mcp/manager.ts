/**
 * MCP (Model Context Protocol) Client Manager
 *
 * Connects to configured MCP servers via stdio transport and manages tool discovery/execution.
 * Each server is started as a child process and communicates via stdin/stdout.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ============================================================================
// Types
// ============================================================================

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface McpToolInfo {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

// ============================================================================
// McpManager
// ============================================================================

export class McpManager {
	private clients = new Map<string, Client>();

	/**
	 * Connect to an MCP server and discover its tools.
	 * Returns the list of tools exposed by the server.
	 */
	async connectServer(name: string, config: McpServerConfig): Promise<McpToolInfo[]> {
		const client = new Client({ name: "pi", version: "1.0.0" }, { capabilities: {} });
		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: config.env,
			stderr: "pipe",
		});
		await client.connect(transport);

		const result = await client.listTools();
		const tools: McpToolInfo[] = result.tools.map((t) => ({
			name: t.name,
			description: t.description || "",
			inputSchema: t.inputSchema as Record<string, unknown>,
		}));

		this.clients.set(name, client);
		console.log(`[MCP] ${name}: connected (${tools.map((t) => t.name).join(", ")})`);
		return tools;
	}

	/**
	 * Call a tool on a connected MCP server.
	 */
	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<AgentToolResult<unknown>> {
		const client = this.clients.get(serverName);
		if (!client) {
			return {
				content: [{ type: "text", text: `MCP server "${serverName}" not connected` }],
				details: {},
			};
		}

		try {
			const result = await client.callTool({ name: toolName, arguments: args });
			if (Array.isArray(result.content)) {
				const text = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return { content: [{ type: "text", text }], details: {} };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.content) }], details: {} };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { content: [{ type: "text", text: `MCP error: ${msg}` }], details: {} };
		}
	}

	/**
	 * Disconnect all MCP servers and clean up resources.
	 */
	async disconnectAll(): Promise<void> {
		for (const [name, client] of this.clients) {
			try {
				await client.close();
			} catch {
				// ignore close errors
			}
			console.log(`[MCP] ${name}: disconnected`);
		}
		this.clients.clear();
	}
}
