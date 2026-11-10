// The command menu's fuzzy scorer: each word of the query matches as a subsequence of a text, starting at a word start
// (or as a substring), with bonuses for word starts and contiguous runs. Commands, pages and searches rank with it.
import { useMemo } from "react";
import type { Command } from "../../runtime/web-core.ts";
import { useCommandQuery } from "./context.ts";

/** How well `query` matches `text`: 0 when it does not, higher is better. A query without words matches nothing. */
export function matchScore(query: string, text: string): number {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return 0;
	const chars = [...text];
	const lower = chars.map((char) => char.toLowerCase());
	const starts = chars.map((char, index) => index === 0 || wordStart(chars[index - 1]!, char));
	let total = 0;
	for (const term of terms) {
		const score = termScore([...term], lower, starts);
		if (score === 0) return 0;
		total += score;
	}
	return total;
}

/** How well `query` matches a command: its title, or one of its keywords. */
export function commandScore(query: string, command: Command): number {
	return Math.max(
		matchScore(query, command.title),
		...(command.keywords ?? []).map((word) => matchScore(query, word)),
	);
}

/** `items` matching the open page's query, best first (ties keep their order); all of them while it is empty. */
export function useCommandMatches<T>(items: readonly T[], text: (item: T) => string): readonly T[] {
	const query = useCommandQuery();
	return useMemo(
		() => (query.trim() === "" ? items : rankBy(items, (item) => matchScore(query, text(item)))),
		[items, text, query],
	);
}

/** The `items` whose `score` is positive, best first (ties keep their order). */
export function rankBy<T>(items: readonly T[], score: (item: T) => number): T[] {
	return items
		.map((item) => ({ item, score: score(item) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((entry) => entry.item);
}

const MATCH = 1;
const TEXT_START = 8;
const WORD_START = 6;
const CONTIGUOUS = 4;
const GAP = 0.5;
const LEAD = 0.05;

/**
 * The best alignment of `term` in `text` (both lower case, by character), by dynamic programming over (term character,
 * text position) in O(term × text). Its first character must sit on a word start, unless the whole term is a substring
 * there: the threshold that drops matches scattered inside words ("ce" in "Archive session").
 */
function termScore(term: readonly string[], text: readonly string[], starts: readonly boolean[]): number {
	let previous: number[] = [];
	for (let i = 0; i < term.length; i++) {
		const current = new Array<number>(text.length).fill(Number.NEGATIVE_INFINITY);
		// The best `previous[k] + GAP * k` over k < j: a jump from k to j costs GAP per character skipped.
		let bestJump = Number.NEGATIVE_INFINITY;
		for (let j = 0; j < text.length; j++) {
			if (i > 0 && j > 0) bestJump = Math.max(bestJump, previous[j - 1]! + GAP * (j - 1));
			if (text[j] !== term[i]) continue;
			const bonus = MATCH + (j === 0 ? TEXT_START : starts[j] ? WORD_START : 0);
			if (i === 0) {
				if (starts[j] || substringAt(term, text, j)) current[j] = bonus - LEAD * j;
				continue;
			}
			const contiguous = j > 0 ? previous[j - 1]! + CONTIGUOUS : Number.NEGATIVE_INFINITY;
			current[j] = bonus + Math.max(contiguous, bestJump - GAP * (j - 1));
		}
		previous = current;
	}
	const best = Math.max(...previous);
	return Number.isFinite(best) ? best : 0;
}

function substringAt(term: readonly string[], text: readonly string[], at: number): boolean {
	return term.every((char, index) => text[at + index] === char);
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** Whether `char` starts a word after `before`: after a non-alphanumeric, or a capital after a small letter. */
function wordStart(before: string, char: string): boolean {
	if (!ALPHANUMERIC.test(before)) return ALPHANUMERIC.test(char);
	return /\p{Lu}/u.test(char) && /\p{Ll}/u.test(before);
}
