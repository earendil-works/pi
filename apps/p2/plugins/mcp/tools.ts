// MCP tools as Durable tools, exposed as pi exposes them by default: one tool per tool of the session's servers, named as
// pi names them (`mcp__<server>__<tool>`), callable only from code mode scripts (or loaded through `tool_search` while
// code mode is off), calling the server's instance where the calling conversation works. Each server is its own
// extension with its code-mode namespace (`mcp__<server>`), through which the model learns of it: listed in the
// `codemode` section with a description from the configuration (so the prompt stays the same when the server connects),
// its instructions from `initialize` on demand (`describeNamespace()`).

import type { JsonValue } from "@earendil-works/chord/json";
import { type ConversationId, type DocumentReader, defineExtension, type Extension } from "@earendil-works/pi-durable";
import {
	type CallToolResult,
	createMcpToolName,
	limitMcpContent,
	mcpNamespace,
	normalizeMcpInputSchema,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { Context } from "@p2/app/v1";
import type { P2Tool } from "@p2/app/v1/worker";
import { type Instance, type McpTool, signInLink } from "./contract.ts";

/** One tool of one server. */
export type ServerTool = { readonly server: string; readonly tool: McpTool };

/**
 * How the model reaches MCP tools, as pi's exposures: `codemode` (pi's default) from code mode scripts, which find them
 * with `searchTools()`; `tool_search` (pi's `deferred`, its fallback without code mode) by loading them with
 * `tool_search`, then calling them directly.
 */
export type McpReach = "codemode" | "tool_search";

/**
 * One of the session's servers as its extension offers it: its name, whether it signs in with OAuth (its namespace says
 * how the user signs in), and its instructions from `initialize`, if any.
 */
export type OfferedServer = { readonly name: string; readonly oauth: boolean; readonly instructions?: string };

/** What the MCP extensions offer: the session's servers, their tools, and how the model reaches them. */
export type McpOffer = {
	readonly servers: readonly OfferedServer[];
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

/**
 * The servers of `instances` by name, each once (a server may have instances at several locations): it signs in with
 * OAuth if any instance does; its instructions are the first instance's that has some.
 */
export function offeredServers(instances: readonly Instance[]): OfferedServer[] {
	const names = [...new Set(instances.map((instance) => instance.server))].sort();
	return names.map((name) => {
		const own = instances.filter((instance) => instance.server === name);
		const instructions = own.find((instance) => instance.instructions !== undefined)?.instructions;
		return {
			name,
			oauth: own.some((instance) => instance.auth === "oauth"),
			...(instructions === undefined ? {} : { instructions }),
		};
	});
}

/** The extension name of server `server`'s tools. */
export const mcpExtensionName = (server: string): string => `mcp:${server}`;

/**
 * One Durable extension per server of `offer`, by extension name: its namespace and its tools, each calling through
 * `call`. As in pi (and Codex), every tool whose name sanitizes to one another tool's (of any server) also gets pi's
 * hash suffix, so no tool's name depends on the order of the list and a new tool renames only those it collides with.
 */
export function createMcpExtensions(
	{ servers, tools, reach }: McpOffer,
	call: McpCall,
): Readonly<Record<string, Extension<P2Tool>>> {
	const plain = new Map<string, number>();
	for (const { server, tool } of tools) {
		const name = createMcpToolName(server, tool.name);
		plain.set(name, (plain.get(name) ?? 0) + 1);
	}
	const assigned = new Set<string>();
	const registrations = tools.map((entry) => {
		const name = createMcpToolName(
			entry.server,
			entry.tool.name,
			(candidate) => (plain.get(candidate) ?? 0) > 1 || assigned.has(candidate),
		);
		assigned.add(name);
		return { server: entry.server, tool: toolRegistration(name, entry, reach, call) };
	});
	return Object.fromEntries(
		servers.map((server) => [
			mcpExtensionName(server.name),
			defineExtension<P2Tool>({
				name: mcpExtensionName(server.name),
				namespace: {
					name: mcpNamespace(server.name),
					description: namespaceDescription(server),
					...(server.instructions === undefined ? {} : { instructions: server.instructions }),
				},
				tools: registrations.filter((entry) => entry.server === server.name).map((entry) => entry.tool),
			}),
		]),
	);
}

/**
 * A server's namespace description, from its configuration only (the prompt must not change when it connects): an
 * OAuth server says how the user signs in, which its tools wait for.
 */
function namespaceDescription(server: OfferedServer): string {
	const tools = `Tools of the MCP server "${server.name}" (find them with searchTools()).`;
	return server.oauth
		? `${tools} It needs the user's sign-in: if it has no tools, ask the user to sign in from the MCP panel in p2's sidebar or at ${signInLink(server.name)} on p2.`
		: tools;
}

/**
 * One MCP tool as a Durable tool (not replay-safe: an interrupted call is not repeated). Deferred either way, so the
 * `codemode` section leaves it out; for `codemode` only other tools (scripts) may call it, so `tool_search` never
 * offers it to the model either.
 */
function toolRegistration(name: string, { server, tool }: ServerTool, reach: McpReach, call: McpCall): P2Tool {
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
