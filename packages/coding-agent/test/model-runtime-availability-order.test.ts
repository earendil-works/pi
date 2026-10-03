import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function testProvider(id: string, isConfigured: () => boolean, onCheck: () => void = () => {}): Provider {
	const model: Model<"openai-completions"> = {
		id: `${id}-model`,
		name: `${id} model`,
		api: "openai-completions",
		provider: id,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const unused = () => {
		throw new Error("unused");
	};
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				check: async () => {
					onCheck();
					return isConfigured() ? { type: "api_key", source: "test" } : undefined;
				},
				resolve: async () => (isConfigured() ? { auth: { apiKey: "key" }, source: "test" } : undefined),
			},
		},
		getModels: () => [model],
		stream: unused,
		streamSimple: unused,
	};
}

/** Hold the `n`th credentials.list() call from now; each availability pass makes exactly one. */
function holdCredentialListCall(
	credentials: AuthStorage,
	n: number,
): { calls: () => number; started: Promise<void>; release: () => void } {
	const list = credentials.list.bind(credentials);
	let calls = 0;
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	credentials.list = async (options) => {
		calls++;
		if (calls !== n) return list(options);
		markStarted();
		await gate;
		return list(options);
	};
	return { calls: () => calls, started, release };
}

async function createRuntime(credentials: AuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}

describe("availability passes", () => {
	// Regression for #8810 and #9884: startup awaits a pass while a registration requests another one.
	it("resolves an awaited request from its own pass while a later request waits", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await createRuntime(credentials);
		let configured = false;
		runtime.registerNativeProvider(testProvider("dynamic", () => configured));
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(false);

		configured = true;
		const later = holdCredentialListCall(credentials, 2);
		const awaited = runtime.getAvailable();
		await vi.waitFor(() => expect(later.calls()).toBe(1));
		const laterPass = runtime.getAvailable();

		await awaited;
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);

		later.release();
		await laterPass;
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
	});

	// Regression for #8810: a login during a full pass must not lose the login or the rest of the pass.
	it("runs a login check after a running full pass and keeps both results", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await createRuntime(credentials);
		let dynamicConfigured = false;
		let dynamicChecks = 0;
		let otherConfigured = false;
		runtime.registerNativeProvider(
			testProvider(
				"dynamic",
				() => dynamicConfigured,
				() => dynamicChecks++,
			),
		);
		runtime.registerNativeProvider(testProvider("other", () => otherConfigured));
		await runtime.refresh({ allowNetwork: false });

		otherConfigured = true;
		const fullPass = holdCredentialListCall(credentials, 1);
		const checksBefore = dynamicChecks;
		const running = runtime.getAvailable();
		await fullPass.started;
		// The full pass has read "dynamic" as not configured.
		await vi.waitFor(() => expect(dynamicChecks).toBeGreaterThan(checksBefore));

		dynamicConfigured = true;
		const login = runtime.refresh({ allowNetwork: false, providers: ["dynamic"] });
		fullPass.release();
		await running;
		await login;
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
		expect(runtime.hasConfiguredAuth("other")).toBe(true);
	});

	it("shares one waiting pass between requests made while another pass runs", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await createRuntime(credentials);
		const running = holdCredentialListCall(credentials, 1);
		const first = runtime.getAvailable();
		await running.started;

		const waiting = [runtime.getAvailable(), runtime.getAvailable(), runtime.getAvailable()];
		running.release();
		await Promise.all([first, ...waiting]);
		expect(running.calls()).toBe(2);
	});

	it("keeps a registration's provisional entry when a pass that started earlier finishes", async () => {
		const credentials = AuthStorage.inMemory({ dynamic: { type: "api_key", key: "stored" } });
		const runtime = await createRuntime(credentials);

		const olderPass = holdCredentialListCall(credentials, 1);
		const olderFullPass = runtime.getAvailable();
		await olderPass.started;
		runtime.registerNativeProvider(testProvider("dynamic", () => true));
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);

		// The older pass did not check "dynamic"; the registration's own pass is still queued.
		olderPass.release();
		await olderFullPass;
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
	});
});
