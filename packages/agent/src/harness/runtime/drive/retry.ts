import { type RetryPolicy, retryDelayMs } from "@earendil-works/pi-ai";

export function retryNotBefore(
	policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">,
	attempt: number,
	now = Date.now(),
): number {
	const sum = now + retryDelayMs(policy, attempt);
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
