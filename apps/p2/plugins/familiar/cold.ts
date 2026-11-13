// When the Familiar compacts: only once its prompt cache has gone cold and its context is large. While the cache is
// warm a turn reads the context at about a tenth of the input price, and a summary (never cached) costs the whole
// context at full price; once cold, the next turn rewrites the cache at full price or more anyway, so compacting first
// costs about the same and makes every later turn cheaper.
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ContextView } from "@earendil-works/pi-durable";

/** Context size from which a cold Familiar compacts, unless the model's regular cutoff is lower. */
export const COLD_COMPACT_TOKENS = 150_000;

/** The context size from which a cold Familiar compacts: 150k, or the regular compaction cutoff when that is lower. */
export function coldThreshold(contextWindow: number, reserveTokens: number): number {
	return Math.min(COLD_COMPACT_TOKENS, contextWindow - reserveTokens);
}

/**
 * When the prompt cache of an answer given at `answeredAt` is expected to be gone: the cache lifetime after it, and
 * after the at most 30 minutes the cache warmer keeps refreshing it while idle (`warmingMs`, 0 without warming).
 */
export function coldAt(answeredAt: number, ttlMs: number, warmingMs: number): number {
	return answeredAt + warmingMs + ttlMs;
}

/**
 * The newest answer after the context's head (a compaction or reset), with the context size it reported; undefined
 * when there is none, e.g. right after a compaction: then there is nothing to compact again.
 */
export function lastAnswer(view: ContextView): { message: AssistantMessage; tokens: number } | undefined {
	const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
	for (let index = view.entries.length - 1; index >= 0; index--) {
		if (view.entries[index]!.id <= after) return undefined;
		const message = view.contributions[index]!.findLast(
			(each): each is AssistantMessage => each.role === "assistant" && contextTokens(each.usage) > 0,
		);
		if (message) return { message, tokens: contextTokens(message.usage) };
	}
	return undefined;
}

/** The context size a response reports, as pi-ai's `calculateContextTokens` (a module plugins cannot import). */
function contextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
