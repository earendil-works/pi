/**
 * MCP Tool Factory
 *
 * Converts MCP server tools into pi's ToolDefinition format.
 * Tool names are prefixed with serverName/ to avoid conflicts with built-in tools.
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
export function createMcpToolDefinition(serverName: string, mcpTool: McpToolInfo, manager: McpManager): ToolDefinition {
	const prefixedName = `${serverName}/${mcpTool.name}`;
	return {
		name: prefixedName,
		label: prefixedName,
		description: `[MCP:${serverName}] ${mcpTool.description}`,
		promptSnippet: `[Remote] ${mcpTool.name}: execute tools on remote server (read_file, write_file, edit_file, bash, list_dir)`,
		parameters: mcpTool.inputSchema as ToolDefinition["parameters"],
		execute: async (_toolCallId: string, params: unknown) => {
			return manager.callTool(serverName, mcpTool.name, params as Record<string, unknown>);
		},
	};
}
