/**
 * Durable code mode: a tool that runs model-written JavaScript or TypeScript in a djs sandbox, whose script survives a
 * restart (see `call.ts`). This module holds the tool, its extension and prompt section, the documents a call keeps,
 * and what a script sees of nested calls and the discovery globals.
 *
 * Documents, scoped to the code mode call's task and gone when it settles:
 * - `pi.codemode.run`: the start (what the script can reach, written once before the VM starts) and the outcome,
 *   written once when the call decides it (with the store writes, in one transaction), so a rerun after that returns
 *   it without a VM.
 * - `pi.codemode.saved` (`call.ts`): the script's latest dump.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { TextContent } from "@earendil-works/pi-ai";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { CodemodeHostCall, CodemodeOutcome, CodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { obj, type Static, str } from "@earendil-works/pi-schema";
import { defineDoc } from "../documents.ts";
import { defineExtension, defineTool, section } from "../harness/define.ts";
import type {
	Extension,
	NestedToolExecutionResult,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "../harness/types.ts";
import { rankDocuments } from "../search.ts";
import type { JsonObject } from "../types.ts";
import { CodemodeCall } from "./call.ts";
import {
	codemodeDescription,
	codemodeSection,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	declaredNamespaces,
	namespacesOf,
	sampleOf,
} from "./describe.ts";
import { CATALOG_GLOBALS, CODEMODE_INTERNAL_PREFIX, createModelTools, MODEL_CALLS } from "./models.ts";

/**
 * Version of what a stored call means: the start data, the saved dump, result mapping, globals. Bump it when that
 * changes; a call started under another version ends with an error result that asks for the script to be run again.
 */
export const CODEMODE_MODULE_VERSION = 3;

export const CODEMODE_TOOL_NAME = "codemode";

/** One tool as the script sees it: `tools.<jsName>`. */
/**
 * `structured`: the tool declares `structuredOutputSchema`, so an error result with a value resolves with it.
 * `hidden`: an internal tool of this extension (`pi.codemode.*`), which scripts reach only through a global such as
 * `models.classify()`; never in `tools`, `ALL_TOOLS`, or tool search.
 */
type DeclaredTool = { name: string; jsName: string; description: string; structured?: true; hidden?: true };

/** What a call starts with; a resume gives the VM exactly this scope. */
export type Start = {
	version: number;
	startedAt: number;
	/** `startedAt + timeout_ms` when the script set one. */
	deadline?: number;
	tools: DeclaredTool[];
	/**
	 * The namespaces the selected extensions declare (`Extension.namespace`), with their tools, as `describeNamespace()`
	 * and `searchTools()` see them; a namespace without tools yet is listed too.
	 */
	namespaces: { name: string; description?: string; instructions?: string; tools: string[] }[];
	globals: { name: string; spread: boolean }[];
	/** `max_output_tokens` of the script's options line, or the default. */
	maxOutputTokens: number;
	store: Record<string, JsonValue>;
};

type RunState = {
	start?: Start;
	/** Directory of the result's files (the full output, images), created once: a rerun writes the same files again. */
	outputDir?: string;
	/** The outcome, decided once. */
	result?: JsonObject;
};

export const CodemodeRunDoc = defineDoc<RunState>({
	kind: "pi.codemode.run",
	version: 1,
	scope: "task",
	initial: () => ({}),
	// The document retires with its task.
	checkpointWhen: () => false,
});

/**
 * What scripts keep with `store()` and read with `load()`, per conversation. Rewindable and copied as of the fork
 * point, so a fork sees the values as they were when its entry was committed.
 */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
	kind: "pi.codemode.store",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** One tool call a script made, as the code mode call's details show it. */
export type CodemodeNestedCall = {
	/** The VM's number for the call; its nested call ID is `<callId>/c<id>`. */
	id: number;
	name: string;
	/** Compact JSON of the arguments, cut for display. */
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	/** Error text, cut for display. */
	error?: string;
};

/**
 * The code mode call's details, in its result: its tool calls in the order it made them, with their status. Calls to
 * globals are not listed. While the script runs, UIs show its nested calls from `pi.live.nestedTools`, so the list is
 * written once, with the result.
 */
export type CodemodeToolDetails = {
	calls: CodemodeNestedCall[];
	/** Temp file with the complete text output, when the output was cut to its token budget. */
	fullOutputPath?: string;
};

/** A function scripts call as a top-level global. */
export type CodemodeGlobal = {
	readonly name: string;
	readonly spread?: boolean;
	execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<JsonValue | undefined>;
};

const codemodeSchema = obj({ code: str({ description: "Raw JavaScript or TypeScript source." }) }, { open: true });

export type CodemodeToolInput = Static<typeof codemodeSchema>;

export type CodemodeToolOptions = {
	/**
	 * Runs the scripts on the calling thread. An idle script is saved, and parks while its calls take longer than
	 * `parkAfterMs`.
	 */
	readonly sandbox: CodemodeSandbox;
	/** How long the script waits on its calls before it parks. Default 1000. */
	readonly parkAfterMs?: number;
	/** Estimated tokens the tool declarations in the `codemode` section may use. Default 3000. */
	readonly inlineBudget?: number;
	/** Give scripts `models.*`: the model catalog, classifiers, and image generation. Default true. */
	readonly models?: boolean;
	/** @internal Host functions scripts call as globals. */
	readonly globals?: readonly CodemodeGlobal[];
};

/** Outputs bounded by the script's own token budget; the Harness's limits only stop a runaway. */
export const OUTPUT_LIMITS = { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 } as const;

/** Globals for finding tools, answered from the start data, so a resumed script sees what the first run saw. */
export const DISCOVERY_GLOBALS = ["searchTools", "describeTool", "describeNamespace"] as const;
const DEFAULT_SEARCH_LIMIT = 8;

/** The code mode tool. Scripts call the conversation's callable tools as `tools.<name>(args)`. */
export function createCodemodeTool(options: CodemodeToolOptions): ToolRegistration<typeof codemodeSchema> {
	return defineTool({
		name: CODEMODE_TOOL_NAME,
		description: codemodeDescription(options.models !== false),
		parameters: codemodeSchema,
		outputLimits: OUTPUT_LIMITS,
		// Capable models write the script as raw text instead of a JSON-escaped string; pi-ai applies it only for them.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		callers: ["model"],
		replay: "safe",
		execute: (args, api, context) => new CodemodeCall(options, api, context).execute(args.code),
	});
}

/**
 * The `codemode` extension: the code mode tool, and the `codemode` prompt section listing the tools scripts can call.
 */
export function createCodemodeExtension(options: CodemodeToolOptions): Extension {
	return defineExtension({
		name: "codemode",
		tools: [createCodemodeTool(options), ...(options.models === false ? [] : createModelTools())],
		sections: [
			section("codemode", (input) =>
				codemodeSection(
					// Deferred tools are found with `searchTools()`, as the coding agent leaves them out too.
					input.agent.callable.filter(
						(tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) && tool.deferred !== true,
					),
					input.agent.extensions,
					options.inlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET,
				),
			),
		],
	});
}

/**
 * What a script gets for a nested call, as in the coding agent. A tool with a schema resolves with its value, also on
 * an error result that carries one (`bash`'s `{ output, exitCode }` for a nonzero exit); a schema-less tool
 * resolves with its text output, images left out, as its declaration says. Any other error rejects, with its text: a
 * schema-less tool's output, else its error diagnostics.
 */
export function outcomeOf(name: string, structured: boolean, result: NestedToolExecutionResult): CodemodeOutcome {
	const value = structured ? result.structuredOutput : textOf(result.structuredOutput);
	if (!result.isError || (structured && value !== undefined)) return { ok: true, value };
	const message = structured ? "" : (value as string);
	const diagnostics = result.diagnostics
		.filter((diagnostic) => diagnostic.severity === "error")
		.map((diagnostic) => diagnostic.message)
		.join("\n");
	return {
		ok: false,
		message: message || diagnostics || `Tool ${name} failed`,
		...(value === undefined ? {} : { properties: { structuredOutput: value } }),
	};
}

/** The text of a schema-less tool's collapsed output: a string, one image, or an array of text and image blocks. */
function textOf(value: JsonValue | undefined): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.flatMap((item) => (isText(item) ? [item.text] : [])).join("\n");
}

function isText(item: unknown): item is TextContent {
	return typeof item === "object" && item !== null && (item as TextContent).type === "text";
}

export function errorResult(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/** What a script started now can reach: the conversation's callable tools, namespaces, and globals. */
export async function declaredScope(
	options: CodemodeToolOptions,
	api: ToolExecutionApi,
	context: Context,
): Promise<Pick<Start, "tools" | "namespaces" | "globals">> {
	const agent = await api.agent(context);
	const tools: DeclaredTool[] = agent.callable.map((tool) => ({
		name: tool.name,
		jsName: toCodemodeIdentifier(tool.name),
		description: sampleOf(tool),
		...(tool.structuredOutputSchema === undefined ? {} : { structured: true as const }),
		...(tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) ? { hidden: true as const } : {}),
	}));
	const callable = agent.callable.filter((tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX));
	const models = options.models === false ? [] : [...CATALOG_GLOBALS, ...Object.keys(MODEL_CALLS)];
	const globals = [
		...DISCOVERY_GLOBALS.map((name) => ({ name, spread: true })),
		...models.map((name) => ({ name, spread: true })),
		...(options.globals ?? []).map((global) => ({ name: global.name, spread: global.spread === true })),
	];
	const toolNamespaces = namespacesOf(agent.extensions);
	const namespaces: Start["namespaces"] = declaredNamespaces(agent.extensions).map((namespace) => ({
		name: namespace.name,
		description: namespace.description,
		...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
		tools: callable.filter((tool) => toolNamespaces.get(tool.name)?.name === namespace.name).map((tool) => tool.name),
	}));
	return { tools, namespaces, globals };
}

/** `searchTools()`, `describeTool()`, `describeNamespace()`: answered from the start data. */
export function discover(start: Start, call: Pick<CodemodeHostCall, "name" | "args">): JsonValue | undefined {
	const args = Array.isArray(call.args) ? call.args : [];
	const { namespaces } = start;
	const tools = start.tools.filter((tool) => tool.hidden !== true);
	const namespaceOfTool = (name: string) => namespaces.find((namespace) => namespace.tools.includes(name));
	const matchesNamespace = (namespace: Start["namespaces"][number], query: string) =>
		namespace.name === query || toCodemodeIdentifier(namespace.name) === toCodemodeIdentifier(query);
	if (call.name === "describeTool") {
		const [name] = args;
		if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
		return tools.find((tool) => tool.name === name || tool.jsName === name)?.description;
	}
	if (call.name === "describeNamespace") {
		const [name] = args;
		if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
		const namespace = namespaces.find((candidate) => matchesNamespace(candidate, name));
		if (namespace === undefined) return undefined;
		return {
			name: namespace.name,
			...(namespace.description === undefined ? {} : { description: namespace.description }),
			...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
			tools: namespace.tools.map((tool) => toCodemodeIdentifier(tool)),
		};
	}
	const [query, options] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
	if (typeof query !== "string") throw new Error("searchTools() expects a query string");
	const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
		throw new Error("searchTools() limit must be a positive integer");
	}
	const namespace = options?.namespace;
	if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
		throw new Error("searchTools() namespace must be a string");
	}
	const documents = tools.flatMap((tool) => {
		const own = namespaceOfTool(tool.name);
		if (typeof namespace === "string" && (own === undefined || !matchesNamespace(own, namespace))) return [];
		const namespaceText =
			own === undefined ? "" : [own.name, own.description ?? "", own.instructions ?? ""].join(" ");
		// `description` is the tool's sample: its description and declaration, with the parameters' names and descriptions.
		return [{ name: tool.name, text: tool.description, namespaceText }];
	});
	return rankDocuments(query, documents, limit).map((name) => {
		const tool = tools.find((candidate) => candidate.name === name)!;
		return { name: tool.jsName, description: tool.description };
	});
}
