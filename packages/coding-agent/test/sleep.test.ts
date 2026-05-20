import { describe, expect, it } from "vitest";
import { sleep } from "../src/utils/sleep.ts";

function countAbortListeners(signal: AbortSignal): () => number {
	const originalAddEventListener = signal.addEventListener.bind(signal);
	const originalRemoveEventListener = signal.removeEventListener.bind(signal);
	let activeAbortListeners = 0;

	signal.addEventListener = ((type, listener, options) => {
		if (type === "abort") activeAbortListeners++;
		return originalAddEventListener(type, listener, options);
	}) as typeof signal.addEventListener;

	signal.removeEventListener = ((type, listener, options) => {
		if (type === "abort") activeAbortListeners--;
		return originalRemoveEventListener(type, listener, options);
	}) as typeof signal.removeEventListener;

	return () => activeAbortListeners;
}

describe("sleep", () => {
	it("removes abort listener after the timeout resolves", async () => {
		const controller = new AbortController();
		const getAbortListenerCount = countAbortListeners(controller.signal);

		await sleep(1, controller.signal);

		expect(getAbortListenerCount()).toBe(0);
	});

	it("removes abort listener after the signal aborts", async () => {
		const controller = new AbortController();
		const getAbortListenerCount = countAbortListeners(controller.signal);

		const sleeping = sleep(60_000, controller.signal);
		expect(getAbortListenerCount()).toBe(1);

		controller.abort();

		await expect(sleeping).rejects.toThrow("Aborted");
		expect(getAbortListenerCount()).toBe(0);
	});
});
