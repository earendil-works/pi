import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";

export type { StdioClientTransport, SSEClientTransport };

export function createTransport(server: McpServerConfig): StdioClientTransport | SSEClientTransport {
	if (server.command) {
		const safeEnv = Object.fromEntries(
			Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
		);
		return new StdioClientTransport({
			command: server.command,
			args: server.args ?? [],
			env: server.env ? { ...safeEnv, ...server.env } : undefined,
		});
	}

	if (server.url) {
		return new SSEClientTransport(new URL(server.url));
	}

	throw new Error(
		`MCP server "${server.name}" has neither "command" (stdio) nor "url" (SSE) configured`,
	);
}
