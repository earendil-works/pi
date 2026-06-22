// recallAtoms — pure vector KNN retrieval over the memory index.
//
// Architecture constraints (from design.md Decisions 7, 8):
//   - Pure sqlite-vec KNN. NO FTS5 / keyword fallback. embedText returning null
//     means "ollama is down, collapse to []" (S41 / R39).
//   - Default cosine threshold = 0.5 (filtered AFTER vectorSearch returns).
//   - Search is DISCOVERY ONLY. Every result carries file_path pointing to the
//     .md storage file; the agent reads full content on demand via the standard
//     `read` tool. We never hydrate content at recall time — no L0/L1 split,
//     no I/O cost beyond the vector search itself (R-search-cheap).
//   - updateAccess is called for every atom we surface — recall counts toward
//     strength / access_count (R25).

import path from "node:path";
import { embedText } from "./embed.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, RecallResult } from "./types.ts";

/** Options for `recallAtoms`. All fields are optional. */
export interface RecallOptions {
	/** Max results to return. Default 10. */
	topK?: number;
	/** Min cosine similarity (post-filter). Default 0.5. */
	threshold?: number;
	/** Restrict KNN to a single atom type. */
	filter?: { type?: MemoryAtom["type"] };
}

/**
 * Pure vector retrieval: embed the query, run sqlite-vec KNN, return ranked
 * atoms with their file_path so the caller can read full content on demand.
 *
 * Returns `[]` when `embedText` returns null (ollama unreachable). No FTS or
 * keyword fallback — the caller must treat an empty array as "no memory
 * context for this prompt" (R39 / S41).
 */
export async function recallAtoms(
	index: MemoryIndex,
	query: string,
	atomsDir: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	const topK = options.topK ?? 10;
	const threshold = options.threshold ?? 0.5;

	// Embed query — null means ollama is down. No fallback per Decision 7.
	const queryEmbedding = await embedText(query);
	if (!queryEmbedding) return [];

	// Pull topK * 2 candidates so the threshold filter has headroom — some
	// candidates will be filtered out and we still want to surface up to
	// topK in the result.
	const raw = index.vectorSearch(queryEmbedding, topK * 2, {
		type: options.filter?.type,
		isLatestOnly: true,
		archived: false,
	});

	const results: RecallResult[] = [];
	for (const { id, distance } of raw) {
		const atom = index.getAtom(id);
		if (!atom) continue;
		const cosine = 1 - (distance * distance) / 2; // L2 → cosine (for unit vectors)
		if (cosine < threshold) continue;

		// Atomic UPDATE; better-sqlite3 makes this synchronous at the JS level.
		index.updateAccess(id);

		results.push({
			atom,
			distance,
			cosine,
			file_path: path.join(atomsDir, atom.type, `${atom.id}.md`),
		});

		if (results.length >= topK) break;
	}

	return results;
}