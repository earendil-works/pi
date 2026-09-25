/**
 * Runs one codemode script in the sandbox. Split from codemode.ts and loaded through
 * codemode-execute.lazy.ts so the sandbox runtime only loads when a script runs.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AnyModel, ClassifierContext, ImageContent, ModelType, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeLog,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import { getCodemodeWorkerUrl, getQuickJSWasmPath } from "../../config.ts";
import type { ExtensionToolContext } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeModelRuntime,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	MODEL_GLOBAL_DECLARATIONS,
} from "./codemode.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
/** Classifier calls one script may have in flight; `Promise.all` over many items queues the rest. */
const MAX_CONCURRENT_MODEL_CALLS = 4;
const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

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

function toModelType(value: unknown): ModelType {
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

/** Catalog entry for scripts. `headers` is dropped because models.json headers can carry credentials. */
function toModelInfo(model: AnyModel): Record<string, unknown> {
	const info: Record<string, unknown> = { ...model };
	delete info.headers;
	return info;
}

/** Runs at most `limit` calls at once, in call order. */
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (run) => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof set === "object" &&
		set !== null &&
		Array.isArray(deleted) &&
		deleted.every((key: unknown) => typeof key === "string")
	);
}

/** Values of `load()`: the `codemode-store` entries on the branch, applied from the root. */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
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

/**
 * Write the full return value to a temp file, like bash does for truncated output. Always JSON,
 * including string values, so the file can be processed with jq.
 */
async function spillReturnValue(value: unknown): Promise<string | undefined> {
	const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.json`);
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
		return path;
	} catch {
		return undefined;
	}
}

async function formatOutput(
	value: unknown,
	valueText: string,
	logs: readonly CodemodeLog[],
): Promise<{ text: string; fullOutputPath?: string }> {
	const parts: string[] = [];
	if (valueText) parts.push(valueText);
	if (logs.length > 0) parts.push(`Console:\n${formatLogs(logs)}`);
	if (parts.length === 0) return { text: "(no return value)" };
	const joined = parts.join("\n\n");
	const truncation = truncateHead(joined);
	if (!truncation.truncated) return { text: joined };
	const head = `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} line limit).`;
	const fullOutputPath = value === undefined ? undefined : await spillReturnValue(value);
	if (!fullOutputPath) return { text: `${head} Return less data.]` };
	return {
		text: `${head} Full return value as JSON: ${fullOutputPath} (use jq, or read with offset/limit)]`,
		fullOutputPath,
	};
}

/**
 * Run one script. Split from the tool definition so the execution path can be used with any
 * `ExtensionToolContext`-compatible loop context.
 */
export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const { code, options: sourceOptions } = parseCodemodeSource(input.code);
	const timeoutMs = sourceOptions.timeout === undefined ? Number.POSITIVE_INFINITY : sourceOptions.timeout * 1000;
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

	const modelGlobals = options.models ? createModelGlobals(options.models, toolCallId, calls, publish) : [];

	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: [
			...modelGlobals,
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
		result = await sandbox.execute(code, { signal, store: readCodemodeStore(ctx.sessionManager.getBranch()) });
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
	const { set, delete: deleted } = result.storeWrites;
	if (Object.keys(set).length > 0 || deleted.length > 0) {
		options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
	}

	const valueText = formatValue(result.value);
	const output = await formatOutput(result.value, valueText, result.logs);
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: output.text }];
	for (const index of [...attached].sort((a, b) => a - b)) {
		content.push(images[index - 1]);
	}
	const details = snapshot();
	if (valueText && typeof result.value !== "string") details.jsonLines = valueText.split("\n").length;
	if (output.fullOutputPath) details.fullOutputPath = output.fullOutputPath;
	return { content, details };
}

/**
 * `models.*` for scripts: the `ModelRuntime` methods declared in {@link MODEL_GLOBAL_DECLARATIONS}.
 * Classifier calls appear as nested call rows so the renderer shows them.
 */
function createModelGlobals(
	models: CodemodeModelRuntime,
	toolCallId: string,
	calls: CodemodeNestedCall[],
	publish: () => void,
): CodemodeTool[] {
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	let classifyCount = 0;
	const implementations: Record<string, CodemodeTool["execute"]> = {
		"models.getModelsOfType": (args) => {
			const [type, provider] = args as unknown[];
			return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
		},
		"models.getAvailableOfType": async (args, { signal }) => {
			const [type, provider] = args as unknown[];
			const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), { signal });
			return available.map(toModelInfo);
		},
		"models.getModelOfType": (args) => {
			const [type, provider, id] = args as unknown[];
			if (typeof provider !== "string" || typeof id !== "string") {
				throw new Error("models.getModelOfType() expects a type, a provider, and an id");
			}
			const model = models.getModelOfType(toModelType(type), provider, id);
			return model === undefined ? undefined : toModelInfo(model);
		},
		"models.classify": async (args, { signal }) => {
			const [model, context] = args as unknown[];
			const ref = model as { provider?: unknown; id?: unknown } | null;
			if (
				typeof ref !== "object" ||
				ref === null ||
				typeof ref.provider !== "string" ||
				typeof ref.id !== "string"
			) {
				throw new Error(
					"models.classify() expects a model from models.getModelOfType() or models.getAvailableOfType()",
				);
			}
			// Only provider and id count. A script-supplied baseUrl or headers must never receive the credentials.
			const resolved = models.getModelOfType("classifier", ref.provider, ref.id);
			if (!resolved) throw new Error(`Unknown classifier model "${ref.provider}/${ref.id}"`);

			const record: CodemodeNestedCall = {
				id: `${toolCallId}/models.classify/${++classifyCount}`,
				name: "models.classify",
				args: `${resolved.provider}/${resolved.id}`,
				status: "running",
			};
			calls.push(record);
			publish();
			const startedAt = performance.now();
			const result = await limit(() => models.classify(resolved, context as ClassifierContext, { signal }));
			record.durationMs = performance.now() - startedAt;
			record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
			if (result.errorMessage) record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
			publish();
			return result;
		},
	};
	return MODEL_GLOBAL_DECLARATIONS.map((declaration) => ({
		name: declaration.name,
		spread: true,
		execute: implementations[declaration.name],
	}));
}
