/**
 * Error thrown when a streaming connection receives no data for longer than
 * the configured idle timeout. Consumers can catch this specifically to
 * distinguish idle timeouts from other errors.
 */
export class StreamIdleTimeoutError extends Error {
	public readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Stream idle timeout: no data received for ${timeoutMs / 1000}s`);
		this.name = "StreamIdleTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Wraps an async iterable with a per-chunk idle timeout watchdog.
 *
 * After each yielded chunk, a timer is reset. If no chunk arrives within
 * `timeoutMs`, a {@link StreamIdleTimeoutError} is thrown. This guards
 * against silently dropped HTTP/SSE connections where the server stops
 * sending data but the TCP connection stays open.
 *
 * When `timeoutMs` is 0, undefined, or negative the source is yielded
 * through without any timeout logic (zero overhead pass-through).
 *
 * @param source   - The upstream async iterable (e.g. SDK stream)
 * @param timeoutMs - Maximum idle time in milliseconds before aborting
 */
export async function* withStreamIdleTimeout<T>(
	source: AsyncIterable<T>,
	timeoutMs: number | undefined,
): AsyncGenerator<T> {
	if (!timeoutMs || timeoutMs <= 0) {
		yield* source;
		return;
	}

	const iterator = source[Symbol.asyncIterator]();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	try {
		while (true) {
			// Race: next chunk vs idle timeout
			const result = await Promise.race([
				iterator.next(),
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs);
				}),
			]);

			// Chunk arrived — clear the timeout
			clearTimeout(timeoutId);
			timeoutId = undefined;

			if (result.done) break;
			yield result.value;
		}
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		// Signal the underlying iterator to release resources (close HTTP connection, etc.)
		// Reason: we don't await return() because if the iterator is stuck in an
		// unresolvable promise (the exact scenario this utility guards against),
		// awaiting return() would hang forever. Fire-and-forget is safe here —
		// the iterator will be GC'd along with any pending promises.
		iterator.return?.(undefined);
	}
}
