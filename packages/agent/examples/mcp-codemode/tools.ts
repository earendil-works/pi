/**
 * Adapters that give a pi-agent-core `Agent` MCP tools and a codemode tool, using
 * `@earendil-works/pi-mcp` and `@earendil-works/pi-codemode`. See main.ts for how they fit together.
 */

import {
	type Agent,
	type AgentTool,
	type AgentToolCallOutcome,
	type AgentToolResult,
	runToolCall,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { type McpClient, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
function toToolName(prefix: string, name: string): string {
	return `${prefix}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * One `AgentTool` per tool of a connected MCP server, named `<prefix>_<tool>`. Tools with an MCP
 * output schema declare it as `outputSchema` and return `structuredContent`, which codemode scripts
 * receive instead of the text.
 */
export async function createMcpTools(client: McpClient, prefix: string): Promise<AgentTool[]> {
	const tools = await client.listTools();
	return tools.map(
		(tool): AgentTool => ({
			name: toToolName(prefix, tool.name),
			label: tool.title ?? tool.name,
			description: tool.description ?? tool.title ?? `MCP tool ${tool.name}`,
			// Providers require an object schema, and some reject one without `properties`.
			parameters: Type.Unsafe({
				...tool.inputSchema,
				type: "object",
				properties: tool.inputSchema.properties ?? {},
			}),
			outputSchema: tool.outputSchema ? Type.Unsafe<Record<string, unknown>>(tool.outputSchema) : undefined,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				const result = await client.callTool(tool.name, params as Record<string, unknown>, {
					signal,
					onProgress: (progress) => {
						const text = progress.message ?? `Progress ${progress.progress}`;
						onUpdate?.({ content: [{ type: "text", text }], details: undefined });
					},
				});
				const content = toLlmContent(result);
				if (result.isError && content.length === 0) {
					content.push({ type: "text", text: `MCP tool ${tool.name} failed` });
				}
				return {
					content,
					details: undefined,
					structuredContent: result.structuredContent as JsonValue | undefined,
					// MCP reports tool failures in the result instead of as a protocol error.
					isError: result.isError === true,
				};
			},
		}),
	);
}

/**
 * Run a tool call on behalf of another tool through the agent's pipeline: argument validation and
 * the agent's `beforeToolCall`/`afterToolCall` hooks apply as for calls the model makes. Calling
 * `tool.execute()` directly also works when the agent has no hooks.
 */
export function createNestedToolRunner(
	agent: Agent,
): (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome> {
	let nextId = 1;
	return (name, args, signal) => {
		const assistantMessage = agent.state.messages.findLast((message) => message.role === "assistant");
		if (assistantMessage?.role !== "assistant") throw new Error("Nested tool calls need an assistant message");
		const tools = agent.state.tools;
		return runToolCall(
			{ type: "toolCall", id: `nested-${nextId++}`, name, arguments: (args ?? {}) as JsonObject },
			{
				tools,
				assistantMessage,
				context: { messages: agent.state.messages, tools },
				beforeToolCall: agent.beforeToolCall,
				afterToolCall: agent.afterToolCall,
				signal,
			},
		);
	};
}

export const CODEMODE_TOOL_NAME = "codemode";

const codemodeParameters = Type.Object({
	code: Type.String({ description: "JavaScript source. Top-level await and return work." }),
});

/**
 * A tool that runs model-written JavaScript in the codemode sandbox, where `tools.<name>(args)`
 * calls `tools`. Nested results stay out of the model context; only the script's output and
 * return value come back.
 */
export function createCodemodeTool(
	tools: readonly AgentTool[],
	runTool: (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome>,
): AgentTool<typeof codemodeParameters> {
	const callable = tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// TypeBox schemas are JSON Schema.
		inputSchema: tool.parameters as CodemodeJsonSchema,
		// What the script receives: the structured result if the tool declares one, else its text.
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
		execute: async (args, { signal }) => {
			const outcome = await runTool(tool.name, args, signal);
			if (tool.outputSchema && outcome.result.structuredContent !== undefined) {
				return outcome.result.structuredContent;
			}
			const text = textOf(outcome.result);
			if (outcome.isError) throw new Error(text || `Tool ${tool.name} failed`);
			return text;
		},
	}));

	return {
		name: CODEMODE_TOOL_NAME,
		label: "Codemode",
		description: [
			"Run JavaScript that calls other tools, to chain calls, run them in parallel, or filter large results.",
			"The code is the body of an async function. There is no Node, file system, network, or timers.",
			"Call tools as `await tools.<name>(args)`. Output with `text(value)` or `console.log()`, or `return` a value.",
			"Only the output and the return value reach you, not the results of the tool calls.",
			"",
			"```ts",
			renderDeclarations({ tools: sandboxTools }),
			"```",
		].join("\n"),
		parameters: codemodeParameters,
		execute: async (_toolCallId, params, signal) => {
			const sandbox = new CodemodeSandbox({ tools: sandboxTools, timeoutMs: 120_000 });
			try {
				const result = await sandbox.execute(params.code, { signal });
				// Items from text(), console.*, and image(), in order. They have pi-ai's content shapes.
				const content: (TextContent | ImageContent)[] = [...result.output];
				if (result.ok && result.value !== undefined) {
					const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
					content.push({ type: "text", text: value });
				}
				if (!result.ok) {
					content.push({ type: "text", text: `Script failed: ${result.error.stack ?? result.error.message}` });
				}
				return { content, details: { calls: result.calls }, isError: !result.ok };
			} finally {
				await sandbox.close();
			}
		},
	};
}
