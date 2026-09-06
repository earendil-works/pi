import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function successfulRefresh(): ModelsRefreshResult {
	return { aborted: false, errors: new Map() };
}

describe("interactive model catalog refresh", () => {
	it("shares one runtime refresh between concurrent callers", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const runtime = { refresh: vi.fn((_options?: ModelsRefreshOptions) => deferred.promise) };
		const firstController = new AbortController();
		const secondController = new AbortController();

		const first = refreshModelCatalogs(runtime, firstController.signal);
		const second = refreshModelCatalogs(runtime, secondController.signal);

		expect(runtime.refresh).toHaveBeenCalledOnce();
		deferred.resolve(successfulRefresh());
		await expect(first).resolves.toEqual(successfulRefresh());
		await expect(second).resolves.toEqual(successfulRefresh());
	});

	it("keeps the shared refresh alive when one caller stops waiting", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		let refreshSignal: AbortSignal | undefined;
		const runtime = {
			refresh: vi.fn((options?: ModelsRefreshOptions) => {
				refreshSignal = options?.signal;
				return deferred.promise;
			}),
		};
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = refreshModelCatalogs(runtime, firstController.signal);
		const second = refreshModelCatalogs(runtime, secondController.signal);

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(refreshSignal?.aborted).toBe(false);

		deferred.resolve(successfulRefresh());
		await expect(second).resolves.toEqual(successfulRefresh());
	});

	it("aborts an abandoned refresh and allows a later refresh to start", async () => {
		const refreshSignals: AbortSignal[] = [];
		const runtime = {
			refresh: vi.fn((options?: ModelsRefreshOptions) => {
				if (options?.signal) refreshSignals.push(options.signal);
				return new Promise<ModelsRefreshResult>(() => {});
			}),
		};
		const firstController = new AbortController();
		const first = refreshModelCatalogs(runtime, firstController.signal);

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(refreshSignals[0]?.aborted).toBe(true));

		const secondController = new AbortController();
		const second = refreshModelCatalogs(runtime, secondController.signal);
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		secondController.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
	});
});
