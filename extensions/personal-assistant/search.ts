// recallAtoms — hybrid dense + BM25 retrieval over the memory index.
//
// Architecture constraints (from design.md Decisions 2, 4, 7, 8):
//   - Two channels: sqlite-vec KNN (dense) + FTS5 BM25 (keyword). Each
//     channel runs per-type with `topK` candidates (default 20). Per-type
//     fan-out in `Promise.all` so the structural parallelism is explicit
//     even though the underlying calls are currently synchronous
//     (better-sqlite3).
//   - Reciprocal Rank Fusion: same id appearing in both channels gets
//     BOTH contributions summed (`1/(rrfK + rank + 1)` per channel). Double-
//     channel hits therefore always outrank single-channel hits at the same
//     rank position. RRF uses rank only — raw cosine / BM25 scores are
//     discarded (principle "召回融合默认走 RRF,不归一化 BM25 与 cosine,只取
//     rank 加权").
//   - Per-type top-3 with round-robin interleaving (Decision 2). Sparse
//     types automatically degrade below 3 — never pad with cross-type or
//     placeholder items. The hard cap is `DEFAULT_TOP_K` results per type,
//     so even an unbounded `topK` request returns at most 9 items.
//   - Per-type scoring: `score = cosine × (1 + 0.3 × strength + 0.2 ×
//     importance)` — kept verbatim from the dense-only era for back-compat
//     (Decision 8). Cosine is the multiplicative anchor; strength/importance
//     contribute a continuous boost. For BM25-only hits (no dense signal)
//     `cosine = 0` and `score = 0`, which is the right semantics: the
//     multiplicative anchor correctly says "no dense evidence, no boosted
//     score".
//   - Default cosine threshold = 0.65 (the "dense-channel cosine floor"
//     kept for back-compat). Empirically tuned against bge-m3 on
//     Chinese-Chinese pairs: the dense noise floor sits at ~0.55, so 0.65
//     cleanly separates signal from noise. The NEW fused-RRF threshold
//     (`recallThreshold`) is the recall gate — see below.
//   - `recallThreshold = 1 / rrfK` ≈ 0.01667 by default. This is the
//     "宁可漏召不可误召" conservative stance — a single-channel rank=1
//     contribution is `1/(rrfK+0+1) = 1/(rrfK+1)` ≈ 0.01639 which does
//     NOT clear the filter. To pass, an atom needs either double-channel
//     coverage (BM25 + dense at any ranks) or single-channel at rank=0
//     PLUS another channel at rank ≤ ~3. The user's lefse case (dense
//     cosine 0.55, BM25 0 hit) yields rrfScore 0.01639 < 0.01667 and is
//     correctly filtered out. Users who want single-channel rescue (test
//     / dev mode, or "X101SC26052587" project-ID scenario) can opt in via
//     `recallThreshold: 0` to disable the gate entirely.
//   - embedText null → dense channel collapses to [] (graceful degradation).
//     BM25 still runs because it does not depend on the embedder. The
//     legacy "ollama down → return [] entirely" behavior is dropped in
//     favour of single-channel operation per principle "召回对单 channel
//     降级鲁棒".
//   - Search is DISCOVERY ONLY. Does NOT bump `access_count` — strength
//     feedback is recorded exclusively by the agent's `memory_get` tool
//     (R-search-cheap, R-feedback-loop). Results carry `atom.id` plus the
//     metadata fields `distance` / `cosine` / `score` / `rrfScore`; the
//     agent fetches full content on demand by calling `memory_get(atom.id)`.

import { embedText } from "./embed.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, MemoryAtomType, RecallResult } from "./types.ts";

/** Per-type recall cap. Hard ceiling on the per-type top list (Decision 2). */
const DEFAULT_TOP_K = 3;

/** Default minimum cosine similarity for the DENSE channel (post-filter).
 *  Overridable per-call via `RecallOptions.threshold` for hermetic tests
 *  that use a weaker mock embedder. See file header for the empirical
 *  rationale behind 0.65 vs bge-m3's noise floor. Note: this is the
 *  dense-ONLY floor — it filters cosine hits from the dense channel before
 *  RRF fusion. The fused-recall gate is `recallThreshold` below. */
const DEFAULT_THRESHOLD = 0.65;

/** Multiplicative boost weights for the score formula (Decision 8). */
const STRENGTH_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

/** All canonical atom types — the three groups for per-type KNN. */
const TYPES: readonly MemoryAtomType[] = ["rule", "fact", "process"];

/** Smoothing constant for RRF (Decision 2). Industry default 60
 *  (Elasticsearch / OpenSearch / Qdrant). Same value for both channels. */
const DEFAULT_RRF_K = 60;

/** Default fused-RRF score floor for recall (the "recall gate").
 *  Set to `1/DEFAULT_RRF_K` so a single-channel top-rank contribution
 *  (`1/(rrfK + 0 + 1)` = `1/(rrfK+1)`) does NOT clear the filter. This is
 *  the design's "宁可漏召不可误召" conservative stance — a single dense
 *  cosine (no BM25 support) cannot pass, solving the bge-m3 noise-floor
 *  false-positive class. The user's lefse case (cosine 0.55, BM25 0 hit)
 *  yields rrfScore 0.01639 < 0.01667 → correctly filtered out. */
const DEFAULT_RECALL_THRESHOLD = 1 / DEFAULT_RRF_K;

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
 * count (default 20 — the candidate pool BEFORE RRF fusion; the per-type
 * fused-result cap is hard-coded at `DEFAULT_TOP_K = 3`). The legacy
 * `threshold` is the dense-channel cosine floor (default 0.65, Decision 8);
 * hermetic tests with weaker mock embedders can dial it down. `rrfK` and
 * `recallThreshold` expose the RRF fusion knobs (the latter is the
 * strict default `1/rrfK` gate — see `DEFAULT_RECALL_THRESHOLD` for the
 * design trade-off). `filter` narrows the search to a single atom type.
 */
export interface RecallOptions {
	/** Per-type KNN candidate count (per channel). Default 20 — the
	 *  candidate pool before RRF fusion; the actual per-type result cap
	 *  is fixed at `DEFAULT_TOP_K = 3`. */
	topK?: number;
	/** Minimum cosine similarity for the DENSE channel (post-filter).
	 *  Default 0.65 (Decision 8). Renamed semantically — this is the
	 *  dense-ONLY floor, not the fused-recall gate. */
	threshold?: number;
	/** RRF smoothing constant. Default 60 (industry standard — Elasticsearch
	 *  / OpenSearch / Qdrant). Same value used for both dense and BM25
	 *  channels. Lower values weight top ranks more aggressively; higher
	 *  values smooth the distribution. Changing this affects all rankings. */
	rrfK?: number;
	/** Fused-RRF score gate. Default `1 / rrfK` (≈ 0.01667 with rrfK=60).
	 *  Atoms whose fused rrfScore is below this are dropped. The strict
	 *  default rejects single-channel rank=1 contributions (0.01639) —
	 *  the design's "宁可漏召不可误召" stance. Set to `0` to disable the
	 *  gate entirely (single-channel BM25-only / dense-only rescue). */
	recallThreshold?: number;
	/** Restrict KNN to a single atom type. */
	filter?: { type?: MemoryAtom["type"] };
}

/**
 * Hybrid per-type recall: for each atom type, run `vectorSearch` and
 * `bm25Search` in parallel (top-K candidates each), fuse via RRF, filter
 * by `recallThreshold`, then slice to `DEFAULT_TOP_K` per type. Per-type
 * lists are interleaved round-robin so each type gets a turn in the final
 * result list (sparse types skip their slot).
 *
 * Two channels, two failure modes:
 *   - `embedText` returns null (ollama down): dense channel collapses to
 *     `[]`; BM25 still runs and surfaces BM25-only hits. Single-channel
 *     graceful degradation per principle "召回对单 channel 降级鲁棒".
 *   - BM25 query empty (e.g. all FTS5-special chars): bm25Search short-
 *     circuits to `[]` inside storage.ts; dense still runs.
 *
 * Results carry `atom.id` plus `distance` / `cosine` / `score` (kept
 * verbatim from the dense-only era) AND the new `rrfScore` field
 * populated from the fused-RRF map. `score = cosine × (1 + 0.3 × strength
 * + 0.2 × importance)` remains the multiplicative anchor for back-compat
 * with the agent's `memory_get` tool and any UI that reads `score`.
 *
 * Search does NOT bump `access_count` — strength feedback is recorded
 * exclusively by the agent's `memory_get` tool.
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	const rrfK = options.rrfK ?? DEFAULT_RRF_K;
	const recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;
	const cosineFloor = options.threshold ?? DEFAULT_THRESHOLD;

	// Embed query for the dense channel. null means ollama is down —
	// dense channel collapses to [] but BM25 still runs (graceful
	// degradation, see file header).
	const queryEmbedding = await embedText(query);

	// If a single type is requested, restrict the per-type search to that one.
	// Otherwise fan out across all three canonical types (Decision 2).
	const typesToSearch: readonly MemoryAtomType[] = options.filter?.type
		? [options.filter.type]
		: TYPES;

	// Per-type KNN candidate count (per channel). Bumped from 3 (dense-only
	// era) to 20 because RRF fusion needs a wider candidate pool — the top-3
	// per-type cap is preserved by the post-fusion `slice(0, DEFAULT_TOP_K)`.
	const topK = options.topK ?? 20;

	// Per-type fan-out: dense + BM25 in parallel for each type, fuse, filter,
	// cap. Promise.all wires the (currently synchronous) per-type work through
	// a uniform async seam so a future async sqlite driver can drop in
	// without rewriting this site.
	const perTypeResults: RecallResult[][] = await Promise.all(
		typesToSearch.map(async (type): Promise<RecallResult[]> => {
			// Dense channel: skip when embedText returned null. We still
			// want the per-type fan-out shape so the BM25 channel runs for
			// every type even with no dense signal.
			const densePromise: Promise<Array<{ id: string; distance: number }>> = queryEmbedding
				? Promise.resolve(
						index.vectorSearch(queryEmbedding, topK, {
							type,
							isLatestOnly: true,
							archived: false,
						}),
					)
				: Promise.resolve([]);

			// BM25 channel: always runs (does not depend on embedder).
			const bm25Promise: Promise<Array<{ id: string; bm25: number }>> = Promise.resolve(
				index.bm25Search(query, topK, {
					type,
					isLatestOnly: true,
					archived: false,
				}),
			);

			const [denseHits, bm25Hits] = await Promise.all([densePromise, bm25Promise]);

			// Apply the dense-ONLY cosine floor (back-compat): filter the
			// dense channel to atoms whose cosine clears the floor. Atoms
			// below the floor do NOT contribute to the dense RRF channel —
			// they may still surface via BM25 only, but their dense cosine
			// is treated as "absent" by the fusion. The floor is meaningful
			// only as a "drop dense contribution" filter, not a "drop the
			// whole atom" filter — that is `recallThreshold`'s job.
			const filteredDenseHits = denseHits.filter((d) => {
				const c = 1 - (d.distance * d.distance) / 2;
				return c >= cosineFloor;
			});

			// RRF fusion — only the array order matters; raw scores are dropped.
			const fused = rrfFuse(filteredDenseHits, bm25Hits, rrfK);

			// Apply the recall threshold (the fused-RRF score gate). Atoms
			// below threshold do NOT surface in the per-type list.
			const passing = fused.filter((f) => f.rrfScore >= recallThreshold);

			// Hydrate each passing id, compute cosine/score for back-compat,
			// and attach the fused rrfScore. rrfFuse already returns DESC by
			// rrfScore; we re-sort defensively in case of ties on dense rank.
			const scored: RecallResult[] = [];
			for (const f of passing) {
				const atom = index.getAtom(f.id);
				if (!atom) continue;

				// Look up the dense distance for this id (if present) so we
				// can compute the cosine/score fields. The dense hits here
				// are post-floor (see `filteredDenseHits` above), so any hit
				// is by construction above the cosine floor. BM25-only hits
				// have no dense hit → cosine = 0, score = 0 (multiplicative
				// anchor correctly says "no dense evidence").
				const denseHit = filteredDenseHits.find((d) => d.id === f.id);
				let distance = 0;
				let cosine = 0;
				if (denseHit) {
					distance = denseHit.distance;
					// L2 → cosine, valid only when both vectors are L2-normalised
					// (bge-m3 outputs are, by construction).
					cosine = 1 - (distance * distance) / 2;
				}

				const score =
					cosine *
					(1 + STRENGTH_WEIGHT * atom.strength + IMPORTANCE_WEIGHT * atom.importance);
				scored.push({ atom, distance, cosine, score, rrfScore: f.rrfScore });
			}
			// rrfFuse already returned DESC; the post-filter sort keeps ties
			// stable and re-asserts the invariant.
			scored.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));
			// Hard per-type cap (Decision 2).
			return scored.slice(0, DEFAULT_TOP_K);
		}),
	);

	// Round-robin interleave: type[0], type[1], type[2], type[0], type[1], ...
	// Sparse lists (length < DEFAULT_TOP_K) skip their slot — never pad with
	// cross-type items or placeholders (Decision 2). The loop bound is the
	// per-type cap × type count (= 9: 3 types × 3 per-type cap), independent
	// of `topK`. The previous `Math.min(topK, 9)` conflated per-channel
	// candidate count (topK) with the result-list size — `topK` only bounds
	// how many dense/BM25 candidates we ask each channel for; the actual
	// result-list size is fixed at 9 by the per-type cap.
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
