// MCP tools as Durable tools: one deferred tool (found through `tool_search`) per tool of the session's servers, named
// as pi names them (`mcp__<server>__<tool>`), calling the server's instance where the calling conversation works.

import type { JsonValue } from "@earendil-works/chord/json";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	type Extension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type CallToolResult,
	createMcpToolName,
	limitMcpContent,
	normalizeMcpInputSchema,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { Context } from "@p2/app/v1";
import { type Instance, MCP_EXTENSION, type McpTool } from "./contract.ts";

/** One tool of one server. */
export type ServerTool = { readonly server: string; readonly tool: McpTool };

/** A call of `server`'s `tool` for conversation `conversationId` (its documents read through `read`). */
export type McpCall = (
	request: {
		readonly conversationId: ConversationId;
		readonly read: DocumentReader;
		readonly server: string;
		readonly tool: string;
		readonly args: Record<string, unknown>;
	},
	context: Context,
) => Promise<CallToolResult>;

/** The tools of `servers` by server and tool name; a server with instances at several locations lists a tool once. */
export function serverTools(servers: readonly Instance[]): ServerTool[] {
	const tools = new Map<string, ServerTool>();
	for (const instance of servers)
		for (const tool of instance.tools) {
			const key = JSON.stringify([instance.server, tool.name]);
			if (!tools.has(key)) tools.set(key, { server: instance.server, tool });
		}
	const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	return [...tools.values()].sort((a, b) => order(a.server, b.server) || order(a.tool.name, b.tool.name));
}

/**
 * The Durable extension offering `tools`, each calling through `call`. As in pi (and Codex), every tool whose name
 * sanitizes to one another tool's also gets pi's hash suffix, so no tool's name depends on the order of the list
 * and a new tool renames only those it collides with.
 */
export function createMcpExtension(tools: readonly ServerTool[], call: McpCall): Extension {
	const plain = new Map<string, number>();
	for (const { server, tool } of tools) {
		const name = createMcpToolName(server, tool.name);
		plain.set(name, (plain.get(name) ?? 0) + 1);
	}
	const assigned = new Set<string>();
	return defineExtension({
		name: MCP_EXTENSION,
		tools: tools.map((entry) => {
			const name = createMcpToolName(
				entry.server,
				entry.tool.name,
				(candidate) => (plain.get(candidate) ?? 0) > 1 || assigned.has(candidate),
			);
			assigned.add(name);
			return toolRegistration(name, entry, call);
		}),
	});
}

/** One MCP tool as a deferred Durable tool (not replay-safe: an interrupted call is not repeated). */
function toolRegistration(name: string, { server, tool }: ServerTool, call: McpCall): ToolRegistration {
	const title = tool.title ?? tool.annotations?.title;
	return {
		name,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: normalizeMcpInputSchema(tool.inputSchema),
		deferred: true,
		...(tool.outputSchema === undefined ? {} : { structuredOutputSchema: tool.outputSchema }),
		async execute(args, api, context) {
			// Durable checked `args` against `parameters`, an object schema; its type cannot follow a runtime schema.
			const result = await call(
				{
					conversationId: api.conversationId,
					read: api,
					server,
					tool: tool.name,
					args: args as Record<string, unknown>,
				},
				context,
			);
			const content = toLlmContent(result);
			if (result.isError && !content.some((block) => block.type === "text" && block.text.trim() !== ""))
				content.push({ type: "text", text: `MCP tool ${server}/${tool.name} returned an error` });
			const limited = await limitMcpContent(content);
			// Structured output only for a tool that declares its schema (Durable checks it), error results too. The
			// server's JSON arrived as JSON; the type says `unknown` only because MCP allows any value.
			const structured =
				tool.outputSchema !== undefined && result.structuredContent !== undefined
					? { structuredOutput: result.structuredContent as JsonValue }
					: {};
			return {
				output: limited.content,
				isError: result.isError === true,
				details: { server, tool: tool.name },
				...structured,
			};
		},
	};
}
