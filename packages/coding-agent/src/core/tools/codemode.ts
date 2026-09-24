/**
 * The `codemode` tool: the model writes JavaScript that calls the other active tools.
 *
 * Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so validation,
 * `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct calls. Only
 * the script's return value, console output, and explicitly attached images reach the model;
 * nested results do not.
 *
 * Nested results are handed to the script as follows:
 * - A tool that declares `outputSchema` and returns `structuredContent` resolves to that value.
 * - Any other tool resolves to its text content as one string. Images are replaced by
 *   `[image:N mime]` references that the script can attach with `image(ref)`.
 * - A failed, blocked, or invalid call rejects with an Error carrying the tool's error text.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	type CodemodeLog,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { type Static, Type } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { codemodeRenderers } from "./renderers/codemode.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

export const CODEMODE_TOOL_NAME = "codemode";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

const codemodeSchema = Type.Object({
	code: Type.String({
		description: "Body of an async JavaScript function. Top-level await and return work.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type CodemodeToolInput = Static<typeof codemodeSchema>;

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<codemode call id>/<n>`. */
	id: string;
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	/** Error text, truncated for display. */
	error?: string;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	logs: CodemodeLog[];
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools (chains, loops, Promise.all, filtering large results)",
	guidelines: [
		"Use codemode to batch or chain several tool calls, or to filter large tool output down to what you need, instead of issuing many individual tool calls.",
	],
} as const;

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. Use it to chain, loop over, or parallelize tool calls (for example with Promise.all) and to reduce large results to what you need. You only see the return value, console output, and images attached with image(); nested tool results are not shown to you otherwise.

- \`code\` is the body of an async function: top-level \`await\` and \`return\` work. Return JSON-serializable values.
- Call tools as \`await tools.<name>(args)\` with one object argument matching the tool's parameters. Use \`tools["name"](args)\` for names that are not identifiers.
- A tool resolves to its declared result type; tools declared as \`Promise<string>\` resolve to their text output. Images in text output appear as \`[image:N mime]\` references.
- A failing or blocked tool call rejects with an Error carrying the tool's error text. Catch it to continue.
- \`console.log/info/warn/error/debug\` output is returned together with the result.
- Nothing else is available: no filesystem, network, process, timers, require, or import. Use tools instead.
- Calls that are still running when the script returns are cancelled; await everything you start.
- Tool calls are real and have side effects. If the script fails partway, earlier calls are not undone.`;

const IMAGE_GLOBAL_DESCRIPTION =
	"Attach images to the result so you can see them. `ref` is any string containing `[image:N ...]` references, for example a tool's text output.";

function firstParagraph(text: string): string {
	return text.trim().split(/\n\s*\n/)[0] ?? "";
}

function toCodemodeDeclaration(tool: AgentTool<any>): Omit<CodemodeTool, "execute"> {
	return {
		name: tool.name,
		description: firstParagraph(tool.description),
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a codemode script may call: every given tool except codemode itself. */
export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

/** Model-facing description, including TypeScript declarations for the callable tools. */
export function createCodemodeDescription(tools: readonly AgentTool<any>[]): string {
	const noop = () => undefined;
	const declarations = renderDeclarations({
		tools: getCodemodeCallableTools(tools).map((tool) => ({ ...toCodemodeDeclaration(tool), execute: noop })),
		globals: [
			{
				name: "image",
				description: IMAGE_GLOBAL_DESCRIPTION,
				inputSchema: { type: "string" },
				outputSchema: { type: "null" },
				execute: noop,
			},
		],
	});
	return `${DESCRIPTION_INTRO}\n\nAvailable API:\n\`\`\`ts\n${declarations}\n\`\`\``;
}

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function previewArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
	} catch {
		return "";
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function resolveTimeoutMs(timeout: number | undefined): number {
	if (timeout === undefined) return Number.POSITIVE_INFINITY;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: must be a positive number of seconds up to ${MAX_TIMEOUT_SECONDS}`);
	}
	return timeout * 1000;
}

function formatLogs(logs: readonly CodemodeLog[]): string {
	return logs.map((log) => (log.level === "log" ? log.message : `[${log.level}] ${log.message}`)).join("\n");
}

function formatValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatFailure(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	const parts = [head, formatCallSummary(calls)];
	if (result.logs.length > 0) parts.push(`Console:\n${formatLogs(result.logs)}`);
	return parts.join("\n\n");
}

function formatOutput(value: unknown, logs: readonly CodemodeLog[]): string {
	const parts: string[] = [];
	const text = formatValue(value);
	if (text) parts.push(text);
	if (logs.length > 0) parts.push(`Console:\n${formatLogs(logs)}`);
	if (parts.length === 0) return "(no return value)";
	const joined = parts.join("\n\n");
	const truncation = truncateHead(joined);
	if (!truncation.truncated) return joined;
	return `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} line limit). Return less data.]`;
}

/**
 * Run one script. Split from the tool definition so the execution path can be used with any
 * `ExtensionToolContext`-compatible loop context.
 */
async function executeCodemode(
	toolCallId: string,
	{ code, timeout }: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext,
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const timeoutMs = resolveTimeoutMs(timeout);
	const calls: CodemodeNestedCall[] = [];
	const images: ImageContent[] = [];
	const attached = new Set<number>();
	let logs: CodemodeLog[] = [];

	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })), logs: [...logs] });
	const publish = () => onUpdate?.({ content: [], details: snapshot() });

	const project = (tool: AgentTool<any>, result: AgentToolResult<unknown>): unknown => {
		if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
		const parts: string[] = [];
		for (const block of result.content ?? []) {
			if (block.type === "text") {
				parts.push(block.text);
			} else {
				images.push(block);
				parts.push(`[image:${images.length} ${block.mimeType}]`);
			}
		}
		return parts.join("\n");
	};

	const sandboxTools: CodemodeTool[] = getCodemodeCallableTools(ctx.tools).map((tool) => ({
		name: tool.name,
		execute: async (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/?`,
				name: tool.name,
				args: previewArgs(args),
				status: "running",
			};
			calls.push(record);
			publish();
			const startedAt = performance.now();
			const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			record.id = outcome.toolCall.id;
			record.durationMs = performance.now() - startedAt;
			if (outcome.isError) {
				const message = textOf(outcome.result) || `Tool "${tool.name}" failed`;
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(message, ERROR_PREVIEW_CHARS);
				publish();
				throw new Error(message);
			}
			record.status = "ok";
			publish();
			return project(tool, outcome.result);
		},
	}));

	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: [
			{
				name: "image",
				execute: (ref) => {
					if (typeof ref !== "string") throw new Error("image() expects a string containing [image:N] references");
					let found = false;
					for (const match of ref.matchAll(/image:(\d+)/g)) {
						const index = Number(match[1]);
						if (index < 1 || index > images.length) continue;
						found = true;
						attached.add(index);
					}
					if (!found) throw new Error(`No known image reference in ${JSON.stringify(truncateText(ref, 80))}`);
					return null;
				},
			},
		],
		timeoutMs,
	});

	let result: CodemodeResult;
	try {
		result = await sandbox.execute(code, { signal });
	} finally {
		await sandbox.close();
	}
	logs = result.logs;
	// Calls still marked running were cut off by the script ending, a timeout, or an abort.
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	if (!result.ok) {
		throw new Error(formatFailure(result, calls));
	}

	const content: (TextContent | ImageContent)[] = [{ type: "text", text: formatOutput(result.value, result.logs) }];
	for (const index of [...attached].sort((a, b) => a - b)) {
		content.push(images[index - 1]);
	}
	return { content, details: snapshot() };
}

export function createCodemodeToolDefinition(): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the active tools when codemode is activated.
		description: createCodemodeDescription([]),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			executeCodemode(toolCallId, params, signal, onUpdate, ctx),
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(tools: readonly AgentTool<any>[] = []): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition();
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
