// Hybrid RRF recall via the local bge-m3 embedding service.
//
// Wraps `POST {embeddingServiceUrl}/api/search` which runs the dual-channel
// (dense cosine + sparse lexical) RRF retrieval server-side. The result is
// a flat list of `{id, title, type, rank, rrf, dense_cos, sparse_score}`
// pre-sorted by RRF, already floor-filtered (dense ≥ 0.55, sparse ≥ 0.3).
//
// Search.ts uses this instead of the local sqlite-vec KNN: same per-type
// round-robin output, but recall now benefits from the sparse channel
// (token-level "MGM" / "ROC-AUC" matches that previously fell below the
// dense floor).
//
// Failure mode: a service outage collapses to [] just like the legacy
// embedText null → graceful degradation (Decision 7).

import type { MemoryAtomType } from "./types.ts";

export interface HybridHit {
	id: string;
	title: string;
	type: MemoryAtomType;
	rank: number;
	rrf: number;
	dense_cos: number;
	sparse_score: number;
}

export interface HybridSearchOptions {
	/** Per-call timeout in milliseconds. Default 15s matches embed.ts. */
	timeoutMs?: number;
	/** Override the dense cosine floor (server default 0.55). */
	denseFloor?: number;
	/** Override the sparse lexical floor (server default 0.3). */
	sparseFloor?: number;
	/** Restrict the search to a single atom type (rule/fact/process). */
	type?: MemoryAtomType;
}

/** Default service URL. Matches embed.ts DEFAULT_CONFIG.ollamaUrl. */
const DEFAULT_EMBEDDING_SERVICE_URL = "http://127.0.0.1:11435";
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Dual-channel RRF recall for a single query.
 *
 * Returns the pre-sorted top-K hits from the embedding service, or [] on
 * any failure (network error, timeout, non-OK response, malformed body).
 * Mirrors `embedText`'s "null on failure" contract for graceful degradation.
 *
 * The service URL is read from the `embeddingServiceUrl` option (defaults
 * to the FastAPI service on 11435). The legacy `ollamaUrl` field name in
 * the embed config is reused here — it's semantically the "embedding
 * service base URL" regardless of whether the backend is ollama or our
 * FastAPI service.
 */
export async function hybridSearch(
	query: string,
	topK: number,
	options: HybridSearchOptions & { embeddingServiceUrl?: string } = {},
): Promise<HybridHit[]> {
	if (!query || query.trim().length === 0) return [];

	const url = options.embeddingServiceUrl ?? DEFAULT_EMBEDDING_SERVICE_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const body: Record<string, unknown> = { query, top_k: topK };
	if (options.denseFloor !== undefined) body.dense_floor = options.denseFloor;
	if (options.sparseFloor !== undefined) body.sparse_floor = options.sparseFloor;
	if (options.type !== undefined) body.type = options.type;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(`${url}/api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			// Non-OK response from the service. Surface as a structured
			// warning so callers can distinguish "service up but rejecting"
			// from "service reachable but no candidates" (both yield []).
			console.warn(
				`[bge-m3] /api/search returned ${res.status}; collapsing to 0 hits`,
			);
			return [];
		}
		const data: unknown = await res.json();
		return readHits(data);
	} catch (err) {
		// fetch rejected, AbortError on timeout, JSON parse error, etc.
		// Falls back to [] — same graceful-degradation contract as embedText.
		// The warning surfaces service-unreachable in logs (operational
		// diagnostic; see debug-report 2026-07-06-bge-m3-down).
		const reason =
			err instanceof Error
				? err.name === "AbortError"
					? "timeout"
					: err.message
				: String(err);
		console.warn(`[bge-m3] /api/search unreachable: ${reason}`);
		return [];
	}
}

/**
 * Type-safe accessor for the /api/search response body.
 *
 * Expected shape:
 *   {
 *     query: string,
 *     atoms_count: number,
 *     results: [
 *       { id, title, type, rank, rrf, dense_cos, sparse_score },
 *       ...
 *     ]
 *   }
 *
 * Returns [] for any malformed shape. We do NOT surface partial results —
 * the caller wants the full ranked list or nothing at all.
 */
function readHits(body: unknown): HybridHit[] {
	if (!body || typeof body !== "object") return [];
	const results = (body as { results?: unknown }).results;
	if (!Array.isArray(results)) return [];
	const hits: HybridHit[] = [];
	for (const r of results) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (
			typeof o.id !== "string" ||
			typeof o.title !== "string" ||
			typeof o.type !== "string" ||
			typeof o.rank !== "number" ||
			typeof o.rrf !== "number" ||
			typeof o.dense_cos !== "number" ||
			typeof o.sparse_score !== "number"
		) {
			continue;
		}
		hits.push({
			id: o.id,
			title: o.title,
			type: o.type as MemoryAtomType,
			rank: o.rank,
			rrf: o.rrf,
			dense_cos: o.dense_cos,
			sparse_score: o.sparse_score,
		});
	}
	return hits;
}