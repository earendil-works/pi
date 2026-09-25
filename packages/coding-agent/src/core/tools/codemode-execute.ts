/**
 * Runs one codemode script in the sandbox. Split from codemode.ts and loaded through
 * codemode-execute.lazy.ts so the sandbox runtime only loads when a script runs.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeLog,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
} from "@earendil-works/pi-codemode";
import { getCodemodeWorkerUrl, getQuickJSWasmPath } from "../../config.ts";
import type { ExtensionToolContext } from "../extensions/types.ts";
import {
	type CodemodeNestedCall,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	getCodemodeCallableTools,
} from "./codemode.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;

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

function formatOutput(text: string, logs: readonly CodemodeLog[]): string {
	const parts: string[] = [];
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
export async function executeCodemode(
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
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerUrl(),
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

	const valueText = formatValue(result.value);
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: formatOutput(valueText, result.logs) }];
	for (const index of [...attached].sort((a, b) => a - b)) {
		content.push(images[index - 1]);
	}
	const details = snapshot();
	if (valueText && typeof result.value !== "string") details.jsonLines = valueText.split("\n").length;
	return { content, details };
}
