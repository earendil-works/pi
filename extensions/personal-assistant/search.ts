// recallAtoms — pure dense cosine KNN retrieval over the memory index.
//
// Architecture (migrated from hybrid dense + BM25 + RRF to pure dense):
//   - One channel: sqlite-vec KNN (dense) gated by a cosine floor. The
//     RRF-fusion layer and the FTS5 BM25 channel are gone — recall is
//     discovery-only via embedding similarity. Per-type fan-out in
//     `Promise.all` so the structural parallelism is explicit even though
//     the underlying calls are currently synchronous (better-sqlite3).
//   - Per-type top-3 with round-robin interleaving (Decision 2). Sparse
//     types automatically degrade below 3 — never pad with cross-type or
//     placeholder items. The hard cap is `DEFAULT_TOP_K` results per type,
//     so even an unbounded `topK` request returns at most 9 items.
//   - Per-type scoring: `score = cosine × (1 + 0.3 × strength + 0.2 ×
//     importance) + wTag × tagOverlap + wFreshness × freshness` — the
//     multiplicative anchor is kept verbatim from the dense-only era for
//     back-compat (Decision 8). Cosine is the multiplicative anchor;
//     strength/importance contribute a continuous boost. The two additive
//     terms (tagOverlap, freshness) are tuning signals — they boost
//     recall for keyword-rescue (tags) and recency bias (freshness) but
//     do NOT override the multiplicative anchor (cosine=0 still yields
//     score=0 since the additive terms cap at +0.15 at the default
//     weights). Weights are configurable per-call via
//     `RecallOptions.tagOverlapWeight` / `RecallOptions.freshnessWeight`
//     (defaults 0.10 / 0.05); at runtime these are wired from
//     `PersonalAssistantConfig.memory.tagOverlapWeight` /
//     `.freshnessWeight`.
//   - Default dense cosine floor = 0.7. Empirically tuned against bge-m3
//     on Chinese-Chinese pairs: the dense noise floor sits at ~0.55, so
//     0.7 cleanly separates signal from noise. Overridable per-call via
//     `RecallOptions.threshold` for hermetic tests that use a weaker
//     mock embedder. This is the single relevance gate — the legacy
//     fused-RRF recall threshold is gone in the pure-dense era.
//   - embedText null → dense channel collapses to [] (graceful degradation
//     per principle "召回对单 channel 降级鲁棒"). Empty / whitespace-only
//     query short-circuits to [] before the embed call so a missing
//     ollama roundtrip doesn't burn the timeout window on a no-op.
//   - Search is DISCOVERY ONLY. Does NOT bump `access_count` — strength
//     feedback is recorded exclusively by the agent's `memory_get` tool
//     (R-search-cheap, R-feedback-loop). Results carry `atom.id` plus the
//     metadata fields `distance` / `cosine` / `score`; the agent fetches
//     full content on demand by calling `memory_get(atom.id)`.

import { embedText } from "./embed.ts";
import { computeScore } from "./scoring.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, MemoryAtomType, RecallResult } from "./types.ts";

/** Per-type recall cap. Hard ceiling on the per-type top list (Decision 2). */
const DEFAULT_TOP_K = 3;

/**
 * Default minimum cosine similarity for the DENSE channel (post-filter).
 * Overridable per-call via `RecallOptions.threshold` for hermetic tests
 * that use a weaker mock embedder. See file header for the empirical
 * rationale behind 0.7 vs bge-m3's noise floor. This is the single
 * relevance gate in the pure-dense era.
 */
const DEFAULT_DENSE_COSINE_FLOOR = 0.7;

/** All canonical atom types — the three groups for per-type KNN. */
const TYPES: readonly MemoryAtomType[] = ["rule", "fact", "process"];

/**
 * Options for `recallAtoms`. `topK` controls the per-type KNN candidate
 * count (default 20 — the candidate pool BEFORE the cosine floor +
 * scoring; the per-type result cap is hard-coded at `DEFAULT_TOP_K = 3`).
 * `threshold` is the dense-channel cosine floor (default 0.7). `filter`
 * narrows the search to a single atom type. `tagOverlapWeight` /
 * `freshnessWeight` / `tagAliases` are the score-formula tuning knobs
 * wired from `PersonalAssistantConfig.memory` at the call site.
 */
export interface RecallOptions {
	/** Per-type KNN candidate count. Default 20 — the candidate pool
	 *  before scoring; the actual per-type result cap is fixed at
	 *  `DEFAULT_TOP_K = 3`. */
	topK?: number;
	/** Minimum cosine similarity for the DENSE channel (post-filter).
	 *  Default 0.7. */
	threshold?: number;
	/** Restrict KNN to a single atom type. */
	filter?: { type?: MemoryAtom["type"] };
	/** Override the additive weight of `tagOverlap` in the score formula.
	 *  Default 0.10 — the multiplicative anchor (`cosine × (1 + 0.3strength
	 *  + 0.2importance)`) is unaffected. Read from
	 *  `PersonalAssistantConfig.memory.tagOverlapWeight` at the call site. */
	tagOverlapWeight?: number;
	/** Override the additive weight of `freshness` in the score formula.
	 *  Default 0.05 — the multiplicative anchor is unaffected. Read from
	 *  `PersonalAssistantConfig.memory.freshnessWeight` at the call site. */
	freshnessWeight?: number;
	/** Tag alias map applied to the QUERY side during `computeTagOverlap`.
	 *  Lets a CJK query token (`"代码规范"`) fold to the canonical tag the
	 *  atom was indexed with (`"code-style"`). Atom-side aliasing happens
	 *  at write time via `normalizeTags`; this option lets callers pass
	 *  the same alias map to recall. Mirrors `PersonalAssistantConfig.
	 *  memory.tagAliases`. */
	tagAliases?: Record<string, string> | null;
}

/**
 * Per-type pure-dense recall for a single query. Each of the three
 * canonical types runs its own vector KNN, applies the cosine floor,
 * computes the score formula, caps to `DEFAULT_TOP_K`, then the per-type
 * lists are interleaved round-robin.
 *
 * One channel, one failure mode:
 *   - `embedText` returns null (ollama down): the dense channel collapses
 *     to `[]` and we return `[]`. Single-channel graceful degradation per
 *     principle "召回对单 channel 降级鲁棒".
 *
 * Results carry `atom.id` plus `distance` / `cosine` / `score` (kept
 * verbatim from the dense-only era) AND the optional `tagOverlap` /
 * `freshness` debug surfaces from `computeScore`. `score = cosine × (1 +
 * 0.3 × strength + 0.2 × importance) + 0.10 × tagOverlap + 0.05 ×
 * freshness` — the multiplicative anchor remains the back-compat invariant
 * for the `memory_get` tool and any UI that reads `score`; the additive
 * terms contribute small boosts (≤ 0.15) for tag-match and recency.
 *
 * Search does NOT bump `access_count` — strength feedback is recorded
 * exclusively by the agent's `memory_get` tool.
 */
async function recallAtomsSingleSegment(
	index: MemoryIndex,
	query: string,
	options: RecallOptions,
): Promise<RecallResult[]> {
	const cosineFloor = options.threshold ?? DEFAULT_DENSE_COSINE_FLOOR;
	const wTag = options.tagOverlapWeight ?? 0.10;
	const wFreshness = options.freshnessWeight ?? 0.05;
	const tagAliases = options.tagAliases;

	// Embed query for the dense channel. null means ollama is down —
	// the dense channel collapses to [] and we return [].
	const queryEmbedding = await embedText(query);
	if (!queryEmbedding) return [];

	// If a single type is requested, restrict the per-type search to that one.
	// Otherwise fan out across all three canonical types (Decision 2).
	const typesToSearch: readonly MemoryAtomType[] = options.filter?.type
		? [options.filter.type]
		: TYPES;

	// Per-type KNN candidate count. The post-scoring cap is hard-coded at
	// `DEFAULT_TOP_K` per type, so even an unbounded `topK` request returns
	// at most 9 items.
	const topK = options.topK ?? 20;

	// Per-type fan-out: dense KNN in parallel for each type, apply the
	// cosine floor, compute score, cap. Promise.all wires the (currently
	// synchronous) per-type work through a uniform async seam so a future
	// async sqlite driver can drop in without rewriting this site.
	const perTypeResults: RecallResult[][] = await Promise.all(
		typesToSearch.map(async (type): Promise<RecallResult[]> => {
			const hits = index.vectorSearch(queryEmbedding, topK, {
				type,
				isLatestOnly: true,
				archived: false,
			});

			const scored: RecallResult[] = [];
			for (const h of hits) {
				// L2 → cosine, valid only when both vectors are L2-normalised
				// (bge-m3 outputs are, by construction).
				const cosine = 1 - (h.distance * h.distance) / 2;

				// Apply the dense cosine floor — the single relevance gate in
				// the pure-dense era. Atoms below the floor do NOT surface.
				if (cosine < cosineFloor) continue;

				const atom = index.getAtom(h.id);
				if (!atom) continue;

				const scoredAtom = computeScore(cosine, atom, query, {
					tagOverlapWeight: wTag,
					freshnessWeight: wFreshness,
					tagAliases,
				});
				scored.push({
					atom,
					distance: h.distance,
					cosine,
					score: scoredAtom.score,
					tagOverlap: scoredAtom.tagOverlap,
					freshness: scoredAtom.freshness,
				});
			}

			// Sort by score DESC; hard per-type cap (Decision 2).
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, DEFAULT_TOP_K);
		}),
	);

	// Round-robin interleave: type[0], type[1], type[2], type[0], type[1], ...
	// Sparse lists (length < DEFAULT_TOP_K) skip their slot — never pad with
	// cross-type items or placeholders (Decision 2). The loop bound is the
	// per-type cap × type count (= 9: 3 types × 3 per-type cap), independent
	// of `topK`. `topK` only bounds how many KNN candidates each channel
	// pulls; the actual result-list size is fixed at 9 by the per-type cap.
	const results: RecallResult[] = [];
	const slotCount = TYPES.length * DEFAULT_TOP_K;
	for (let i = 0; i < slotCount; i++) {
		for (const list of perTypeResults) {
			const item = list[i];
			if (item) results.push(item);
		}
	}
	return results;
}

/**
 * Pure-dense recall entry point. Empty / whitespace-only queries
 * short-circuit to `[]` (so a missing ollama roundtrip is never burned on
 * a no-op). Otherwise the query is embedded once, the per-type dense
 * KNN runs in parallel, and the per-type top-3 lists are interleaved
 * round-robin.
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	if (!query || query.trim().length === 0) return [];
	return recallAtomsSingleSegment(index, query, options);
}
