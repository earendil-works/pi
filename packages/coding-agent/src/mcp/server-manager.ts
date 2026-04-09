import { getFigmaOAuthAccessToken } from "../oauth/figma-mcp.js";
import type { McpServerDefinition } from "./config.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	[key: string]: unknown;
}

export interface McpCallResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
	[key: string]: unknown;
}

export interface ServerConnection {
	name: string;
	definition: McpServerDefinition;
	tools: McpTool[];
	status: "connected" | "closed";
	lastUsedAt: number;
	sessionId?: string;
}

interface JsonRpcSuccess<T> {
	jsonrpc: "2.0";
	id: string | number | null;
	result: T;
}

interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: string | number | null;
	error: { code: number; message: string };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcFailure<T>(value: JsonRpcResponse<T>): value is JsonRpcFailure {
	return "error" in value;
}

function asToolArray(value: unknown): McpTool[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is McpTool => isRecord(entry) && typeof entry.name === "string");
}

export class McpServerManager {
	private connections = new Map<string, ServerConnection>();
	private sessionIds = new Map<string, string>();

	async connect(name: string, definition: McpServerDefinition): Promise<ServerConnection> {
		const existing = this.connections.get(name);
		if (existing?.status === "connected") {
			existing.lastUsedAt = Date.now();
			return existing;
		}

		if (typeof definition.url !== "string" || definition.url.trim().length === 0) {
			throw new Error(`Server ${name} must define a non-empty url for HTTP runtime`);
		}

		await this.request(name, definition, "initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "mu-mcp", version: "0.1.0" },
		});

		const listResult = await this.request<{ tools?: unknown }>(name, definition, "tools/list", {});
		const connection: ServerConnection = {
			name,
			definition,
			tools: asToolArray(listResult.tools),
			status: "connected",
			lastUsedAt: Date.now(),
			...(this.sessionIds.has(name) ? { sessionId: this.sessionIds.get(name) } : {}),
		};
		this.connections.set(name, connection);
		return connection;
	}

	async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
		const connection = this.connections.get(name);
		if (!connection || connection.status !== "connected") {
			throw new Error(`Server "${name}" is not connected`);
		}

		connection.lastUsedAt = Date.now();
		return this.request<McpCallResult>(name, connection.definition, "tools/call", {
			name: toolName,
			arguments: args,
		});
	}

	getConnection(name: string): ServerConnection | undefined {
		return this.connections.get(name);
	}

	async close(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;
		connection.status = "closed";
		this.connections.delete(name);
		this.sessionIds.delete(name);
	}

	private async resolveHeaders(serverName: string, definition: McpServerDefinition): Promise<Record<string, string>> {
		const headers = { ...(definition.headers ?? {}) };
		const envToken = definition.bearerTokenEnvVar ? process.env[definition.bearerTokenEnvVar] : undefined;
		const token =
			definition.bearerToken ??
			envToken ??
			(typeof definition.url === "string" && definition.url.includes("mcp.figma.com/mcp")
				? await getFigmaOAuthAccessToken().catch(() => null)
				: null);
		if (typeof token === "string" && token.length > 0) {
			headers.Authorization = `Bearer ${token}`;
		}
		const sessionId = this.sessionIds.get(serverName);
		if (sessionId) {
			headers["Mcp-Session-Id"] = sessionId;
		}
		return headers;
	}

	private parseJsonRpcPayload<T>(payload: unknown, method: string): JsonRpcResponse<T> {
		if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
			throw new Error(`Invalid JSON-RPC response for method ${method}`);
		}
		return payload as unknown as JsonRpcResponse<T>;
	}

	private parseEventStreamPayload<T>(text: string, method: string): JsonRpcResponse<T> {
		let lastError: Error | null = null;

		for (const record of text.split(/\r?\n\r?\n/)) {
			if (!record.trim()) continue;

			const dataLines: string[] = [];
			for (const rawLine of record.split(/\r?\n/)) {
				const line = rawLine.trimEnd();
				if (!line || line.startsWith(":")) continue;
				if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).trimStart());
				}
			}

			if (dataLines.length === 0) continue;

			try {
				const payload = JSON.parse(dataLines.join("\n")) as unknown;
				return this.parseJsonRpcPayload<T>(payload, method);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}

		throw new Error(
			lastError
				? `Invalid text/event-stream JSON-RPC response for method ${method}: ${lastError.message}`
				: `Missing JSON-RPC payload in text/event-stream response for method ${method}`,
		);
	}

	private async request<T>(
		serverName: string,
		definition: McpServerDefinition,
		method: string,
		params: Record<string, unknown>,
	): Promise<T> {
		const url = String(definition.url);
		const headers = await this.resolveHeaders(serverName, definition);
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
				...headers,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from MCP server for method ${method}`);
		}

		const responseSessionId = response.headers.get("mcp-session-id");
		if (responseSessionId) {
			this.sessionIds.set(serverName, responseSessionId);
			const connection = this.connections.get(serverName);
			if (connection) {
				connection.sessionId = responseSessionId;
			}
		}

		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const payload = contentType.includes("text/event-stream")
			? this.parseEventStreamPayload<T>(await response.text(), method)
			: this.parseJsonRpcPayload<T>((await response.json()) as unknown, method);

		if (isJsonRpcFailure(payload)) {
			throw new Error(`MCP error for method ${method}: ${payload.error.message}`);
		}

		return payload.result;
	}
}
