/**
 * BM25 tool search for code mode's `searchTools()` and the `tool_search` tool, a copy of the coding agent's tool search
 * ranking: durable keeps its own copy of what it needs from the coding agent.
 */

export type SearchDocument = { readonly name: string; readonly text: string };

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

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

/** Okapi BM25 (k1 1.2, b 0.75): the names of the best matches, best first; ties keep document order. */
export function rankDocuments(query: string, documents: readonly SearchDocument[], limit: number): string[] {
	const k1 = 1.2;
	const b = 0.75;
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
	const termCounts = documents.map((document) => {
		const counts = new Map<string, number>();
		for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
		return counts;
	});
	const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
	const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
	const idf = new Map(
		queryTerms.map((term) => {
			const frequency = termCounts.filter((counts) => counts.has(term)).length;
			return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
		}),
	);
	const matches: { name: string; score: number }[] = [];
	documents.forEach((document, index) => {
		let score = 0;
		for (const term of queryTerms) {
			const count = termCounts[index]!.get(term);
			if (!count) continue;
			const norm = k1 * (1 - b + (b * lengths[index]!) / averageLength);
			score += (idf.get(term) ?? 0) * ((count * (k1 + 1)) / (count + norm));
		}
		if (score > 0) matches.push({ name: document.name, score });
	});
	return matches
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map((match) => match.name);
}
