import { InMemoryModelsStore, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { type BoundedRefreshResult, ModelRuntime } from "../../../src/core/model-runtime.ts";
import { formatModelRefreshWarning } from "../../../src/modes/interactive/model-refresh-status.ts";
import { allowNetwork } from "../../test-network-env.ts";

async function createStalledRuntime(modelRefreshTimeoutMs: number) {
	allowNetwork();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		modelRefreshTimeoutMs,
	});
	let inflightRefresh: Promise<void> | undefined;
	let releaseRefresh = () => {};
	const refreshModels = vi.fn(({ allowNetwork, signal }: RefreshModelsContext) => {
		if (!allowNetwork) return Promise.resolve();
		inflightRefresh ??= new Promise<void>((resolve) => {
			releaseRefresh = resolve;
			if (signal?.aborted) resolve();
			else signal?.addEventListener("abort", () => resolve(), { once: true });
		}).finally(() => {
			inflightRefresh = undefined;
		});
		return inflightRefresh;
	});
	const provider: Provider = {
		id: "stalled-login",
		name: "Stalled Login",
		auth: {
			apiKey: {
				name: "API key",
				login: async () => ({ type: "api_key", key: "secret" }),
				check: async ({ credential }) => (credential?.key ? { type: "api_key", source: "stored key" } : undefined),
				resolve: async ({ credential }) => ({
					auth: { apiKey: credential?.key ?? "ambient-key" },
					source: credential?.key ? "stored key" : "ambient key",
				}),
			},
		},
		getModels: () => [],
		refreshModels,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
	runtime.registerNativeProvider(provider);
	await runtime.refresh({ allowNetwork: false });
	return { refreshModels, releaseRefresh: () => releaseRefresh(), runtime };
}

describe("issues #7027 and #7113 credential refresh hang", () => {
	it("lets the login interaction cancel a stalled catalog refresh after saving credentials", async () => {
		const { refreshModels, runtime } = await createStalledRuntime(60_000);
		const controller = new AbortController();
		const notify = vi.fn();
		let refreshResult: BoundedRefreshResult | undefined;
		const login = runtime.login(
			"stalled-login",
			"api_key",
			{
				signal: controller.signal,
				prompt: vi.fn(),
				notify,
			},
			(result) => {
				refreshResult = result;
			},
		);

		await vi.waitFor(() => {
			expect(refreshModels.mock.calls.some(([context]) => context.allowNetwork)).toBe(true);
		});
		expect(notify).toHaveBeenCalledWith({ type: "progress", message: "Refreshing model catalogs…" });
		controller.abort();

		await expect(login).resolves.toMatchObject({ type: "api_key", key: "secret" });
		expect(refreshResult).toMatchObject({ aborted: true, timedOut: false });
	});

	it("bounds login when it joins an older signal-less catalog refresh", async () => {
		const { refreshModels, releaseRefresh, runtime } = await createStalledRuntime(200);
		void runtime.refresh();
		await vi.waitFor(() => {
			expect(refreshModels.mock.calls.some(([context]) => context.allowNetwork)).toBe(true);
		});

		let refreshResult: BoundedRefreshResult | undefined;
		await runtime.login("stalled-login", "api_key", { prompt: vi.fn(), notify: vi.fn() }, (result) => {
			refreshResult = result;
		});

		expect(refreshResult).toMatchObject({ aborted: true, timedOut: true });
		releaseRefresh();
	});

	it("bounds runtime API-key refreshes when a catalog stalls", async () => {
		const { refreshModels, runtime } = await createStalledRuntime(200);

		await expect(runtime.setRuntimeApiKey("stalled-login", "secret")).resolves.toBeUndefined();
		expect(refreshModels.mock.calls.some(([context]) => context.allowNetwork && context.signal?.aborted)).toBe(true);
	});

	it("bounds all credential mutations when an availability check stalls", async () => {
		allowNetwork();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			modelRefreshTimeoutMs: 200,
		});
		let releaseCheck = () => {};
		const checkGate = new Promise<void>((resolve) => {
			releaseCheck = resolve;
		});
		const provider: Provider = {
			id: "stalled-check",
			name: "Stalled Check",
			auth: {
				apiKey: {
					name: "API key",
					login: async () => ({ type: "api_key", key: "secret" }),
					check: async ({ credential }) => {
						await checkGate;
						return credential?.key ? { type: "api_key", source: "stored key" } : undefined;
					},
					resolve: async ({ credential }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "stored key" } : undefined,
				},
			},
			getModels: () => [],
			refreshModels: async () => {},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		runtime.registerNativeProvider(provider);

		let refreshResult: BoundedRefreshResult | undefined;
		const credential = await runtime.login(
			"stalled-check",
			"api_key",
			{ prompt: vi.fn(), notify: vi.fn() },
			(result) => {
				refreshResult = result;
			},
		);

		expect(credential).toMatchObject({ type: "api_key", key: "secret" });
		expect(refreshResult).toMatchObject({ aborted: true, timedOut: true });
		await expect(
			runtime.setRuntimeApiKey("stalled-check", "runtime-secret", { allowNetwork: false }),
		).resolves.toBeUndefined();
		await expect(runtime.removeRuntimeApiKey("stalled-check")).resolves.toBeUndefined();
		await expect(runtime.logout("stalled-check")).resolves.toBeUndefined();
		releaseCheck();
		await expect(runtime.getAvailable()).resolves.toEqual([]);
		expect(runtime.hasConfiguredAuth("stalled-check")).toBe(false);
	});

	it("warns that the post-login catalog refresh did not finish", () => {
		const settled: BoundedRefreshResult = { aborted: false, timedOut: false, errors: new Map() };
		expect(formatModelRefreshWarning({ ...settled, aborted: true, timedOut: true }, "using cached models.")).toBe(
			"Model refresh timed out; using cached models.",
		);
		expect(
			formatModelRefreshWarning(
				{ ...settled, errors: new Map([["deepseek", new Error("unreachable")]]) },
				"using cached models.",
			),
		).toBe("Could not refresh deepseek; using cached models.");
		expect(formatModelRefreshWarning(settled, "using cached models.")).toBeUndefined();
	});
});
