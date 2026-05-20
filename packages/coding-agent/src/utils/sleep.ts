/**
 * Sleep helper that respects abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const cleanup = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(new Error("Aborted"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
