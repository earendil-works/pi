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
//     `.freshnessWeight`. For BM25-only hits (no dense signal)
//     `cosine = 0` and the multiplicative term is 0, so `score =
//     wTag × tagOverlap + wFreshness × freshness` — keyword-rescue hits
//     can still rank by tag/freshness alone, which is the right
//     semantics: keyword relevance compensates for the missing dense
//     evidence, gated by how recently the atom was written.
//   - Default cosine threshold = 0.65 (the "dense-channel cosine floor"
//     kept for back-compat). Empirically tuned against bge-m3 on
//     Chinese-Chinese pairs: the dense noise floor sits at ~0.55, so 0.65
//     cleanly separates signal from noise. The NEW fused-RRF threshold
//     (`recallThreshold`) is the recall gate — see below.
//   - `recallThreshold = 1 / (rrfK + 1)` ≈ 0.01639 by default. This is
//     the industry-standard RRF rank-only stance (Elasticsearch / OpenSearch
//     / Qdrant / Milvus all use rank without an absolute score filter):
//     a single-channel rank=0 contribution equals the threshold and passes
//     (`1/(rrfK+0+1) = 1/(rrfK+1)`). Rank=1+ contributions are filtered
//     (`1/(rrfK+2) ≈ 0.01613 < 0.01639`). To pass, an atom needs either
//     double-channel coverage (BM25 + dense at any ranks) OR single-channel
//     rank=0. The MGM-style keyword-only rescue ("MGM 项目还记得吗") relies
//     on single-channel BM25 rank=0 clearing the gate. The user's lefse
//     case (dense cosine 0.55, BM25 0 hit) is NOT filtered by the recall
//     gate — it's filtered by the COSINE FLOOR (0.65) which drops the 0.55
//     cosine atom from the dense channel before RRF fusion. Users who want
//     the strict "宁可漏召不可误召" conservative stance (single-channel
//     rank=0 must NOT pass) can opt in via `recallThreshold: 1 / rrfK`
//     (≈ 0.01667) which strictly exceeds the rank=0 contribution; or
//     `recallThreshold: 0` to disable the gate entirely (test / dev mode).
//   - embedText null → dense channel collapses to [] (graceful degradation).
//     BM25 still runs because it does not depend on the embedder. The
//     legacy "ollama down → return [] entirely" behavior is dropped in
//     favour of single-channel operation per principle "召回对单 channel
//     降级鲁棒".
//   - Multi-segment query splitting: a query like "mgm工时计算" is split
//     into ASCII/CJK-homogeneous segments (`["mgm", "工时计算"]`) at
//     whitespace AND ASCII↔CJK boundaries. Each segment is recalled
//     independently (its own embedding + its own BM25 search), then the
//     per-segment results are OR-merged (dedup by atom.id keeping the
//     highest rrfScore; re-apply per-type cap; round-robin interleave by
//     type). This is the recall contract for "OR-semantics across
//     heterogeneous tokens" — the user's natural-language query
//     "mgm工时计算" must surface BOTH the MGM atom (via `mgm` segment
//     matching the `MGM` tag token) AND work-hour atoms (via `工时计算`
//     segment matching semantically through the dense channel). Without
//     splitting, the joint embedding of `mgm工时计算` is dominated by the
//     MGM project signal and dense cosine with work-hour atoms falls
//     below the 0.65 floor — splitting the query into its semantic
//     components lets each sub-query's dense channel match the right
//     corpus subset. Single-segment queries (pure ASCII or pure CJK)
//     skip the splitting path entirely and behave identically to the
//     pre-splitting implementation. Implementation: see `splitQuery`
//     and `mergeResults` below.
//   - Search is DISCOVERY ONLY. Does NOT bump `access_count` — strength
//     feedback is recorded exclusively by the agent's `memory_get` tool
//     (R-search-cheap, R-feedback-loop). Results carry `atom.id` plus the
//     metadata fields `distance` / `cosine` / `score` / `rrfScore`; the
//     agent fetches full content on demand by calling `memory_get(atom.id)`.

import { embedText } from "./embed.ts";
import { computeFreshness, computeTagOverlap } from "./scoring.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, MemoryAtomType, RecallResult } from "./types.ts";

/** Per-type recall cap. Hard ceiling on the per-type top list (Decision 2). */
const DEFAULT_TOP_K = 3;
/**
 * Maximum segment count eligible for query splitting. `recallAtoms`
 * splits a query into ASCII / CJK / whitespace segments before running
 * the per-segment hybrid recall — but only when the resulting segment
 * count is small enough that OR-merging keeps specificity. The recall
 * probability of OR-merge over N independent segments is `1 - (1-p)ᴺ`,
 * so 15+ segments (typical for a full user message: file path + project
 * ID + description + commands) almost always produce some unrelated
 * atom that ranked well in at least one segment. Cap the split to
 * focused search-term queries (≤ 3 segments: e.g. `mgm工时计算` →
 * `["mgm", "工时计算"]`); anything longer falls back to the full string
 * as a single segment so dense embedding of the whole message can hit
 * semantic neighbors via subword-level matching.
 */
const MAX_SPLIT_SEGMENTS = 3;

/** Default minimum cosine similarity for the DENSE channel (post-filter).
 *  Overridable per-call via `RecallOptions.threshold` for hermetic tests
 *  that use a weaker mock embedder. See file header for the empirical
 *  rationale behind 0.65 vs bge-m3's noise floor. Note: this is the
 *  dense-ONLY floor — it filters cosine hits from the dense channel before
 *  RRF fusion. The fused-recall gate is `recallThreshold` below. */
const DEFAULT_DENSE_COSINE_FLOOR = 0.65;

/** Multiplicative boost weights for the score formula (Decision 8). */
const STRENGTH_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

/** All canonical atom types — the three groups for per-type KNN. */
const TYPES: readonly MemoryAtomType[] = ["rule", "fact", "process"];

/** Smoothing constant for RRF (Decision 2). Industry default 60
 *  (Elasticsearch / OpenSearch / Qdrant). Same value for both channels. */
const DEFAULT_RRF_K = 60;

/** Default fused-RRF score floor for recall (the "recall gate").
 *  Set to `1/(DEFAULT_RRF_K + 1)` so a single-channel rank=0 contribution
 *  EQUALS the threshold and passes (`>=`). This is the industry-standard
 *  RRF rank-only stance (Elasticsearch / OpenSearch / Qdrant / Milvus):
 *  rank=0 single-channel hits are the strongest possible single-channel
 *  evidence and must not be filtered. Rank≥1 single-channel contributions
 *  are filtered (`1/(rrfK+2) ≈ 0.01613 < 0.01639`). The user's lefse
 *  case (cosine 0.55, BM25 0 hit) is NOT filtered here — it's caught by
 *  the COSINE FLOOR (`DEFAULT_DENSE_COSINE_FLOOR = 0.65`) which removes
 *  the 0.55 cosine atom from the dense channel BEFORE RRF fusion. The
 *  strict gate (`recallThreshold: 1 / rrfK ≈ 0.01667`) is available as
 *  a config override for users who want single-channel rank=0 filtered. */
const DEFAULT_RECALL_THRESHOLD = 1 / (DEFAULT_RRF_K + 1);

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
	/** Fused-RRF score gate. Default `1 / (rrfK + 1)` (≈ 0.01639 with rrfK=60).
	 *  Atoms whose fused rrfScore is below this are dropped. The default
	 *  lets single-channel rank=0 contributions through (their rrfScore
	 *  equals the threshold and `>=` passes) and filters rank≥1. This is
	 *  the industry-standard RRF rank-only stance (Elasticsearch /
	 *  OpenSearch / Qdrant / Milvus). For users who want strict
	 *  "宁可漏召不可误召" behavior (single-channel rank=0 also filtered),
	 *  set `recallThreshold: 1 / rrfK` (≈ 0.01667). Set to `0` to disable
	 *  the gate entirely (test / dev mode single-channel rescue). The
	 *  per-channel noise (e.g. dense cosine <0.65) is handled by the
	 *  cosine floor (`threshold`), not this gate. */
	recallThreshold?: number;
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
 * Split a query into segments at ASCII↔CJK boundaries AND whitespace.
 * Each segment is a maximal run of either ASCII-alphanumeric chars
 * (`[A-Za-z0-9_]`) or CJK chars (Unicode ranges `\u3400-\u9FFF`,
 * `\uF900-\uFAFF`, `\uFF01-\uFF60`). Whitespace and other punctuation
 * are segment separators and discarded (they belong to neither kind).
 *
 * Examples:
 *   `mgm工时计算`    → `["mgm", "工时计算"]`     (ASCII↔CJK boundary)
 *   `mgm 工时计算`   → `["mgm", "工时计算"]`     (whitespace)
 *   `工时估算`        → `["工时估算"]`            (single CJK segment)
 *   `lefse`         → `["lefse"]`               (single ASCII segment)
 *   `MGM project`   → `["MGM", "project"]`      (whitespace)
 *   `mgm,工时`       → `["mgm", "工时"]`         (comma is a separator)
 *
 * Each segment is then recalled independently (own embedding, own BM25
 * search) and the per-segment results are OR-merged. This is the OR-
 * semantics split: heterogeneous tokens like `mgm` (project name) and
 * `工时计算` (Chinese phrase) don't compete for a single embedding —
 * each gets its own.
 */
function splitQueryRaw(query: string): string[] {
	const segments: string[] = [];
	let current = "";
	let currentKind: "ascii" | "cjk" | null = null;

	const isAscii = (ch: string): boolean => {
		const c = ch.charCodeAt(0);
		return (
			(c >= 0x30 && c <= 0x39) || // 0-9
			(c >= 0x41 && c <= 0x5a) || // A-Z
			(c >= 0x61 && c <= 0x7a) || // a-z
			c === 0x5f // _
		);
	};

	const isCjk = (ch: string): boolean => {
		const c = ch.charCodeAt(0);
		return (
			(c >= 0x3400 && c <= 0x9fff) ||
			(c >= 0xf900 && c <= 0xfaff) ||
			(c >= 0xff01 && c <= 0xff60)
		);
	};

	for (const ch of query) {
		const kind: "ascii" | "cjk" | null = isAscii(ch)
			? "ascii"
			: isCjk(ch)
				? "cjk"
				: null;

		if (kind === currentKind && kind !== null) {
			current += ch;
		} else {
			if (current) segments.push(current);
			current = kind === null ? "" : ch;
			currentKind = kind;
		}
	}
	if (current) segments.push(current);
	return segments;
}

/**
 * Decide whether to split the query for OR-merge recall. The rule:
 * split ONLY when the segments contain BOTH ASCII and CJK kinds.
 *
 *   - Pure ASCII multi-word (`"omicron signal unique"`, `"MGM project"`):
 *     no split. Each sub-query is a focused English phrase; the dense
 *     embedding of the joined query already covers them well together,
 *     and the per-type fan-out + AND-on-BM25 channel gives the expected
 *     "phrase match" behavior. Splitting would degrade these (each
 *     sub-query embedding is too narrow to match a multi-word phrase).
 *   - Pure CJK multi-word (`"工时估算 项目"`, `"项目路径"`): no split.
 *     Same rationale — the dense embedding of the full phrase is more
 *     precise than per-word embeddings for Chinese semantic recall.
 *   - Mixed ASCII+CJK (`"mgm工时计算"`, `"mgm 工时计算"`, `"项目 mgm"`):
 *     split. The two kinds of tokens serve different recall purposes
 *     (ASCII often matches a tag or project ID via BM25; CJK is matched
 *     by dense semantics). Joining them into a single embedding biases
 *     the dense channel toward the ASCII semantic and can drop cosine
 *     with CJK-content atoms below the 0.65 floor. Splitting lets each
 *     sub-query's dense channel match the right corpus subset.
 *
 * Returns the full query (as a single-element array) when no split is
 * warranted, OR the heterogeneous segments array when it is. The caller
 * uses the array length to decide whether to enter the OR-merge path
 * or run the single-segment path.
 */
export function splitQuery(query: string): string[] {
	const segments = splitQueryRaw(query);
	if (segments.length <= 1) return segments;

	// Count distinct segment kinds. ASCII + CJK only (no punctuation in
	// segments, that's already filtered out by `splitQueryRaw`).
	let hasAscii = false;
	let hasCjk = false;
	for (const s of segments) {
		const c = s.charCodeAt(0);
		if (
			(c >= 0x30 && c <= 0x39) ||
			(c >= 0x41 && c <= 0x5a) ||
			(c >= 0x61 && c <= 0x7a) ||
			c === 0x5f
		) {
			hasAscii = true;
		} else {
			hasCjk = true;
		}
	}

	// Mixed kinds: split. Same kind (all ASCII or all CJK): don't.
	return hasAscii && hasCjk ? segments : [query];
}

/**
 * OR-merge results from multiple per-segment sub-queries into a single
 * ranked list. The contract:
 *   - Deduplicate by `atom.id`, keeping the highest `rrfScore` across
 *     segments (atoms that surface from multiple sub-queries are NOT
 *     boosted — we just keep the best evidence; boosting would require
 *     cross-segment RRF math which is a future design).
 *   - Re-apply per-type cap (`DEFAULT_TOP_K` per type) on the deduped
 *     set so the merged list never exceeds the standard 9-result ceiling.
 *   - Round-robin interleave by type, same as the single-segment path.
 *
 * The merge receives up to N×9 results from N segments and returns at
 * most 9 results. Sorts by `rrfScore` DESC within each type.
 */
function mergeResults(perSegment: RecallResult[][]): RecallResult[] {
	// Dedup by atom.id, keeping the highest rrfScore instance.
	const bestByAtomId = new Map<string, RecallResult>();
	for (const segmentResults of perSegment) {
		for (const r of segmentResults) {
			const existing = bestByAtomId.get(r.atom.id);
			if (
				!existing ||
				(r.rrfScore ?? 0) > (existing.rrfScore ?? 0)
			) {
				bestByAtomId.set(r.atom.id, r);
			}
		}
	}

	// Group by type, sort each by rrfScore DESC, slice to per-type cap.
	const byType = new Map<MemoryAtomType, RecallResult[]>();
	for (const r of bestByAtomId.values()) {
		const list = byType.get(r.atom.type);
		if (list) list.push(r);
		else byType.set(r.atom.type, [r]);
	}
	for (const list of byType.values()) {
		list.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));
		if (list.length > DEFAULT_TOP_K) list.length = DEFAULT_TOP_K;
	}

	// Round-robin interleave by type (same shape as single-segment path).
	const results: RecallResult[] = [];
	for (let i = 0; i < DEFAULT_TOP_K; i++) {
		for (const type of TYPES) {
			const item = byType.get(type)?.[i];
			if (item) results.push(item);
		}
	}
	return results;
}

/**
 * Hybrid per-type recall for a single query segment. This is the core
 * fan-out logic — each (segment, type) pair runs dense KNN + BM25 in
 * parallel, fuses via RRF, applies the cosine floor + recall gate, then
 * caps to `DEFAULT_TOP_K`. Per-type lists are interleaved round-robin.
 *
 * `recallAtoms` is the public entry point: it splits the query into
 * segments via `splitQuery`, runs `recallAtomsSingleSegment` per
 * segment, and OR-merges via `mergeResults`.
 *
 * Two channels, two failure modes:
 *   - `embedText` returns null (ollama down): dense channel collapses to
 *     `[]`; BM25 still runs and surfaces BM25-only hits. Single-channel
 *     graceful degradation per principle "召回对单 channel 降级鲁棒".
 *   - BM25 query empty (e.g. all FTS5-special chars or all CJK stripped):
 *     bm25Search short-circuits to `[]` inside storage.ts; dense still
 *     runs.
 *
 * Results carry `atom.id` plus `distance` / `cosine` / `score` (kept
 * verbatim from the dense-only era) AND the new `rrfScore` field
 * populated from the fused-RRF map. `score = cosine × (1 + 0.3 × strength
 * + 0.2 × importance) + 0.10 × tagOverlap + 0.05 × freshness` — the
 * multiplicative anchor remains the back-compat invariant for the
 * `memory_get` tool and any UI that reads `score`; the additive terms
 * contribute small boosts (≤ 0.15) for tag-match and recency. `tagOverlap`
 * and `freshness` are exposed on the result for debug visibility.
 *
 * Search does NOT bump `access_count` — strength feedback is recorded
 * exclusively by the agent's `memory_get` tool.
 */
async function recallAtomsSingleSegment(
	index: MemoryIndex,
	segment: string,
	options: RecallOptions,
): Promise<RecallResult[]> {
	const rrfK = options.rrfK ?? DEFAULT_RRF_K;
	const recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;
	const cosineFloor = options.threshold ?? DEFAULT_DENSE_COSINE_FLOOR;
	const wTag = options.tagOverlapWeight ?? 0.10;
	const wFreshness = options.freshnessWeight ?? 0.05;
	const tagAliases = options.tagAliases;

	// Embed segment for the dense channel. null means ollama is down —
	// dense channel collapses to [] but BM25 still runs (graceful
	// degradation, see file header).
	const queryEmbedding = await embedText(segment);

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
				index.bm25Search(segment, topK, {
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

				const tagOverlap = computeTagOverlap(segment, atom.tags, tagAliases);
				const freshness = computeFreshness(atom.updated_at);
				const score =
					cosine *
						(1 + STRENGTH_WEIGHT * atom.strength + IMPORTANCE_WEIGHT * atom.importance) +
					wTag * tagOverlap +
					wFreshness * freshness;
				scored.push({
					atom,
					distance,
					cosine,
					score,
					rrfScore: f.rrfScore,
					tagOverlap,
					freshness,
				});
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

/**
 * Hybrid recall entry point. Splits the query into homogeneous segments
 * (ASCII run / CJK run / whitespace-separated words), runs the per-
 * segment recall in parallel, and OR-merges the per-segment results
 * (dedup by atom.id keeping the highest rrfScore, re-apply per-type
 * cap, round-robin interleave). Single-segment queries skip the
 * splitting path and run the existing per-type fan-out directly.
 *
 * @see {@link splitQuery} for the segment-splitting rules.
 * @see {@link mergeResults} for the OR-merge contract.
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	const segments = splitQuery(query);

	// Single segment (pure ASCII or pure CJK, or short mixed query that
	// happens to land in one ASCII run / one CJK run): skip the splitting
	// + merge overhead — the existing per-type fan-out produces the final
	// result list directly. This keeps pure-query callers (the common case
	// for webui search and the agent's `before_agent_start` hook) on the
	// fastest path with no behavior change.
	if (segments.length <= 1) {
		return recallAtomsSingleSegment(index, query, options);
	}

	// Long queries: do NOT split. A full user message (file path + project
	// ID + description + commands) typically produces 15-30 segments after
	// splitting; OR-merging that many dilutes specificity — recall
	// probability scales as 1-(1-p)ᴺ. Fall back to the full string as a
	// single segment so the dense embedding of the whole message can hit
	// semantic neighbors via subword-level matching, and BM25 can match the
	// escape-preserved ASCII tokens (project ID, file path) directly. The
	// threshold (`MAX_SPLIT_SEGMENTS = 3`) is the boundary between a
	// focused search term (`mgm工时计算` → ["mgm", "工时计算"], 2 segs,
	// under cap → split) and a long prompt (32 segs, over cap → no split).
	if (segments.length > MAX_SPLIT_SEGMENTS) {
		return recallAtomsSingleSegment(index, query, options);
	}

	// Multi-segment within cap: run each segment independently in parallel.
	// Each call has its own embed + BM25 search, so heterogeneous tokens
	// don't compete for one embedding — `mgm工时计算` segments into
	// ["mgm", "工时计算"] and each gets a focused dense channel run that
	// matches the right corpus subset.
	const perSegmentResults = await Promise.all(
		segments.map((segment) => recallAtomsSingleSegment(index, segment, options)),
	);

	return mergeResults(perSegmentResults);
}
