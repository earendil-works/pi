// A keyword query as an FTS5 MATCH expression, built here and never taken as raw FTS syntax (the history tools pass
// what a model wrote). Every term is required. `"…"` is a phrase; `word*` a prefix; a term with punctuation
// (`tx.draft`, `next/diff.ts`) becomes the phrase of its words (`"tx draft"`), as the index's tokenizer splits it.

/** Characters that are part of a word for the index's tokenizer (unicode61): letters, digits, and the rest of a word. */
const WORD = /[\p{L}\p{N}\p{M}_]+/gu;

/** The words of `text` as the tokenizer sees them. */
const words = (text: string): string[] => text.match(WORD) ?? [];

/** A quoted FTS5 string (a phrase of `parts`). */
const phrase = (parts: readonly string[]): string => `"${parts.join(" ").replaceAll('"', '""')}"`;

/** The MATCH expression for `query`, or undefined when it has no searchable word. */
export function ftsQuery(query: string): string | undefined {
	const terms: string[] = [];
	for (const match of query.matchAll(/"([^"]*)"|(\S+)/g)) {
		const [, quoted, bare] = match;
		if (quoted !== undefined) {
			const parts = words(quoted);
			if (parts.length) terms.push(phrase(parts));
			continue;
		}
		if (bare === undefined) continue;
		const prefix = bare.endsWith("*");
		const parts = words(prefix ? bare.slice(0, -1) : bare);
		if (!parts.length) continue;
		// A prefix applies to a single word; a punctuated term is a phrase (its last word may still be a prefix).
		terms.push(prefix ? `${phrase(parts)}*` : phrase(parts));
	}
	return terms.length ? terms.join(" AND ") : undefined;
}
