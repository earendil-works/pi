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
	const serviceUrl = options.serviceUrl ?? DEFAULT_SERVICE_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	if (hits.length === 0) return [];

	try {
		const { buildEmbeddableText } = await import("./embed.ts");
		const rerankHits = hits.map((h) => ({
			id: h.atom.id,
			embeddable_text: buildEmbeddableText(h.atom),
		}));

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(`${serviceUrl}/api/rerank`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, hits: rerankHits }),
			signal: controller.signal,
		});
		clearTimeout(timer);

		if (!res.ok) {
			return { reason: "http-error" as RerankFallbackReason, topK: hits.slice(0, 3) };
		}

		const data = (await res.json()) as { scores?: Array<{ id: string; score: number }> };
		if (!data.scores || data.scores.length !== hits.length) {
			return { reason: "shape-mismatch" as RerankFallbackReason, topK: hits.slice(0, 3) };
		}
		// Apply scores to hits
		for (const s of data.scores) {
			const hit = hits.find((h) => h.atom.id === s.id);
			if (hit) hit.rerankScore = s.score;
		}

		const thr = options.threshold ?? DEFAULT_THRESHOLD;
		const gp = options.gap ?? DEFAULT_GAP;

		// Sort by rerankScore DESC, use rrf as tiebreaker
		const sorted = [...hits].sort((a, b) => {
			const as = a.rerankScore ?? -1;
			const bs = b.rerankScore ?? -1;
			if (as !== bs) return bs - as;
			return (b.rrf ?? 0) - (a.rrf ?? 0);
		});

		// Threshold filter
		const above = sorted.filter((h) => (h.rerankScore ?? -1) >= thr);
		if (above.length === 0) return [];

		// Gap detection: find first gap > gp
		let cutIndex = above.length - 1;
		for (let i = 0; i < above.length - 1; i++) {
			const as = above[i].rerankScore ?? 0;
			const bs = above[i + 1].rerankScore ?? 0;
			if (as - bs > gp) {
				cutIndex = i;
				break;
			}
		}
		return above.slice(0, cutIndex + 1);
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			return { reason: "timeout" as RerankFallbackReason, topK: hits.slice(0, 3) };
		}
		return { reason: "unreachable" as RerankFallbackReason, topK: hits.slice(0, 3) };
	}
}
