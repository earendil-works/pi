import type { CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// Regression for earendil-works/pi#7301:
// forceRefreshAvailability() used to .then()-chain a new rebuild onto the
// pending one. If that pending refresh never settled, refresh() chained onto it
// never fired and the runtime was permanently stuck even after the cause
// cleared. A fresh independent rebuild must recover.

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A credential store whose list() can be made to hang, then released. read()
 * always resolves so ModelRuntime.create() (which triggers a refresh) succeeds.
 */
function createControllableStore(): {
	store: CredentialStore;
	setHang: (value: boolean) => void;
} {
	let hang = false;
	const store: CredentialStore = {
		read: async (providerId) => (providerId === "anthropic" ? { type: "api_key", key: "sk-test" } : undefined),
		delete: async () => {},
		modify: async (_providerId, fn) => fn(undefined),
		list: async () => {
			if (hang) await new Promise<never>(() => {});
			return [{ providerId: "anthropic", type: "api_key" }];
		},
	};
	return { store, setHang: (value) => (hang = value) };
}

describe("model-runtime availability recovery (#7301)", () => {
	it("recovers via refresh() after an availability rebuild stalls and the cause clears", async () => {
		const { store, setHang } = createControllableStore();
		const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false });

		// Start a rebuild that cannot finish (list() hangs), leaving a pending
		// availabilityRefresh behind, exactly as the report describes.
		setHang(true);
		const stalled = runtime.getAvailable();
		const stalledSettled = Promise.race([stalled.then(() => true), sleep(200).then(() => false)]);
		expect(await stalledSettled).toBe(false);

		// Cause removed. A forced refresh must start a fresh rebuild rather than
		// chaining onto the stuck promise, so it settles.
		setHang(false);
		const recovered = await Promise.race([
			runtime.refresh({ allowNetwork: false }).then(() => true),
			sleep(3000).then(() => false),
		]);
		expect(recovered).toBe(true);

		// And availability reads work again.
		const available = await Promise.race([
			runtime.getAvailable().then(() => true),
			sleep(3000).then(() => false),
		]);
		expect(available).toBe(true);
	});
});
