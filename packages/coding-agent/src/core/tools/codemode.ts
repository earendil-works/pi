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
 *
 * The input is the script itself, optionally starting with `// @options {"timeout": 30}`. Models
 * that support grammar-constrained tool input write it as raw text; others send it as the `code`
 * string. `store(key, value)` and `load(key)` keep JSON values across calls; successful scripts
 * append their writes to the session as `codemode-store` custom entries, so each branch sees the
 * values written on its own path.
 *
 * With model access, scripts also get `models`, a subset of `ModelRuntime`: listing the model
 * catalog and running classifier models.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeLog, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderDeclarations } from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { loadCodemodeExecutor } from "./codemode-execute.lazy.ts";
import { codemodeRenderers } from "./renderers/codemode.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

/** The part of `ModelRuntime` that scripts reach through `models`. */
export type CodemodeModelRuntime = Pick<
	ModelRuntime,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify"
>;

export interface CodemodeToolOptions {
	/** Exposes the `models` namespace to scripts. Without it, `models` is not declared. */
	models?: CodemodeModelRuntime;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
}

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	code: Type.String({
		description:
			'Body of an async JavaScript function. Top-level await and return work. May start with a `// @options {"timeout": 30}` line.',
	}),
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
	/** Number of leading output lines holding the JSON-serialized return value, if the value was not a string. */
	jsonLines?: number;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools (chains, loops, Promise.all, filtering large results)",
	guidelines: [
		"Use codemode to batch or chain several tool calls, or to filter large tool output down to what you need, instead of issuing many individual tool calls.",
	],
} as const;

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. Use it to chain, loop over, or parallelize tool calls (for example with Promise.all) and to reduce large results to what you need. You only see the return value, console output, and images attached with image(); nested tool results are not shown to you otherwise.

- The input is the body of an async function: top-level \`await\` and \`return\` work. Return JSON-serializable values.
- The first line may set options: \`// @options {"timeout": 30}\`. \`timeout\` is in seconds; by default there is none.
- Call tools as \`await tools.<name>(args)\` with one object argument matching the tool's parameters. Use \`tools["name"](args)\` for names that are not identifiers.
- A tool resolves to its declared result type; tools declared as \`Promise<string>\` resolve to their text output. Images in text output appear as \`[image:N mime]\` references.
- A failing or blocked tool call rejects with an Error carrying the tool's error text. Catch it to continue.
- \`console.log/info/warn/error/debug\` output is returned together with the result.
- \`store(key, value)\` saves a JSON-serializable value for later codemode calls in this session; \`load(key)\` reads it back (or \`undefined\`). Storing \`undefined\` deletes the key. Writes are kept only if the script succeeds.
- Nothing else is available: no filesystem, network, process, timers, require, or import. Use tools instead.
- Calls that are still running when the script returns are cancelled; await everything you start.
- Tool calls are real and have side effects. If the script fails partway, earlier calls are not undone.`;

const STORE_DECLARATIONS = `/** Save a JSON-serializable value for later codemode calls. \`undefined\` deletes the key. */
declare function store(key: string, value: unknown): void;
/** Read a value saved with store(), or undefined. */
declare function load(key: string): unknown;`;

const MODEL_TYPES = `type ModelType = "chat" | "image" | "classifier";
/** A model catalog entry. \`provider\` and \`id\` identify it; the other fields depend on the type. */
interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  contextWindow?: number;
  [key: string]: unknown;
}
type ClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };
type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };
interface ClassifierContext {
  state: Record<string, unknown>;
  questions: Record<string, ClassifierQuestion>;
}
interface ClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}`;

/** Declarations of the `models` globals; codemode-execute.ts implements them. */
export const MODEL_GLOBAL_DECLARATIONS: readonly Omit<CodemodeTool, "execute">[] = [
	{
		name: "models.getModelsOfType",
		description: "Every known model of a type, optionally for one provider.",
		signature: "(type: ModelType, provider?: string): Promise<ModelInfo[]>",
	},
	{
		name: "models.getAvailableOfType",
		description: "Models of a type whose provider has working credentials.",
		signature: "(type: ModelType, provider?: string): Promise<ModelInfo[]>",
	},
	{
		name: "models.getModelOfType",
		description: "One catalog entry, or undefined.",
		signature: "(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>",
	},
	{
		name: "models.classify",
		description:
			"Run a classifier model on one state. Only `provider` and `id` of `model` are used. Provider errors do not throw: check `stopReason` and `errorMessage`.",
		signature: "(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>",
	},
];

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

/**
 * Model-facing description, including TypeScript declarations for the callable tools. `models`
 * declares the `models` namespace; pass it only when the tool was created with model access.
 */
export function createCodemodeDescription(
	tools: readonly AgentTool<any>[],
	options: { models?: boolean } = {},
): string {
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
			...(options.models ? MODEL_GLOBAL_DECLARATIONS.map((global) => ({ ...global, execute: noop })) : []),
		],
	});
	const types = options.models ? `${MODEL_TYPES}\n\n` : "";
	return `${DESCRIPTION_INTRO}\n\nAvailable API:\n\`\`\`ts\n${types}${declarations}\n\n${STORE_DECLARATIONS}\n\`\`\``;
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the active tools when codemode is activated.
		description: createCodemodeDescription([], { models: options.models !== undefined }),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// The sandbox (worker, QuickJS wasm) loads on the first call, not at startup.
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(
	tools: readonly AgentTool<any>[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools, { models: options.models !== undefined }),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
