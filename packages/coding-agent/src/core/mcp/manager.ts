/**
 * MCP (Model Context Protocol) Client Manager
 *
 * Connects to configured MCP servers via HTTP transport and manages tool discovery/execution.
 * Uses StreamableHTTP transport for communication.
 *
 * Supports streaming via MCP progress notifications.
 *
 * Session-expiry handling: the server sweeps idle sessions after ~10 minutes.
 * The SDK does NOT auto-reconnect on the resulting 400 "No valid session ID"
 * response, so on that specific error we close the dead client, open a fresh
 * connection (which auto-handshakes and gets a new session id), and retry the
 * call once.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ============================================================================
// Types
// ============================================================================

export interface McpServerConfig {
	url: string;
	token: string;
	enabled?: boolean;
}

export interface McpToolInfo {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/**
 * Callback for streaming progress updates from MCP tools.
 */
export type McpProgressCallback = (data: { type: string; content: string; elapsed?: number }) => void;

/**
 * Options for calling an MCP tool.
 */
export interface McpCallOptions {
	/** Callback for streaming progress updates (e.g. bash output) */
	onProgress?: McpProgressCallback;
	/** Abort signal to cancel the tool call */
	signal?: AbortSignal;
}

// ============================================================================
// McpManager
// ============================================================================

export class McpManager {
	private clients = new Map<string, Client>();
	private configs = new Map<string, McpServerConfig>();

	/**
	 * Connect to an MCP server and discover its tools.
	 * Returns the list of tools exposed by the server.
	 */
	async connectServer(name: string, config: McpServerConfig): Promise<McpToolInfo[]> {
		const client = await this.openConnection(config);
		const result = await client.listTools();
		const tools: McpToolInfo[] = result.tools.map((t) => ({
			name: t.name,
			description: t.description || "",
			inputSchema: t.inputSchema as Record<string, unknown>,
		}));

		this.clients.set(name, client);
		this.configs.set(name, config);
		console.log(`[MCP] ${name}: connected (${tools.map((t) => t.name).join(", ")})`);
		return tools;
	}

	/**
	 * Call a tool on a connected MCP server.
	 * Supports streaming via progress notifications.
	 *
	 * If the server responds with "No valid session ID" (session was swept),
	 * the manager transparently reconnects and retries once.
	 */
	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
		options?: McpCallOptions,
	): Promise<AgentToolResult<unknown>> {
		const client = this.clients.get(serverName);
		if (!client) {
			return {
				content: [{ type: "text", text: `MCP server "${serverName}" not connected` }],
				details: {},
			};
		}

		try {
			return await this.invokeTool(client, toolName, args, options);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!isSessionExpired(msg)) return this.mcpError(msg);

			const config = this.configs.get(serverName);
			if (!config) return this.mcpError(msg);

			const newClient = await this.reconnect(serverName, config, client);
			if (!newClient) return this.mcpErrorAfterReconnect(msg);

			try {
				return await this.invokeTool(newClient, toolName, args, options);
			} catch (retryErr) {
				const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
				return this.mcpErrorAfterReconnect(rmsg);
			}
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
		this.configs.clear();
	}

	// --------------------------------------------------------------------------
	// Internals
	// --------------------------------------------------------------------------

	private async openConnection(config: McpServerConfig): Promise<Client> {
		const client = new Client({ name: "pi", version: "1.0.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: {
				headers: {
					Authorization: `Bearer ${config.token}`,
				},
			},
		});
		await client.connect(transport);
		return client;
	}

	private async invokeTool(
		client: Client,
		toolName: string,
		args: Record<string, unknown>,
		options?: McpCallOptions,
	): Promise<AgentToolResult<unknown>> {
		const callOptions: Record<string, unknown> = {};

		if (options?.onProgress) {
			callOptions.onprogress = (progress: { progress: number; total?: number; message?: string }) => {
				options.onProgress!({
					type: "progress",
					content: progress.message || "",
					elapsed: undefined,
				});
			};
			// Reset timeout on progress to support long-running commands
			callOptions.resetTimeoutOnProgress = true;
		}

		if (options?.signal) {
			callOptions.signal = options.signal;
		}

		// Set a longer timeout for MCP calls (default is 60s)
		callOptions.timeout = 600000; // 10 minutes

		const result = await client.callTool({ name: toolName, arguments: args }, undefined, callOptions as any);

		if (Array.isArray(result.content)) {
			const text = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return { content: [{ type: "text", text }], details: {} };
		}
		return { content: [{ type: "text", text: JSON.stringify(result.content) }], details: {} };
	}

	private async reconnect(serverName: string, config: McpServerConfig, oldClient: Client): Promise<Client | null> {
		try {
			await oldClient.close().catch(() => {});
		} catch {
			// best-effort
		}
		this.clients.delete(serverName);
		try {
			const newClient = await this.openConnection(config);
			// refresh the tool list so the manager sees any tools the server
			// added since the original handshake
			await newClient.listTools().catch(() => {});
			this.clients.set(serverName, newClient);
			console.log(`[MCP] ${serverName}: reconnected after session expiry`);
			return newClient;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`[MCP] ${serverName}: reconnect failed: ${msg}`);
			return null;
		}
	}

	private mcpError(msg: string): AgentToolResult<unknown> {
		return { content: [{ type: "text", text: `MCP error: ${msg}` }], details: {} };
	}

	private mcpErrorAfterReconnect(msg: string): AgentToolResult<unknown> {
		return { content: [{ type: "text", text: `MCP error (after reconnect): ${msg}` }], details: {} };
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * True when the error message indicates the server has lost the MCP session.
 * The SDK throws a `StreamableHTTPError` whose message includes the response
 * body text — for a swept session the body is
 * `{"error":{"message":"Bad Request: No valid session ID"}}`.
 */
function isSessionExpired(msg: string): boolean {
	return msg.includes("No valid session ID") || msg.includes("Session not found");
}
