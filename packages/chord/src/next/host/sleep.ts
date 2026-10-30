// Waiting helpers for routines, jobs and handlers (§14): `sleep(ms, ctx)` and `untilAborted(ctx)`, which end with
// their context, leaving no timer or listener behind. Portable: timers and `AbortSignal` only.

import type { Context } from "../../context/index.ts";

/** The longest delay one timer takes (a longer one fires at once). */
const MAX_TIMER = 2 ** 31 - 1;

/**
 * Resolves after `ms` milliseconds; rejects with the abort reason once `context` is aborted, clearing its timer and
 * listener. Delays above the timer limit (2^31-1 ms) are chained timers.
 */
export function sleep(ms: number, context: Context): Promise<void> {
	const signal = context.abortSignal;
	if (signal?.aborted) return Promise.reject(signal.reason);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abort = (): void => {
		clearTimeout(timer);
		reject(signal?.reason);
	};
	const wait = (left: number): void => {
		timer = setTimeout(
			() => {
				if (left > MAX_TIMER) return wait(left - MAX_TIMER);
				signal?.removeEventListener("abort", abort);
				resolve();
			},
			Math.min(left, MAX_TIMER),
		);
	};
	signal?.addEventListener("abort", abort, { once: true });
	wait(ms);
	return promise;
}

/** Resolves once `context` is aborted (never without an abort signal); leaves no listener behind. */
export function untilAborted(context: Context): Promise<void> {
	const signal = context.abortSignal;
	if (signal === undefined) return new Promise(() => {});
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
