import type { RecallResult } from "./types.ts";

/**
 * Merge multiple result groups into a single deduplicated list.
 * For atoms with the same id across groups, keeps the entry with the highest rrf.
 * Pure function — no I/O, no side effects.
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
