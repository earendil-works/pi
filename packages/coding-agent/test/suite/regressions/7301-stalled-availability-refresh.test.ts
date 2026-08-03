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

async function waitForRecoveryRefresh(stalledList: StalledCredentialList, harness: Harness): Promise<void> {
	const refresh = harness.session.modelRuntime.refresh({ allowNetwork: false });
	await vi.waitFor(() => expect(stalledList.getCallCount()).toBe(2));
	await refresh;
}

describe("issue #7301 stalled availability refresh", () => {
	let harness: Harness | undefined;
	let stalledList: StalledCredentialList | undefined;

	afterEach(() => {
		stalledList?.release();
		stalledList = undefined;
		harness?.cleanup();
		harness = undefined;
	});

	it("recovers without letting the stalled refresh overwrite the newer snapshot", async () => {
		harness = await createHarness({ withConfiguredAuth: false });
		const runtime = harness.session.modelRuntime;
		await harness.authStorage.modify("stale-provider", async () => ({ type: "api_key", key: "stale-key" }));
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProviderAuthStatus("stale-provider")).toEqual({ configured: true, source: "stored" });

		stalledList = stallNextCredentialList(harness);
		const staleRefresh = runtime.getAvailable();
		await stalledList.started;

		await harness.authStorage.delete("stale-provider");
		await harness.authStorage.modify("current-provider", async () => ({ type: "api_key", key: "current-key" }));
		await waitForRecoveryRefresh(stalledList, harness);
		expect(runtime.getProviderAuthStatus("stale-provider")).toEqual({ configured: false });
		expect(runtime.getProviderAuthStatus("current-provider")).toEqual({ configured: true, source: "stored" });

		stalledList.release();
		await staleRefresh;
		expect(runtime.getProviderAuthStatus("stale-provider")).toEqual({ configured: false });
		expect(runtime.getProviderAuthStatus("current-provider")).toEqual({ configured: true, source: "stored" });
	});

	it("does not let a stale failure overwrite newer availability error state", async () => {
		harness = await createHarness({ withConfiguredAuth: false });
		const runtime = harness.session.modelRuntime;
		stalledList = stallNextCredentialList(harness);
		const staleRefresh = runtime.getAvailable();
		await stalledList.started;

		await waitForRecoveryRefresh(stalledList, harness);
		expect(runtime.getError()).toBeUndefined();

		stalledList.fail(new Error("stale credential list failure"));
		await expect(staleRefresh).rejects.toThrow("stale credential list failure");
		expect(runtime.getError()).toBeUndefined();
	});
});
