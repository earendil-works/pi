/**
 * MCP Tool Factory
 *
 * Converts MCP server tools into pi's ToolDefinition format.
 * Tool names are prefixed with serverName/ to avoid conflicts with built-in tools.
 *
 * Supports streaming via MCP progress notifications.
 */

import type { ToolDefinition } from "../extensions/types.ts";
import type { McpManager, McpToolInfo } from "./manager.ts";

/**
 * Create a ToolDefinition from an MCP tool.
 *
 * @param serverName - Name of the MCP server (from mcp.json config key)
 * @param mcpTool - Tool info from MCP server's tools/list
 * @param manager - McpManager instance for forwarding tool calls
 * @returns ToolDefinition that can be registered in the agent's tool registry
 */
/**
 * Extract sub-operation names from a discriminated-union JSON Schema.
 * Handles two shapes:
 * 1. Proper union: `oneOf[*].properties.<field>.const`
 * 2. Flat fallback (when MCP SDK strips z.discriminatedUnion): `properties.tool.enum`
 * Returns null if the schema isn't a recognized discriminated union.
 */
function extractUnionMembers(inputSchema: Record<string, unknown>): string[] | null {
	// Shape 1: proper oneOf with const discriminators
	const oneOf = inputSchema.oneOf;
	if (Array.isArray(oneOf) && oneOf.length > 0) {
		const members: string[] = [];
		for (const variant of oneOf) {
			if (typeof variant !== "object" || variant === null) return null;
			const props = (variant as Record<string, unknown>).properties;
			if (typeof props !== "object" || props === null) return null;
			let found = false;
			for (const field of Object.values(props as Record<string, unknown>)) {
				if (typeof field === "object" && field !== null && "const" in field) {
					const value = (field as Record<string, unknown>).const;
					if (typeof value === "string") {
						members.push(value);
						found = true;
						break;
					}
				}
			}
			if (!found) return null;
		}
		if (members.length > 0) return members;
	}
	// Shape 2: flat z.object with discriminator enum (e.g. `properties.tool.enum`)
	const props = inputSchema.properties;
	if (typeof props === "object" && props !== null) {
		for (const field of Object.values(props as Record<string, unknown>)) {
			if (typeof field === "object" && field !== null && Array.isArray((field as Record<string, unknown>).enum)) {
				const enumValues = (field as Record<string, unknown>).enum as unknown[];
				if (enumValues.length > 0 && enumValues.every((v) => typeof v === "string")) {
					return enumValues as string[];
				}
			}
		}
	}
	return null;
}

export function createMcpToolDefinition(serverName: string, mcpTool: McpToolInfo, manager: McpManager): ToolDefinition {
	const prefixedName = `${serverName}_${mcpTool.name}`;
	const members = extractUnionMembers(mcpTool.inputSchema);
	const subOpsList = members && members.length > 0 ? members.join(", ") : "sub-operations";
	return {
		name: prefixedName,
		label: prefixedName,
		description: `[MCP:${serverName}] ${mcpTool.description}`,
		promptSnippet: `[Remote] ${mcpTool.name}: execute tools on remote server (${subOpsList})`,
		parameters: mcpTool.inputSchema as ToolDefinition["parameters"],
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?) => {
			return manager.callTool(serverName, mcpTool.name, params as Record<string, unknown>, {
				onProgress: onUpdate
					? (progress) => {
							// Convert MCP progress to AgentToolResult update
							if (progress.content) {
								onUpdate({
									content: [{ type: "text", text: progress.content }],
									details: {},
								});
							}
						}
					: undefined,
				signal,
			});
		},
	};
}
