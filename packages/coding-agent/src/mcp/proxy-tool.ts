import type { AgentTool, TextContent } from "@kennyfrc/mu-ai";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { McpServerManager, ServerConnection } from "./server-manager.js";

const mcpProxyArgsObjectSchema = Type.Object(
	{},
	{
		additionalProperties: true,
		description: "Arguments as a structured JSON object. Prefer this form so values are serialized automatically.",
	},
);

const mcpProxyParamsSchema = Type.Object({
	tool: Type.String({ description: "Tool name to call on the MCP server." }),
	args: Type.Optional(
		Type.Union([mcpProxyArgsObjectSchema, Type.String({ description: "Legacy JSON object string." })]),
	),
	server: Type.String({ description: "Connected MCP server name." }),
});

type McpProxyParams = Static<typeof mcpProxyParamsSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMcpProxyArgs(args: McpProxyParams["args"]): Record<string, unknown> {
	if (args === undefined) {
		return {};
	}

	if (typeof args === "string") {
		const raw = JSON.parse(args) as unknown;
		if (!isRecord(raw)) {
			throw new Error("Invalid MCP proxy args: expected a JSON object string");
		}
		return raw;
	}

	if (!isRecord(args)) {
		throw new Error("Invalid MCP proxy args: expected an object");
	}

	const serialized = JSON.stringify(args);
	const normalized = JSON.parse(serialized) as unknown;
	if (!isRecord(normalized)) {
		throw new Error("Invalid MCP proxy args: expected a serializable object");
	}
	return normalized;
}

export function createMcpProxyTool(
	manager: McpServerManager,
	options?: {
		description?: string;
		ensureConnected?: (serverName: string) => Promise<ServerConnection>;
	},
): AgentTool<typeof mcpProxyParamsSchema, { server: string; tool: string }> {
	return {
		name: "mcp",
		label: "mcp",
		description: options?.description ?? "Call a tool on a connected MCP server.",
		parameters: mcpProxyParamsSchema,
		execute: async (_toolCallId, params, _signal, _onProgress) => {
			const parsedArgs = normalizeMcpProxyArgs(params.args);

			if (options?.ensureConnected) {
				await options.ensureConnected(params.server);
			}

			const result = await manager.callTool(params.server, params.tool, parsedArgs);
			const content: TextContent[] = Array.isArray(result.content)
				? result.content
						.filter(
							(entry): entry is { type: string; text?: string } =>
								typeof entry === "object" && entry !== null && "type" in entry,
						)
						.map((entry) => ({ type: "text", text: entry.text ?? "" }))
				: [];
			return {
				content,
				details: {
					server: params.server,
					tool: params.tool,
					result,
					projection: {
						version: 1,
						call: {
							style: "argv",
							text: `mcp ${params.server} ${params.tool}`,
							argv: [params.server, params.tool],
						},
					},
				},
			};
		},
	};
}

export { mcpProxyParamsSchema, type McpProxyParams };
