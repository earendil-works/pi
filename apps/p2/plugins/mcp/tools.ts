// MCP tools as Durable tools, exposed as pi exposes them by default: one tool per tool of the session's servers, named as
// pi names them (`mcp__<server>__<tool>`), callable only from code mode scripts (or loaded through `tool_search` while
// code mode is off), calling the server's instance where the calling conversation works; and the `mcp_servers` prompt
// section, through which the model learns of the servers.

import type { JsonValue } from "@earendil-works/chord/json";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	type Extension,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type CallToolResult,
	createMcpToolName,
	limitMcpContent,
	mcpNamespace,
	normalizeMcpInputSchema,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { Context } from "@p2/app/v1";
import { type Instance, MCP_EXTENSION, type McpTool } from "./contract.ts";

/** One tool of one server. */
export type ServerTool = { readonly server: string; readonly tool: McpTool };

/**
 * How the model reaches MCP tools, as pi's exposures: `codemode` (pi's default) from code mode scripts, which find them
 * with `searchTools()`; `tool_search` (pi's `deferred`, its fallback without code mode) by loading them with
 * `tool_search`, then calling them directly.
 */
export type McpReach = "codemode" | "tool_search";

/** What the MCP extension offers: the session's servers by name, their tools, and how the model reaches them. */
export type McpOffer = {
	readonly servers: readonly string[];
	readonly tools: readonly ServerTool[];
	readonly reach: McpReach;
};

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

/** The servers of `instances` by name, each once (a server may have instances at several locations). */
export function serverNames(instances: readonly Instance[]): string[] {
	return [...new Set(instances.map((instance) => instance.server))].sort();
}

/**
 * The Durable extension offering `offer`'s tools, each calling through `call`, and the `mcp_servers` section. As in pi
 * (and Codex), every tool whose name sanitizes to one another tool's also gets pi's hash suffix, so no tool's name
 * depends on the order of the list and a new tool renames only those it collides with.
 */
export function createMcpExtension({ servers, tools, reach }: McpOffer, call: McpCall): Extension {
	const plain = new Map<string, number>();
	for (const { server, tool } of tools) {
		const name = createMcpToolName(server, tool.name);
		plain.set(name, (plain.get(name) ?? 0) + 1);
	}
	const assigned = new Set<string>();
	const listing = serversSection(servers, reach);
	return defineExtension({
		name: MCP_EXTENSION,
		tools: tools.map((entry) => {
			const name = createMcpToolName(
				entry.server,
				entry.tool.name,
				(candidate) => (plain.get(candidate) ?? 0) > 1 || assigned.has(candidate),
			);
			assigned.add(name);
			return toolRegistration(name, entry, reach, call);
		}),
		sections: listing === undefined ? [] : [section(MCP_SERVERS_SECTION, () => listing)],
	});
}

/** The section listing the servers whose tools are not declared to the model, as pi's. */
export const MCP_SERVERS_SECTION = "mcp_servers";

/**
 * Characters of the whole section, as in pi: when the server lines do not fit, the last servers are left out and
 * counted in a closing line.
 */
const MAX_SERVERS_SECTION_CHARS = 4096;

/**
 * The `mcp_servers` section, as pi renders it for servers without a description: each server's namespace and how its
 * tools are reached. Undefined without servers.
 */
function serversSection(servers: readonly string[], reach: McpReach): string | undefined {
	if (servers.length === 0) return undefined;
	const intro =
		reach === "codemode"
			? "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts."
			: "MCP servers whose tools are not declared to you. Load the tools of `tool_search` servers with `tool_search`.";
	const lines = servers.map((server) => `- ${mcpNamespace(server)} (${reach})`);
	const find = reach === "codemode" ? "searchTools()" : "tool_search";
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with ${find}`] : [];
	const render = (kept: number) => [intro, ...lines.slice(0, kept), ...omitted(lines.length - kept)].join("\n");
	let kept = lines.length;
	while (kept > 0 && render(kept).length > MAX_SERVERS_SECTION_CHARS) kept--;
	return render(kept);
}

/**
 * One MCP tool as a Durable tool (not replay-safe: an interrupted call is not repeated). Deferred either way, so the
 * `codemode` section leaves it out; for `codemode` only other tools (scripts) may call it, so `tool_search` never
 * offers it to the model either.
 */
function toolRegistration(
	name: string,
	{ server, tool }: ServerTool,
	reach: McpReach,
	call: McpCall,
): ToolRegistration {
	const title = tool.title ?? tool.annotations?.title;
	return {
		name,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: normalizeMcpInputSchema(tool.inputSchema),
		deferred: true,
		...(reach === "codemode" ? { callers: ["tools" as const] } : {}),
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
