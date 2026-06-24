// recallAtoms — pure per-type KNN retrieval over the memory index.
//
// Architecture constraints (from design.md Decisions 2, 7, 8):
//   - Pure sqlite-vec KNN. NO FTS5 / keyword fallback. embedText returning null
//     means "ollama is down, collapse to []" (S41 / R39).
//   - Per-type top-3 with round-robin interleaving (Decision 2). Sparse types
//     automatically degrade below 3 — never pad with cross-type or placeholder
//     items. The hard cap is `DEFAULT_TOP_K` results per type, so even an
//     unbounded `topK` request returns at most 9 items.
//   - Per-type scoring: `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`.
//     Cosine is the multiplicative anchor; strength/importance contribute a
//     continuous boost on every comparison (R-search-rank). The formula's
//     multiplicative structure guarantees cosine is the absolute ranking key
//     — strength/importance cannot rescue an unrelated atom past a relevant
//     one, but they meaningfully reorder ties and near-ties.
//   - Default cosine threshold = 0.65 (filtered AFTER vectorSearch returns).
//     Empirically tuned against bge-m3 on Chinese-Chinese pairs: the dense
//     noise floor sits at ~0.55 (any pair of unrelated Chinese texts scores
//     ≥ 0.5), so a 0.5 threshold surfaces irrelevant atoms as recall hits.
//     0.65 cleanly separates signal from noise — verified against the live
//     corpus: truly-relevant matches land 0.74-0.81, irrelevant atoms stay
//     ≤ 0.55. 0.65 (not 0.7) keeps a comfortable margin over Float32-precision
//     noise (sqlite-vec L2 distance computation can produce cosines like
//     0.69999998 for an intended 0.7 boundary case). Pure-dense recall is
//     fundamentally limited (signal/noise gap is only ~0.1); the right
//     long-term fix is hybrid FTS5 + dense (tracked separately), but raising
//     this threshold is the cheap, immediate fix.
//   - Search is DISCOVERY ONLY. Does NOT bump `access_count` — strength
//     feedback is recorded exclusively by the agent's `memory_get` tool
//     (R-search-cheap, R-feedback-loop). Results carry `atom.id` plus the
//     metadata fields `distance` / `cosine` / `score`; the agent fetches
//     full content on demand by calling `memory_get(atom.id)`. We never
//     hydrate content at recall time — no L0/L1 split, no I/O cost beyond
//     the vector search itself.

import { embedText } from "./embed.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, MemoryAtomType, RecallResult } from "./types.ts";

/** Per-type recall cap. Hard ceiling on the per-type top list (Decision 2). */
const DEFAULT_TOP_K = 3;

/** Default minimum cosine similarity (post-filter). Overridable per-call via
 *  `RecallOptions.threshold` for hermetic tests that use a weaker mock embedder.
 *  See file header for the empirical rationale behind 0.65 vs bge-m3's noise floor. */
const DEFAULT_THRESHOLD = 0.65;

/** Multiplicative boost weights for the score formula (Decision 8). */
const STRENGTH_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

/** All canonical atom types — the three groups for per-type KNN. */
const TYPES: readonly MemoryAtomType[] = ["rule", "fact", "process"];

/**
 * Reciprocal Rank Fusion — fuse two rank lists (dense KNN + BM25) into a
 * single ranked list. Pure function: only the array ORDER of the inputs
 * matters; raw cosine / BM25 scores are discarded (the principle is
 * "召回融合默认走 RRF,不归一化 BM25 与 cosine,只取 rank 加权").
 *
 * Contribution per rank: `1 / (rrfK + rank + 1)`. Code uses 0-indexed rank
 * (rank=0 → `1/(rrfK+1)`), which matches RRF literature's 1-indexed
 * convention (rank=1 → `1/(rrfK+1)`). Same id appearing in both channels
 * gets BOTH contributions summed, so a double-channel hit always outranks
 * a single-channel hit at the same rank position (design.md Decision 2).
 *
 * `rrfK` is the smoothing constant. Industry default 60 (Elasticsearch /
 * OpenSearch / Qdrant). Same value is used for both channels; the function
 * itself does not hardcode it — the caller passes whatever knob the config
 * exposes.
 *
 * @param denseRanks Ranked dense-channel results (only `id` and order).
 * @param bm25Ranks  Ranked BM25-channel results (only `id` and order).
 * @param rrfK       Smoothing constant (typical: 60).
 * @returns          `Array<{id, rrfScore}>` sorted by `rrfScore` DESC.
 */
export function rrfFuse(
	denseRanks: Array<{ id: string }>,
	bm25Ranks: Array<{ id: string }>,
	rrfK: number,
): Array<{ id: string; rrfScore: number }> {
	const map = new Map<string, number>();
	for (let rank = 0; rank < denseRanks.length; rank++) {
		const id = denseRanks[rank].id;
		map.set(id, (map.get(id) ?? 0) + 1 / (rrfK + rank + 1));
	}
	for (let rank = 0; rank < bm25Ranks.length; rank++) {
		const id = bm25Ranks[rank].id;
		map.set(id, (map.get(id) ?? 0) + 1 / (rrfK + rank + 1));
	}
	return [...map.entries()]
		.map(([id, rrfScore]) => ({ id, rrfScore }))
		.sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Options for `recallAtoms`. `topK` controls the per-type KNN candidate
 * count (default 3, Decision 2). The per-type result cap is fixed at 3
 * (Decision 2 hard ceiling — sparse types degrade below this). `threshold`
 * is the cosine minimum (default 0.65, Decision 8); hermetic tests with
 * weaker mock embedders can dial it down. `filter` narrows the search to
 * a single atom type.
 */
export interface RecallOptions {
	/** Per-type KNN candidate count (Decision 2). Default 3. */
	topK?: number;
	/** Minimum cosine similarity (post-filter). Default 0.65 (Decision 8). */
	threshold?: number;
	/** Restrict KNN to a single atom type. */
	filter?: { type?: MemoryAtom["type"] };
}

/**
 * Per-type KNN recall: 3 independent `vectorSearch` calls (one per atom
 * type), each capped at `DEFAULT_TOP_K` results by the multiplicative score
 * `cosine × (1 + 0.3 × strength + 0.2 × importance)`. Per-type lists are
 * sorted by `score` descending, then interleaved round-robin so each type
 * gets a turn in the final result list (sparse types skip their slot).
 *
 * Returns `[]` when `embedText` returns null (ollama unreachable). No FTS or
 * keyword fallback — the caller must treat an empty array as "no memory
 * context for this prompt" (R39 / S41).
 *
 * Search does NOT bump `access_count` — strength feedback is recorded
 * exclusively by the agent's `memory_get` tool. Results therefore carry
 * `atom.id` (and the metadata fields `distance` / `cosine` / `score`),
 * not `file_path`.
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	// Embed query — null means ollama is down. No fallback per Decision 7.
	const queryEmbedding = await embedText(query);
	if (!queryEmbedding) return [];

	// If a single type is requested, restrict the per-type search to that one.
	// Otherwise fan out across all three canonical types (Decision 2).
	const typesToSearch: readonly MemoryAtomType[] = options.filter?.type
		? [options.filter.type]
		: TYPES;

	// Per-type KNN, scored and capped. Promise.all wires the (currently
	// synchronous) vectorSearch calls through a uniform async seam so a
	// future async sqlite driver can drop in without rewriting this site
	// (the per-type fan-out stays structurally parallel).
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const topK = options.topK ?? DEFAULT_TOP_K;
	const perTypeResults: RecallResult[][] = await Promise.all(
		typesToSearch.map((type) => {
			const raw = index.vectorSearch(queryEmbedding, topK, {
				type,
				isLatestOnly: true,
				archived: false,
			});
			const scored: RecallResult[] = [];
			for (const { id, distance } of raw) {
				const atom = index.getAtom(id);
				if (!atom) continue;
				// L2 → cosine, valid only when both vectors are L2-normalised
				// (bge-m3 outputs are, by construction).
				const cosine = 1 - (distance * distance) / 2;
				if (cosine < threshold) continue;
				const score =
					cosine *
					(1 + STRENGTH_WEIGHT * atom.strength + IMPORTANCE_WEIGHT * atom.importance);
				scored.push({ atom, distance, cosine, score });
			}
			scored.sort((a, b) => b.score - a.score); // score DESC within type
			return scored.slice(0, DEFAULT_TOP_K);
		}),
	);

	// Round-robin interleave: type[0], type[1], type[2], type[0], type[1], ...
	// Sparse lists (length < topK) skip their slot — never pad with
	// cross-type items or placeholders (Decision 2).
	const results: RecallResult[] = [];
	for (let i = 0; i < topK; i++) {
		for (const list of perTypeResults) {
			const item = list[i];
			if (item) results.push(item);
		}
	}
	return results;
}
