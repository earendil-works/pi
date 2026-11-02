/**
 * Tool discovery: a BM25 ranker over tool metadata, shared by `searchTools()` in codemode scripts and
 * the optional `tool_search` tool.
 *
 * `tool_search` searches tools that are not declared to
 * the model (`codemode` and `deferred` exposure) and loads the matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../../core/extensions/types.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** A tool as the ranker sees it: its name and the texts built by {@link createToolSearchDocument}. */
export interface ToolSearchDocument {
	name: string;
	/** Description, schema descriptions, and property names. */
	text: string;
	/** Name, description, and instructions of the tool's namespace. */
	namespaceText?: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Unicode word segmentation with identifier boundaries and English stop words/singular forms. */
export function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

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

/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.description];
	schemaText(tool.parameters, parts);
	const namespaceText = namespace
		? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
		: "";
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" "), namespaceText };
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}

/**
 * Whether the whole query is the tool's name: its full name or a suffix after a `__` separator, so
 * `thread_read` and `app__thread_read` both name `mcp__app__thread_read`.
 */
function isExactNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}

/** A document split into the fields the ranker weighs differently. */
interface IndexedDocument {
	name: string;
	/** Terms of the name, for example `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	nameTerms: ReadonlySet<string>;
	/** Terms of the last `__` segment of the name, the part models say: `thread`, `read`. */
	localNameTerms: readonly string[];
	textCounts: ReadonlyMap<string, number>;
	textLength: number;
	namespaceTerms: ReadonlySet<string>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most
 * `k1 + 1` (2.2) times its IDF and about 1 for a single mention, so a name match beats any number of
 * mentions in the description.
 */
const NAME_WEIGHT = 3;

/**
 * A query term in the namespace name, description, or instructions counts this many times its IDF. They
 * are shared by every tool of the server, so they help find the server but not the tool in it.
 */
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields:
 * - a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words;
 * - a query that is exactly a tool's name ranks that tool first, before coverage.
 *
 * The description alone is length-normalized, so a long name or long namespace instructions do
 * not lower a tool's score. Ties keep document order.
 */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = new Set(tokenize(query));
		if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
		const indexed = documents.map(indexDocument);
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		const idf = new Map(
			[...queryTerms].map((term) => {
				const frequency = indexed.filter(
					(document) =>
						document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
				).length;
				return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		const exactQuery = normalizeName(query);
		const matches: (ToolSearchMatch & { covered: number; exact: boolean })[] = [];
		for (const document of indexed) {
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			let score = 0;
			let covered = 0;
			for (const term of queryTerms) {
				const count = document.textCounts.get(term) ?? 0;
				const weight =
					(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
					(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
					(count * (this.k1 + 1)) / (count + norm);
				if (weight > 0) covered++;
				score += (idf.get(term) ?? 0) * weight;
			}
			if (score === 0) continue;
			const local = document.localNameTerms;
			if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
		}
		return matches
			.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
			.slice(0, limit)
			.map(({ name, score }) => ({ name, score }));
	}
}

export const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

export interface ToolSearchResultTool {
	name: string;
	description: string;
}

export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** Whether `tool_search` can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so the next model
 * call declares them. Activation is recorded in the transcript like any tool change.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchResultTool[] {
	const active = tools.getActiveTools();
	const candidates = tools.getAllTools().filter((tool) => isSearchable(tool.exposure) && !active.includes(tool.name));
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	return matches.map((match) => ({
		name: match.name,
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

/**
 * The `tool_search` description. It does not list the searchable tools or their namespaces, so it
 * stays the same while tools are registered, for example when MCP servers connect.
 */
export const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		// A query can match any tool that is not declared yet.
		reachesTools: () => "all",
		async execute(_toolCallId, { query, limit }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			return { content: [{ type: "text", text }], details: { loaded: tools.map((tool) => tool.name) } };
		},
	};
}
