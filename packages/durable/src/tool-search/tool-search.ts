/**
 * The `tool_search` tool, a copy of the coding agent's: the model searches the deferred tools it is not offered yet,
 * and the matches are loaded with `control.addTools`, so the next request offers them. Loading writes the
 * conversation's `modelTools` (its `add`), so loaded tools stay offered on that branch, also after a compaction.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { rankDocuments } from "../search.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** Fixed, so it does not change while deferred tools are registered, for example as MCP servers connect. */
const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

/** `tool_search` result details: the tools it loaded. */
export type ToolSearchToolDetails = { loaded: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/** Search text of a tool: its name, the name with `_` as spaces, its description, and its parameters' text. */
function searchText(tool: ToolRegistration): string {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	return parts.filter((part) => part.trim() !== "").join(" ");
}

export function createToolSearchTool() {
	return defineTool({
		name: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		parameters: toolSearchSchema,
		// Searching changes what the model is offered; scripts have their own `searchTools()`.
		callers: ["model"],
		replay: "safe",
		async execute({ query, limit }, api, context) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const candidates = (await api.agent(context)).deferred;
			const documents = candidates.map((tool) => ({ name: tool.name, text: searchText(tool) }));
			const loaded = rankDocuments(query, documents, max);
			const text =
				loaded.length === 0
					? "No matching tools found."
					: `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
							.map((name) => {
								const description = candidates.find((tool) => tool.name === name)?.description ?? "";
								return `- ${name}: ${description.trim().split(/\r?\n/)[0]}`;
							})
							.join("\n")}`;
			const details: ToolSearchToolDetails = { loaded };
			return {
				output: [{ type: "text", text }],
				details,
				...(loaded.length === 0 ? {} : { control: { addTools: loaded } }),
			};
		},
	});
}

/** The `tool_search` extension: install it and select it where the model should find deferred tools. */
export function createToolSearchExtension() {
	return defineExtension({ name: "tool-search", tools: [createToolSearchTool()] });
}
