/**
 * Adapts MCP tools to pi tool definitions.
 *
 * Results map onto pi's model-facing content (text and images). `structuredContent` is passed
 * through for tools that declare an `outputSchema`, so codemode scripts receive the data instead
 * of the text. MCP errors (`isError`) become thrown errors, which pi reports as failed calls.
 */

import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { CallToolResult, ContentBlock, McpRequestOptions, Tool as McpTool } from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { McpExposure } from "./config.ts";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

export interface McpToolDetails {
	server: string;
	tool: string;
}

export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

/** `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. */
export function createMcpToolName(server: string, tool: string): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function blockToContent(block: ContentBlock): TextContent | ImageContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		case "resource_link":
			return { type: "text", text: `${block.name}: ${block.uri}` };
		case "resource": {
			const resource = block.resource;
			if ("text" in resource) return { type: "text", text: resource.text };
			if (resource.mimeType?.startsWith("image/")) {
				return { type: "image", data: resource.blob, mimeType: resource.mimeType };
			}
			return {
				type: "text",
				text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]`,
			};
		}
		default:
			return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
	}
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Convert an MCP result, throwing for `isError` results. */
export function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
): AgentToolResult<McpToolDetails> {
	const content = result.content.map(blockToContent);
	if (result.isError) {
		throw new Error(textOf(content) || `MCP tool ${server}/${tool} returned an error`);
	}
	// Servers should mirror structured results as text; fall back to JSON when they do not.
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	return {
		content,
		details: { server, tool },
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent as JsonValue }),
	};
}

/** Tool input schemas must be objects; MCP allows servers to omit `type`. */
function toParameters(schema: Record<string, unknown>): TSchema {
	return (schema.type === undefined ? { type: "object", ...schema } : schema) as unknown as TSchema;
}

export function createMcpToolDefinition(options: {
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
}): ToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title ?? tool.annotations?.title;
	return {
		name: options.name,
		label: `${server}/${tool.name}`,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: toParameters(tool.inputSchema),
		...(tool.outputSchema ? { outputSchema: tool.outputSchema as unknown as TSchema } : {}),
		...(options.exposure === "codemode" ? { nestedOnly: true } : {}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const client = await options.getClient();
			const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
				signal,
				timeoutMs: options.timeoutMs,
				onProgress: (progress) => {
					const total = progress.total === undefined ? "" : `/${progress.total}`;
					const text = progress.message ?? `Progress ${progress.progress}${total}`;
					onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
				},
			});
			return convertMcpResult(server, tool.name, result);
		},
	};
}
