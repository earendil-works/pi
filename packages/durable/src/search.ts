/**
 * BM25 tool search for code mode's `searchTools()` and the `tool_search` tool, a copy of the coding agent's tool search
 * ranking: durable keeps its own copy of what it needs from the coding agent.
 */

/** A tool as the ranker sees it: its name, its text, and the text of its namespace. */
export type SearchDocument = {
	readonly name: string;
	/** Description and parameter names and descriptions; not the name, which the ranker reads from `name`. */
	readonly text: string;
	/** Name, description, and instructions of the tool's namespace. */
	readonly namespaceText?: string;
};

/**
 * Okapi BM25 (k1 1.2, b 0.75) over `text`, with the name and the namespace as separate fields: the names of the best
 * matches, best first; ties keep document order.
 * - A tool that matches more of the query's terms, in any field, ranks above one that matches fewer, whatever their
 *   scores: for `screenshot window`, a tool whose description has both words beats `window` whose name has one.
 * - A query term in the name scores more than any number of mentions in the text.
 * - A tool whose whole local name (after the last `__`) is in the query gets a bonus worth one more match of every
 *   query term, so among tools matching as many terms, `peekaboo app` finds `mcp__peekaboo__app` over tools that
 *   only mention the words.
 * - A query that is exactly a tool's name, or its name after a `__`, ranks that tool first, before coverage.
 *
 * Only `text` is length-normalized, so a long name or long namespace instructions do not lower a tool's score.
 */
export function rankDocuments(query: string, documents: readonly SearchDocument[], limit: number): string[] {
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
	const matches: { name: string; score: number; covered: number; exact: boolean }[] = [];
	for (const document of indexed) {
		const norm = K1 * (1 - B + (B * document.textLength) / averageLength);
		let score = 0;
		let covered = 0;
		for (const term of queryTerms) {
			const count = document.textCounts.get(term) ?? 0;
			const weight =
				(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
				(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
				(count * (K1 + 1)) / (count + norm);
			if (weight > 0) covered++;
			score += idf.get(term)! * weight;
		}
		if (score === 0) continue;
		const local = document.localNameTerms;
		if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
		matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
	}
	return matches
		.sort(
			(left, right) =>
				Number(right.exact) - Number(left.exact) || right.covered - left.covered || right.score - left.score,
		)
		.slice(0, limit)
		.map((match) => match.name);
}

const K1 = 1.2;

const B = 0.75;

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most `K1 + 1` (2.2) times
 * its IDF and about 1 for a single mention, so a name match beats any number of mentions in the text.
 */
const NAME_WEIGHT = 3;

/**
 * A query term in the namespace text counts this many times its IDF. Every tool of the namespace shares it, so it helps
 * find the namespace but not the tool in it.
 */
const NAMESPACE_WEIGHT = 0.5;

/** A document split into the fields the ranker weighs differently. */
type IndexedDocument = {
	name: string;
	/** Terms of the name: `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	nameTerms: ReadonlySet<string>;
	/** Terms of the name after its last `__`, the part models say: `thread`, `read`. */
	localNameTerms: readonly string[];
	textCounts: ReadonlyMap<string, number>;
	textLength: number;
	namespaceTerms: ReadonlySet<string>;
};

function indexDocument(document: SearchDocument): IndexedDocument {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]!))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
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

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}

/**
 * Whether the whole query is the tool's name: its full name or a suffix after a `__` separator, so `thread_read` and
 * `app__thread_read` both name `mcp__app__thread_read`.
 */
function isExactNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}
