// bge-m3 reindex HTTP client.
//
// Triggers the embedding service to recompute the dense + sparse vectors
// for one atom after its text has changed. Called from:
//   - the executeItem update/supersede/create paths in extraction.ts
//     (after writeAtomToFile updates the on-disk atom body)
//   - the migrate-legacy-atoms.mts migration script (after merging
//     two legacy atoms in-place)
//
// Endpoint: POST {baseUrl}/api/atoms/{id}/reindex on the bge-m3
// FastAPI service (default http://127.0.0.1:11435, see /tmp/bge-m3-test/server.py).
//
// Failure contract: this module NEVER throws. Any failure (timeout,
// 5xx, network error, AbortError) collapses to
//   { ok: false, error: "..." }
// so the caller can log a warning and continue. Per design Decision 4,
// a transient service outage must not abort an in-progress migration
// or stall the extract pipeline — the worst case is one stale vector
// until the next reindex triggers.

/** Default bge-m3 service URL. Matches embed.ts DEFAULT_CONFIG.ollamaUrl. */
const DEFAULT_BASE_URL = "http://127.0.0.1:11435";

/** Per-call timeout. 5s is enough for a single atom reindex even on
 *  a slow host; longer would risk blocking extraction. */
const TIMEOUT_MS = 5000;

/**
 * Ask the bge-m3 service to recompute embedding + sparse vector for one atom.
 *
 * Returns `{ ok: true }` on a 2xx response, `{ ok: false, error }` on any
 * failure (non-2xx, timeout, network error, malformed response). This
 * function never throws — callers are expected to log a warning and
 * continue. The "continue on failure" semantics is a hard requirement
 * (design Decision 4): one network blip must not roll back the whole
 * extract run or migration.
 *
 * @param atomId The atom whose vector should be recomputed. URL-interpolated
 *               into the path — caller is responsible for passing a safe id
 *               (atoms use slugified ids without `/` or `?`).
 * @param baseUrl bge-m3 service URL. Override for tests against a fake server.
 */
export async function reindexOne(
	atomId: string,
	baseUrl: string = DEFAULT_BASE_URL,
): Promise<{ ok: boolean; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/api/atoms/${atomId}/reindex`, {
			method: "POST",
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return {
				ok: false,
				error: `bge-m3 returned ${response.status}: ${body}`,
			};
		}
		return { ok: true };
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return { ok: false, error: `bge-m3 reindex timeout after ${TIMEOUT_MS}ms` };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}