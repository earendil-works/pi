import type { Models } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
}

interface StalledCredentialList {
	started: Promise<void>;
	release(): void;
	fail(error: Error): void;
	getCallCount(): number;
}

function createDeferred(): Deferred {
	let resolvePromise = () => {};
	let rejectPromise = (_error: Error) => {};
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function stallNextCredentialList(harness: Harness): StalledCredentialList {
	const originalList = harness.authStorage.list.bind(harness.authStorage);
	const started = createDeferred();
	const gate = createDeferred();
	let shouldStall = true;
	let callCount = 0;

	harness.authStorage.list = async () => {
		const entries = await originalList();
		callCount++;
		if (!shouldStall) return entries;
		shouldStall = false;
		started.resolve();
		await gate.promise;
		return entries;
	};

	return {
		started: started.promise,
		release: gate.resolve,
		fail: gate.reject,
		getCallCount: () => callCount,
	};
}

/** Queue a refresh behind the stalled pass, then let the stalled pass time out. */
async function timeOutStalledPass(harness: Harness): Promise<void> {
	const refresh = harness.session.modelRuntime.refresh({ allowNetwork: false });
	await vi.advanceTimersByTimeAsync(AVAILABILITY_PASS_TIMEOUT_MS);
	await refresh;
}

const AVAILABILITY_PASS_TIMEOUT_MS = 10_000;
const TIMEOUT_MESSAGE = `Availability check timed out after ${AVAILABILITY_PASS_TIMEOUT_MS} ms`;

describe("issue #7301 stalled availability refresh", () => {
	let harness: Harness | undefined;
	let stalledList: StalledCredentialList | undefined;

	afterEach(() => {
		vi.useRealTimers();
		stalledList?.release();
		stalledList = undefined;
		harness?.cleanup();
		harness = undefined;
	});

	it("times out a stalled pass so later passes save, and ignores its late result", async () => {
		harness = await createHarness({ withConfiguredAuth: false });
		const runtime = harness.session.modelRuntime;
		await harness.authStorage.modify("stale-provider", async () => ({ type: "api_key", key: "stale-key" }));
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("stale-provider")).toEqual({ configured: true, source: "stored" });

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		stalledList = stallNextCredentialList(harness);
		const staleRefresh = expect(runtime.getAvailable()).rejects.toThrow(TIMEOUT_MESSAGE);
		await stalledList.started;

		await harness.authStorage.delete("stale-provider");
		await harness.authStorage.modify("current-provider", async () => ({ type: "api_key", key: "current-key" }));
		await timeOutStalledPass(harness);
		await staleRefresh;
		expect(stalledList.getCallCount()).toBe(2);
		expect(runtime.getProviderAuthStatus("stale-provider")).toEqual({ configured: false });
		expect(runtime.getProviderAuthStatus("current-provider")).toEqual({ configured: true, source: "stored" });

		stalledList.release();
		await vi.waitFor(() => expect(stalledList?.getCallCount()).toBe(2));
		expect(runtime.getProviderAuthStatus("stale-provider")).toEqual({ configured: false });
		expect(runtime.getProviderAuthStatus("current-provider")).toEqual({ configured: true, source: "stored" });
	});

	it("does not let a stale failure overwrite newer availability error state", async () => {
		harness = await createHarness({ withConfiguredAuth: false });
		const runtime = harness.session.modelRuntime;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		stalledList = stallNextCredentialList(harness);
		const staleRefresh = expect(runtime.getAvailable()).rejects.toThrow(TIMEOUT_MESSAGE);
		await stalledList.started;

		await timeOutStalledPass(harness);
		await staleRefresh;
		expect(runtime.getError()).toBeUndefined();

		stalledList.fail(new Error("stale credential list failure"));
		await Promise.resolve();
		expect(runtime.getError()).toBeUndefined();
	});

	it("times out a provider check that never settles without blocking later passes", async () => {
		harness = await createHarness();
		const runtime = harness.session.modelRuntime;
		const provider = harness.getModel().provider;
		const models = Reflect.get(runtime, "models") as Models;
		const originalGetAvailable = models.getAvailable.bind(models);
		const started = createDeferred();
		const gate = createDeferred();
		let stall = true;
		models.getAvailable = async (providerId, options) => {
			if (providerId !== provider || !stall) return originalGetAvailable(providerId, options);
			stall = false;
			started.resolve();
			await gate.promise;
			throw new Error("stale provider availability failure");
		};

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const staleRefresh = expect(runtime.getAvailable(provider)).rejects.toThrow(TIMEOUT_MESSAGE);
		await started.promise;
		await timeOutStalledPass(harness);
		await staleRefresh;
		expect(runtime.hasConfiguredAuth(provider)).toBe(true);
		expect(runtime.getError()).toBeUndefined();

		gate.resolve();
		await Promise.resolve();
		expect(runtime.getError()).toBeUndefined();
	});
});
