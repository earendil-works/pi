import type { RecallResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Rerank client (task 3.1 — skeleton).
//
// This module owns the HTTP client for the bge-reranker cross-encoder
// service at `serviceUrl` and the threshold/gap filter that converts a
// ranked score list into the final injected set.
//
// The body of `rerankAndFilter` is intentionally a placeholder returning
// `[]` at this stage. Tasks 3.2 and 3.3 fill it in:
//
//   3.2 — fetch + timeout + RerankFallback emission on the four failure
//         modes (timeout / http-error / shape-mismatch / unreachable).
//   3.3 — threshold (default 0.5) and gap (default 0.15) filter that
//         produces the `RecallResult[]` branch.
//
// Principle 9 (single home): this is the only module in the extension
// that talks to the rerank service. Callers (memory.ts / search.ts /
// format.ts) consume the union return and discriminate on `Array.isArray`
// (see task 5.2 for the orchestration wiring).
// ---------------------------------------------------------------------------

/**
 * Options for the rerank call. Every field is optional; defaults are
 * applied inside `rerankAndFilter` so callers can pass a partial object
 * without spelling out the values they don't care about.
 */
export interface RerankOptions {
	/** bge-reranker service base URL. Default: `http://127.0.0.1:11435`. */
	serviceUrl?: string;
	/** Per-call timeout enforced via AbortController. Default: 500ms. */
	timeoutMs?: number;
	/**
	 * Minimum cross-encoder score for a hit to survive filtering. Hits
	 * with `rerankScore < threshold` are dropped. Default: 0.5.
	 */
	threshold?: number;
	/**
	 * Minimum score gap between consecutive hits; a hit whose score is
	 * within `gap` of the previous one is dropped (low-confidence
	 * tail). Default: 0.15.
	 */
	gap?: number;
}

/** Failure categories emitted by the rerank client (design.md D7). */
export type RerankFallbackReason = "timeout" | "http-error" | "shape-mismatch" | "unreachable";

/**
 * Returned by `rerankAndFilter` when the rerank service is unavailable
 * or the response cannot be used. `topK` is the gate-passed RRF ranking
 * truncated to the original top-K so the caller can still inject something
 * rather than producing a no-memory-match status.
 */
export interface RerankFallback {
	reason: RerankFallbackReason;
	topK: RecallResult[];
}

const DEFAULT_SERVICE_URL = "http://127.0.0.1:11435";
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_GAP = 0.15;

/**
 * Rerank the candidate `hits` against `query` and return either the
 * filtered/sorted hits or a `RerankFallback`. The caller discriminates
 * the two branches with `Array.isArray(result)`.
 *
 * @param query  The user prompt (or its recall key) sent to the cross-encoder.
 * @param hits   Gate-passed RRF-ranked candidates from the hybrid search.
 * @param options  Optional overrides for serviceUrl / timeoutMs / threshold / gap.
 *
 * Body filled in by tasks 3.2 (server call + fallback) and 3.3
 * (threshold + gap). At this stage the function returns `[]` for any
 * input — the union return type is the only contract 3.1 establishes.
 */
export async function rerankAndFilter(
	query: string,
	hits: RecallResult[],
	options: RerankOptions = {},
): Promise<RecallResult[] | RerankFallback> {
	void query;
	void hits;
	void options;
	void DEFAULT_SERVICE_URL;
	void DEFAULT_TIMEOUT_MS;
	void DEFAULT_THRESHOLD;
	void DEFAULT_GAP;
	// 3.2 / 3.3 will replace this placeholder with the real implementation.
	return [];
}
