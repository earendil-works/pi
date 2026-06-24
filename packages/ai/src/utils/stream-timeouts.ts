/**
 * Connect/idle timeout helpers shared by the streaming providers. Kept here so Bedrock,
 * Anthropic (and any future provider) wire the same logic rather than re-implementing it.
 */

const TIMEOUT_SYMBOL = Symbol("idle-timeout");

/**
 * Resolve a timeout option (ms): `undefined`/`null` uses `defaultMs`; a non-positive or
 * non-finite value disables the timeout (returns `0`).
 */
export function resolveTimeoutMs(value: number | null | undefined, defaultMs: number): number {
	if (value === undefined || value === null) return defaultMs;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * Idle-timeout watchdog for a streaming read loop. A half-open socket (open, but no further
 * events and no FIN/RST) otherwise blocks the underlying `next()` forever. The timer resets on
 * every event; on prolonged silence the generator throws `makeError()`, which callers classify
 * as retryable. The race resolves a sentinel on timeout rather than rejecting, so the throw
 * happens once, at the top of the loop.
 */
export async function* withStreamIdleTimeout<T>(
	source: AsyncIterable<T>,
	idleMs: number,
	makeError: () => Error,
): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		while (true) {
			const idle = new Promise<typeof TIMEOUT_SYMBOL>((resolve) => {
				timer = setTimeout(() => resolve(TIMEOUT_SYMBOL), idleMs);
			});
			const result = await Promise.race([iterator.next(), idle]);
			if (result === TIMEOUT_SYMBOL) throw makeError();
			clearTimeout(timer);
			if (result.done) return;
			yield result.value;
		}
	} finally {
		clearTimeout(timer);
		try {
			// Release the underlying stream on early exit (timeout / abort / break).
			await iterator.return?.();
		} catch {
			/* ignore */
		}
	}
}

/**
 * @param connectMs The timeout in milliseconds. 0 value disables the timeout (and the signal never aborts).
 *
 * @returns A signal that is aborted if the timeout elapses, and a clearTimeout function to stop the timer.
 */
export function createConnectTimeout(connectMs: number): { signal: AbortSignal; clearTimeout: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		if (connectMs > 0) {
			controller.abort();
		}
	}, connectMs);
	return {
		signal: controller.signal,
		clearTimeout: () => clearTimeout(timer),
	};
}
