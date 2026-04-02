/**
 * Wait for a specified number of milliseconds, optionally with an abort signal.
 */
export async function sleep(ms, signal) {
	if (signal?.aborted) throw new Error("Aborted");
	if (ms <= 0) return;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abortHandler);
			resolve();
		}, ms);
		const abortHandler = () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", abortHandler, { once: true });
	});
}
/**
 * Parse a retry delay from a Gemini error message if present.
 * Example: "Your quota will reset after 45s."
 */
export function parseGeminiRetryAfter(message) {
	const match = message.match(/reset after (\d+)s/);
	if (match) {
		const seconds = parseInt(match[1], 10);
		if (!Number.isNaN(seconds)) {
			return seconds * 1000;
		}
	}
	return undefined;
}
/**
 * Calculate exponential backoff with jitter.
 */
export function getExponentialBackoff(attempt, baseDelay, maxDelay) {
	const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
	// Add jitter (±20%)
	const jitter = delay * 0.2 * (Math.random() * 2 - 1);
	return Math.max(0, delay + jitter);
}
//# sourceMappingURL=retry.js.map
