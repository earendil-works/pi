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
//   - Default cosine threshold = 0.5 (filtered AFTER vectorSearch returns).
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
 *  `RecallOptions.threshold` for hermetic tests that use a weaker mock embedder. */
const DEFAULT_THRESHOLD = 0.5;

/** Multiplicative boost weights for the score formula (Decision 8). */
const STRENGTH_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

/** All canonical atom types — the three groups for per-type KNN. */
const TYPES: readonly MemoryAtomType[] = ["rule", "fact", "process"];

/**
 * Options for `recallAtoms`. `topK` controls the per-type cap (default 3,
 * Decision 2). `threshold` is honored (default 0.5) so hermetic tests with
 * weaker mock embedders can dial it down. `filter` narrows the search to
 * a single atom type.
 */
export interface RecallOptions {
	/** Per-type cap on results (Decision 2). Default 3. */
	topK?: number;
	/** Minimum cosine similarity (post-filter). Default 0.5 (Decision 8). */
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
 *
 * The `atomsDir` parameter is retained for signature compatibility with
 * prior callers; it is no longer used to construct any path.
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	_atomsDir: string,
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
			// Local shape with `score` so the in-place sort typechecks; the
			// entries are cast to `RecallResult` at the very end (Task 1.1
			// will replace `file_path` with `score` on the public type, after
			// which no cast is needed).
			const scored: ScoredCandidate[] = [];
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
			return scored.slice(0, DEFAULT_TOP_K).map(asRecallResult);
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

/**
 * Internal result shape carrying the multiplicative `score` field. The
 * public `RecallResult` does not yet expose `score` (Task 1.1 will add it
 * in place of `file_path`), so we type the per-type working list locally
 * and cast to `RecallResult` at the very end.
 */
interface ScoredCandidate {
	atom: MemoryAtom;
	distance: number;
	cosine: number;
	score: number;
}

/**
 * Transitional cast from the local `ScoredCandidate` shape to the public
 * `RecallResult`. Task 1.1 will add `score` to `RecallResult` (and drop
 * `file_path`), at which point this cast becomes a structural no-op and
 * can be removed.
 */
function asRecallResult(c: ScoredCandidate): RecallResult {
	return c as unknown as RecallResult;
}
