/**
 * Runs one codemode script in the sandbox. Split from tool.ts and loaded through
 * execute.lazy.ts so the sandbox runtime only loads when a script runs.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AnyModel, ClassifierContext, ImageContent, ModelType, TextContent, Usage } from "@earendil-works/pi-ai";
import {
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import { getCodemodeWorkerUrl, getQuickJSWasmPath } from "../../config.ts";
import type { ExtensionToolContext } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "../tool-search/tool.ts";
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
	toCodemodeDeclaration,
} from "./tool.ts";

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
/** Classifier calls one script may have in flight; `Promise.all` over many items queues the rest. */
const MAX_CONCURRENT_MODEL_CALLS = 4;
/**
 * Heap limit for the QuickJS VM. The worker shares pi's process, so without a limit a runaway
 * script can grow to wasm32's 4 GiB and take the session down. Overruns throw
 * `InternalError: out of memory` inside the script.
 */
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
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

/** Default token budget for script output. */
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** Characters per token when estimating. */
const CHARS_PER_TOKEN = 4;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(calls)}`;
}

/** Write the full text output to a temp file, like bash does for truncated output. */
async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
	const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
	try {
		await writeFile(path, text);
		return { path };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Apply the token budget: when the combined text exceeds it, the text items become one
 * item that keeps the start and end of the text, and images follow it. The full text is written to
 * a temp file.
 */
async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	const spilled = await spillOutput(combined);
	text +=
		"path" in spilled
			? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${spilled.error}]`;
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

/**
 * The value a script receives for a nested call: a tool that declares
 * `outputSchema` resolves to its `structuredContent`, also for error results that carry one (such
 * as MCP results with `isError`); any other tool resolves to its text content. Other failures
 * reject with the tool's error text.
 */
function toScriptValue(tool: AgentTool<any>, outcome: AgentToolCallOutcome): unknown {
	const { result } = outcome;
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

/**
 * Run one script. Without a session context (a plain Agent or a direct call) scripts cannot call
 * tools, `store()` starts empty, and writes are dropped.
 */
export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const startedAt = performance.now();
	const { code, options: sourceOptions } = parseCodemodeSource(input.code);
	const calls: CodemodeNestedCall[] = [];
	// Usage of the script's `models.*` calls. Nested tool calls report theirs through the session.
	let modelUsage: Usage | undefined;
	const addModelUsage = (usage: Usage) => {
		modelUsage = modelUsage ? combineUsage(modelUsage, usage) : usage;
	};

	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => onUpdate?.({ content: [], details: snapshot() });

	const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];
	// ALL_TOOLS entries carry the declaration.
	const samples = new Map(callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool))]));
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: async (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/?`,
				name: tool.name,
				args: previewArgs(args),
				status: "running",
			};
			calls.push(record);
			publish();
			const callStartedAt = performance.now();
			// Only tools from ctx.tools are callable, so ctx is set here.
			if (!ctx) throw new Error("Tool calls need a session");
			const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			record.id = outcome.toolCall.id;
			record.durationMs = performance.now() - callStartedAt;
			if (outcome.isError) {
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(textOf(outcome.result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS);
			} else {
				record.status = "ok";
			}
			publish();
			return toScriptValue(tool, outcome);
		},
	}));

	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: [
			...createDiscoveryGlobals(callable, samples, options),
			...(options.models && ctx
				? createModelGlobals(ctx.modelRegistry, toolCallId, calls, publish, addModelUsage)
				: []),
		],
		timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
		memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerUrl(),
	});

	let result: CodemodeResult;
	try {
		const store = ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {};
		result = await sandbox.execute(code, { signal, store });
	} finally {
		await sandbox.close();
	}
	// Calls still marked running were cut off by the script ending, a timeout, or an abort.
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	const items: (TextContent | ImageContent)[] = result.output.map((item) =>
		item.type === "text" ? { type: "text", text: item.text } : item,
	);
	if (result.ok) {
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0) {
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
		}
		// pi extension: a returned value is appended like text().
		if (result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
	} else {
		items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	}

	const truncated = await truncateOutput(items, sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details = snapshot();
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		content: [{ type: "text", text: header }, ...truncated.items],
		details,
		...(modelUsage ? { usage: modelUsage } : {}),
		...(result.ok ? {} : { isError: true }),
	};
}

/** `searchTools()` and `describeTool()`: ranked search and lookup over the script's nested tools. */
function createDiscoveryGlobals(
	tools: readonly AgentTool<any>[],
	samples: ReadonlyMap<string, string>,
	options: CodemodeToolOptions,
): CodemodeTool[] {
	const ranker = new Bm25Ranker();
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (namespace && toolNamespace?.name !== namespace) return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
	];
}

/**
 * `models.*` for scripts: the model registry methods declared in {@link MODEL_GLOBAL_DECLARATIONS}.
 * Classifier calls appear as nested call rows so the renderer shows them, and their usage goes to
 * `addUsage`.
 */
function createModelGlobals(
	models: CodemodeModelRuntime,
	toolCallId: string,
	calls: CodemodeNestedCall[],
	publish: () => void,
	addUsage: (usage: Usage) => void,
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
			if (result.usage) {
				record.cost = result.usage.cost.total;
				addUsage(result.usage);
			}
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
