/**
 * Fetch wrapper with timeout, retry, and exponential backoff.
 *
 * The build script that imports this module (scripts/generate-models.ts) used to
 * call `fetch` directly with no timeout, no retry, and no `response.ok` check.
 * Intermittent network or upstream-API failures silently degraded the generated
 * catalog (e.g. nvidia.models.ts missing on a partial models.dev response).
 *
 * This helper makes every HTTP call in the generator fail loudly after
 * `maxAttempts` retries, instead of letting the script continue with empty
 * or partial data and then break the type-check step downstream.
 */
export interface FetchWithRetryOptions {
	/** Per-attempt timeout in milliseconds. Default: 30_000. */
	timeoutMs?: number;
	/** Total attempts including the first try. Default: 3. */
	maxAttempts?: number;
	/** Human-readable label used in error messages and warnings. */
	label: string;
}

export async function fetchWithRetry(
	url: string,
	options: FetchWithRetryOptions = { label: "fetch" },
): Promise<Response> {
	const { timeoutMs = 30_000, maxAttempts = 3, label } = options;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}
			return response;
		} catch (error) {
			lastError = error;
			if (attempt < maxAttempts) {
				const backoff = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
				console.warn(
					`${label}: attempt ${attempt} failed, retrying in ${backoff}ms:`,
					error instanceof Error ? error.message : error,
				);
				await new Promise((r) => setTimeout(r, backoff));
			}
		}
	}
	throw new Error(`${label} failed after ${maxAttempts} attempts: ${formatError(lastError)}`);
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}