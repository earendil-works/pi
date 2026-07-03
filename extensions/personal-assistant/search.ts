// recallAtoms — pass-through to the bge-m3 dual-channel RRF service.
//
// The service at `http://127.0.0.1:11435/api/search` runs dual-channel
// (dense cosine + bge-m3 learned sparse) RRF retrieval server-side. The
// result is a pre-sorted list of `{id, title, type, rank, rrf,
// dense_cos, sparse_score}` filtered by `dense_floor` and `sparse_floor`.
// The server is the SOLE ranking authority — this module does not
// re-rank, re-sort, or re-score the hits. We only:
//
//   1. Hydrate the full atom from local sqlite (the service returns
//      id+title only; the LLM block needs `summary` + `type` + `tags`).
//   2. Propagate `rrf`, `dense_cos`, `sparse_score` into `RecallResult`
//      for `formatMemoryContext` to consume.
//
// Architecture notes:
//   - `dense_cos` and `sparse_score` are both surfaces of the service's
//     retrieval; the client never combines them. The service's RRF
//     fusion (k=60) is the only ranking signal exposed to the LLM.
//   - The default `dense_floor` is 0.55. Rationale: tightening the
//     floor past ~0.55 collapses the dense channel to 0 hits for short
//     queries (e.g. "之前修复的脚本是哪个" → all 7 candidates
//     rank-0 in sparse only, RRF ≈ 0.0167, no differentiation between
//     the actual relevant atom and the noise tier). At 0.55 the
//     top-2 hits reach rrf=0.0328 (rank-0 in BOTH channels) and the
//     tail drops to 0.0164, giving a clean gap. Sparse rescue still
//     works at 0.55 ("MGM" / "mgm 项目还记得吗" / "BLAST 验证引物").
//   - `hybridSearch` returns [] on any service failure. The agent
//     contract: no recall → "🔍 no memory match" in TUI, no injection
//     into LLM prompt. Same graceful-degradation principle as
//     `embedText` returning null.

import { hybridSearch } from "./hybrid-search.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, MemoryAtomType, RecallResult } from "./types.ts";

/**
 * Default minimum cosine similarity for the DENSE channel (post-filter
 * on the service side). The sparse channel is unaffected — keyword-rescue
 * queries (e.g. "MGM" with dense=0.42) still come through via the
 * learned sparse channel hitting the atom's tag/title tokens.
 *
 * Why 0.55 and not higher: the RRF fusion needs BOTH channels to
 * contribute in order to differentiate top hits from the noise tier.
 * At dense_floor > 0.55, short queries ("之前修复的脚本是哪个" with
 * max cosine 0.59) collapse to "dense channel = 0 hits, sparse
 * channel rank-0 for everyone" — all candidates end up at RRF ≈ 0.0167
 * with no meaningful gap to the actual relevant hit. Empirically 0.55
 * is the floor below which top-2 results clear the dense channel and
 * the gap to the tail opens up.
 */
const DEFAULT_DENSE_COSINE_FLOOR = 0.55;

/**
 * Options for `recallAtoms`. `topK` bounds the total candidate count
 * pulled from the service (default 20 — the service then takes its own
 * top-10 internally). `filter` narrows the search to a single atom
 * type. `embeddingServiceUrl` overrides the service URL.
 *
 * No client-side re-ranking options exist — the server's RRF output is
 * the sole ranking signal.
 */
export interface RecallOptions {
	/** Total candidate count. Default 20. */
	topK?: number;
	/** Minimum cosine similarity for the DENSE channel (post-filter).
	 *  Default 0.55. The sparse channel's lexical floor (0.3) is set
	 *  server-side and not exposed per-call. */
	threshold?: number;
	/** Restrict the search to a single atom type. */
	filter?: { type?: MemoryAtom["type"] };
	/** Embedding service base URL (defaults to the FastAPI bge-m3 service
	 *  at 127.0.0.1:11435). */
	embeddingServiceUrl?: string;
}

/**
 * Single-segment RRF recall. Empty / whitespace-only queries short-circuit
 * to `[]` so a missing embedding service doesn't burn the timeout window
 * on a no-op. The query is sent to the embedding service once; the
 * returned hits are hydrated from local sqlite and the server's RRF order
 * is preserved verbatim.
 */
async function recallAtomsSingleSegment(
	index: MemoryIndex,
	query: string,
	options: RecallOptions,
): Promise<RecallResult[]> {
	const cosineFloor = options.threshold ?? DEFAULT_DENSE_COSINE_FLOOR;
	const topK = options.topK ?? 20;

	// Per-type fan-out (decision 2 — type filter on the server). The
	// service applies `dense ≥ cosineFloor` + `sparse ≥ 0.3` floors and
	// runs RRF fusion; we receive the pre-sorted hits.
	const t0 = performance.now();
	const typeFilter = options.filter?.type;
	const allHits = await hybridSearch(query, topK, {
		denseFloor: cosineFloor,
		embeddingServiceUrl: options.embeddingServiceUrl,
		type: typeFilter,
	});
	const elapsed = (performance.now() - t0).toFixed(1);
	console.debug(`[hybrid] recallAtoms "${query}" -> ${allHits.length} candidates in ${elapsed}ms rtt`);
	if (allHits.length === 0) return [];

	// Hydrate and propagate service ranking verbatim.
	const results: RecallResult[] = [];
	for (const h of allHits) {
		const atom = index.getAtom(h.id);
		if (!atom) continue;
		results.push({
			atom,
			cosine: h.dense_cos,
			sparseScore: h.sparse_score,
			rrf: h.rrf,
		});
	}
	return results;
}

/**
 * Hybrid-RRF recall entry point. Empty / whitespace-only queries
 * short-circuit to `[]` (so a missing embedding service roundtrip is
 * never burned on a no-op). The query is sent to the embedding service
 * once and the server's RRF order is the final ranking.
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	if (!query || query.trim().length === 0) return [];
	return recallAtomsSingleSegment(index, query, options);
}

// Re-export so call sites can use the type without a separate import.
export type { MemoryAtom, MemoryAtomType, RecallResult };
