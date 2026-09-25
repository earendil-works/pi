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

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeLog, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderDeclarations } from "@earendil-works/pi-codemode/declarations";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { loadCodemodeExecutor } from "./codemode-execute.lazy.ts";
import { codemodeRenderers } from "./renderers/codemode.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const CODEMODE_TOOL_NAME = "codemode";

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
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

export function createCodemodeToolDefinition(): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the active tools when codemode is activated.
		description: createCodemodeDescription([]),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// The sandbox (worker, QuickJS wasm) loads on the first call, not at startup.
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx),
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
