import type { MemoryIndex } from "./storage.ts";

const CHINESE_RE = /[\u4e00-\u9fff]/;

/**
 * Scan `tags` on every active atom, count frequencies, return the top K tags
 * (sorted by count DESC, then alphabetically ASC as a stable tiebreaker).
 *
 * Pure function. Each call is O(n) over the corpus (≈5ms for ~90 atoms,
 * ≈50ms for ~1000 atoms — see scenarios L156-160). Callers should memoize the
 * result in memory and only re-invoke when the corpus mutates.
 */
export function loadTagVocabulary(index: MemoryIndex, topK = 50): string[] {
	const counts = new Map<string, number>();
	for (const atom of index.getActiveAtoms()) {
		for (const tag of atom.tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, topK)
		.map(([tag]) => tag);
}

/**
 * Normalize a single tag.
 *
 * Steps:
 *   1. Trim whitespace; empty → empty string.
 *   2. Dictionary exact match → use that exact form (preserves the canonical
 *      casing the dictionary stores).
 *   3. Dictionary lowercase match → use the lowercase form (so a dict of
 *      {"pdf"} accepts both "pdf" and "PDF").
 *   4. No match → case-fold, but only ASCII. If the input contains CJK
 *      (Unicode range U+4E00–U+9FFF), return it unchanged — Chinese has no
 *      case concept, and `toLowerCase()` would be a no-op anyway but the
 *      explicit guard documents the intent.
 */
export function normalizeTag(input: string, dictionary?: Set<string>): string {
	const trimmed = input.trim();
	if (trimmed.length === 0) return "";
	if (dictionary?.has(trimmed)) return trimmed;
	if (dictionary?.has(trimmed.toLowerCase())) return trimmed.toLowerCase();
	return foldCase(trimmed);
}

function foldCase(s: string): string {
	// CJK range has no case concept — preserve verbatim.
	if (CHINESE_RE.test(s)) return s;
	return s.toLowerCase();
}

/**
 * Count tags in the `concept/` namespace (e.g. `concept/fix`,
 * `concept/location`). Concept tags encode cross-cutting properties that
 * span otherwise unrelated atoms; missing them is a warn-but-keep signal,
 * not a hard error (principles.md).
 */
export function conceptTagCount(tags: string[]): number {
	return tags.filter((t) => t.startsWith("concept/")).length;
}