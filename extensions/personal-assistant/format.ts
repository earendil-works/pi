// formatMemoryBlock / formatMemoryContext — pure renderers for recall results.
//
// Architecture constraints (from design.md):
//   - Search is discovery-only; results always carry only summary + file_path.
//   - Each block: [type] title / summary / file: <path> / Tags: <t1, t2, ...>
//     The agent uses the standard `read` tool on the file_path to fetch full
//     content on demand. We never hydrate content at format time.
//   - Token estimate: Math.ceil(text.length / 2.5) — rough, deterministic, no
//     tokenizer dependency. (R49: strict budget, never exceed.)
//   - Sort by distance ASC (best first) before packing into the budget (S57).
//   - Pure functions only. No I/O, no clock, no random.

import type { RecallResult } from "./types.ts";

/**
 * Format a single recall result as a single L0-style block. Pure.
 *
 * Block layout:
 *   [<type>] <title>
 *   <summary>
 *   file: <file_path>
 *   Tags: <t1, t2, ...>
 */
export function formatMemoryBlock(result: RecallResult): string {
	const { atom, file_path } = result;
	return `[${atom.type}] ${atom.title}\n${atom.summary}\nfile: ${file_path}\nTags: ${atom.tags.join(", ")}`;
}

/**
 * Rough token estimate: ~2.5 characters per token, ceiling to be conservative
 * (slight over-estimate, but never under). Matches R49's "strict budget" rule
 * (we never promise more tokens than this function reports).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 2.5);
}

/**
 * Render recall results into a single text block that fits within `tokenBudget`
 * tokens. Results are sorted by distance ascending (best first) and added one
 * at a time; we stop as soon as the next block would push us over the budget.
 *
 * Returns the concatenated text, the (estimated) tokens used, and the number
 * of results that were included. Pure / deterministic.
 */
export function formatMemoryContext(
	results: RecallResult[],
	tokenBudget: number,
): { text: string; used: number; included: number } {
	// Sort by distance asc (best first). Copy first so we never mutate the
	// caller's array.
	const sorted = [...results].sort((a, b) => a.distance - b.distance);

	let totalText = "";
	let usedTokens = 0;
	let included = 0;

	for (const r of sorted) {
		const block = formatMemoryBlock(r);
		const blockTokens = estimateTokens(block);
		// Strict budget: if adding this block would exceed, stop. Never
		// partially include a block.
		if (usedTokens + blockTokens > tokenBudget) break;
		totalText += (totalText ? "\n\n" : "") + block;
		usedTokens += blockTokens;
		included++;
	}

	return { text: totalText, used: usedTokens, included };
}