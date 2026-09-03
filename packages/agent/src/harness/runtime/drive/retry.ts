export function retryDelay(baseDelayMs: number, attempt: number): number {
	const delay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
}

export function retryNotBefore(baseDelayMs: number, attempt: number, now = Date.now()): number {
	const sum = now + retryDelay(baseDelayMs, attempt);
	return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

export function waitUntil(notBefore: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		const check = () => {
			const remaining = notBefore - Date.now();
			if (remaining <= 0) {
				cleanup();
				resolve();
				return;
			}
			timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		else check();
	});
}
