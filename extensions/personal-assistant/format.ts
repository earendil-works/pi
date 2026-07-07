// formatMemoryBlock / formatMemoryContext — pure renderers for recall results.
//
// Architecture constraints:
//   - Search is discovery-only; results carry {id, type, title, summary, tags,
//     cosine, sparseScore, rrf, relativePath}.
//   - Each block: [type] title / summary / file: <relativePath>
//     The agent uses the `read` tool on the full path to fetch full content.
//     The `read` tool's tool_result hook in memory.ts is the sole programmatic
//     strength-feedback entry — it bumps `access_count` and stamps `last_access`
//     for the matched atom. The base directory is disclosed in the context
//     injection prefix so the LLM can resolve `<relativePath>` to an absolute
//     path for the read call.
//   - Token estimate: Math.ceil(text.length / 2.5) — rough, deterministic, no
//     tokenizer dependency. (R49: strict budget, never exceed.)
//   - Sort by rerankScore DESC (cross-encoder rerank is the new ranking
//     authority; recall-precision R3 / design.md D5), with `rrf` DESC as the
//     tie-breaker for hits that don't carry a rerankScore. The client does
//     not re-rank — the server's rerank stage is the sole ranking authority.
//   - Pure functions only. No I/O, no clock, no random.

import type { RecallResult } from "./types.ts";

/**
 * Format a single recall result as a single L0-style block. Pure.
 *
 * Block layout:
 *   [<type>] <title>
 *   <summary>
 *   file: <relativePath>
 *
 * The LLM uses the `file:` line to call the `read` tool with the full path
 * (atomsDir from the context prefix + relative path). The `read` tool's
 * tool_result hook in memory.ts then records the strength feedback by
 * bumping `access_count` for the matched atom.
 */
export function formatMemoryBlock(result: RecallResult): string {
	const { atom } = result;
	return `[${atom.type}] ${atom.title}\n${atom.summary}\nfile: ${result.relativePath ?? ""}`;
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
 * tokens. Results are re-sorted by `rerankScore` DESC (server's cross-encoder
 * rerank output — the client does not re-rank), with `rrf` DESC as the
 * tie-breaker for hits that don't carry a `rerankScore`. Added one at a time;
 * we stop as soon as the next block would push us over the budget.
 *
 * Returns the concatenated text, the (estimated) tokens used, and the number
 * of results that were included. Pure / deterministic.
 */
export function formatMemoryContext(
	results: RecallResult[],
	tokenBudget: number,
): { text: string; used: number; included: number } {
	// Sort by rerankScore DESC (cross-encoder rerank is the new ranking
	// authority — recall-precision R3 / D5), with `rrf` DESC as the tie-breaker
	// for hits that don't carry a rerankScore. The `-1` sentinel for undefined
	// rerankScore ensures any real score (including 0) sorts BEFORE an absent
	// one, so legacy call sites that skip the rerank stage still compile and
	// their hits group at the tail of the output.
	// Copy first so we never mutate the caller's array.
	const sorted = [...results].sort((a, b) => {
		const ar = a.rerankScore ?? -1;
		const br = b.rerankScore ?? -1;
		if (ar !== br) return br - ar;
		return (b.rrf ?? 0) - (a.rrf ?? 0);
	});

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
