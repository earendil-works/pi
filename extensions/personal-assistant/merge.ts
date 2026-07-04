import type { RecallResult } from "./types.ts";

/**
 * Merge multiple result groups into a single deduplicated list.
 * For atoms with the same id across groups, keeps the entry with the highest rrf.
 * Pure function — no I/O, no side effects.
 *
 * This is the rrf-based merge — used by callers that rank by the bge-m3
 * hybrid-RRF score (no rerank step). The per-subquery rerank pipeline
 * uses `mergeByRerankScore` below, which keys on `rerankScore`.
 */
export function mergeByAtomId(resultGroups: RecallResult[][]): RecallResult[] {
	const map = new Map<string, RecallResult>();

	for (const group of resultGroups) {
		for (const result of group) {
			const existing = map.get(result.atom.id);
			if (!existing || result.rrf > existing.rrf) {
				map.set(result.atom.id, result);
			}
		}
	}

	return [...map.values()];
}

/**
 * Merge multiple per-subquery result pools into a single list, deduped by
 * `atom.id` and sorted by `rerankScore` DESC. For atoms with the same id
 * across pools, keeps the entry with the highest `rerankScore`. Ties on
 * rerankScore are resolved by insertion order (the first pool to contribute
 * the id wins — pools are processed in array order).
 *
 * Pure function — no I/O, no side effects. `-1` default for missing
 * rerankScore so a hit with no rerank score can never out-rank one that
 * has one (consistent with rerankAndFilter's "all-below" semantics).
 */
export function mergeByRerankScore(resultGroups: RecallResult[][]): RecallResult[] {
	const map = new Map<string, RecallResult>();

	for (const group of resultGroups) {
		for (const result of group) {
			const existing = map.get(result.atom.id);
			if (!existing || (result.rerankScore ?? -1) > (existing.rerankScore ?? -1)) {
				map.set(result.atom.id, result);
			}
		}
	}

	return [...map.values()].sort(
		(a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0),
	);
}
