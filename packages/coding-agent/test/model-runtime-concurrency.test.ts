import {
	type CredentialStore,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: `https://${provider}.test/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function nativeProvider(
	id: string,
	models: () => readonly Model<"openai-completions">[],
	overrides: Partial<Provider<"openai-completions">> = {},
): Provider<"openai-completions"> {
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: `${id} key`,
				check: async ({ credential }) =>
					credential?.key ? { type: "api_key", source: `${id}:${credential.key}` } : undefined,
				resolve: async ({ credential }) =>
					credential?.key ? { auth: { apiKey: credential.key }, source: `${id}:${credential.key}` } : undefined,
			},
		},
		getModels: models,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
		...overrides,
	};
}

function nativeOAuthProvider(
	id: string,
	models: () => readonly Model<"openai-completions">[],
): Provider<"openai-completions"> {
	return nativeProvider(id, models, {
		auth: {
			oauth: {
				name: `${id} OAuth`,
				login: async () => {
					throw new Error("unused");
				},
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	});
}

async function runtime(credentials: CredentialStore = AuthStorage.inMemory()): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
	await vi.waitFor(assertion, { timeout: 2_000, interval: 5 });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ModelRuntime atomic publication", () => {
	it("serializes refresh owners, preserves options, and promptly skips queued and pre-aborted work", async () => {
		const modelRuntime = await runtime(AuthStorage.inMemory({ fifo: { type: "api_key", key: "key" } }));
		let active = 0;
		let maxActive = 0;
		const seen: Array<boolean | undefined> = [];
		let gate: Deferred | undefined;
		let started: Deferred | undefined;
		modelRuntime.registerNativeProvider(
			nativeProvider("fifo", () => [model("fifo", "one")], {
				refreshModels: async ({ force }) => {
					active++;
					maxActive = Math.max(maxActive, active);
					seen.push(force);
					started?.resolve();
					try {
						await gate?.promise;
					} finally {
						active--;
					}
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.refresh({ allowNetwork: false });
		await waitFor(() => expect(active).toBe(0));
		seen.length = 0;
		gate = deferred();
		started = deferred();

		const first = modelRuntime.refresh({ allowNetwork: false, force: true });
		await started.promise;
		const queuedAbort = new AbortController();
		const second = modelRuntime.refresh({ allowNetwork: false, force: false, signal: queuedAbort.signal });
		const third = modelRuntime.refresh({ allowNetwork: false, force: false });
		queuedAbort.abort();
		await expect(second).resolves.toMatchObject({ aborted: true });
		expect(active).toBe(1);

		const preAborted = new AbortController();
		preAborted.abort();
		await expect(modelRuntime.refresh({ allowNetwork: false, signal: preAborted.signal })).resolves.toMatchObject({
			aborted: true,
		});
		expect(active).toBe(1);
		gate.resolve();
		await Promise.all([first, third]);

		expect(maxActive).toBe(1);
		expect(seen).toEqual([true, false]);
	});

	it("continues FIFO work after an owner rejects", async () => {
		const modelRuntime = await runtime();
		modelRuntime.registerNativeProvider(
			nativeProvider("owner-failure", () => [model("owner-failure", "one")], {
				auth: {
					apiKey: {
						name: "failing login",
						login: async () => {
							throw new Error("owner failed");
						},
						resolve: async () => undefined,
					},
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		const first = modelRuntime.login("owner-failure", "api_key", { prompt: async () => "unused", notify: () => {} });
		const second = modelRuntime.refresh({ allowNetwork: false });
		await expect(first).rejects.toThrow("owner failed");
		await expect(second).resolves.toMatchObject({ aborted: false });
	});

	it("reads each provider credential once while inspecting a refresh candidate", async () => {
		const base = new InMemoryCredentialStore();
		await base.modify("read-once", async () => ({ type: "api_key", key: "key" }));
		let reads = 0;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				if (providerId === "read-once") reads++;
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const modelRuntime = await runtime(credentials);
		modelRuntime.registerNativeProvider(nativeProvider("read-once", () => [model("read-once", "one")]));
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.refresh({ allowNetwork: false });
		reads = 0;

		await modelRuntime.refresh({ allowNetwork: false });

		expect(reads).toBe(1);
	});

	it("resolves request auth live without running request-time auth during refresh or availability reads", async () => {
		const modelRuntime = await runtime();
		let key = "first";
		let resolutions = 0;
		modelRuntime.registerNativeProvider(
			nativeProvider("live-auth", () => [model("live-auth", "one")], {
				auth: {
					apiKey: {
						name: "live key",
						check: async () => ({ type: "api_key", source: "available" }),
						resolve: async () => {
							resolutions++;
							return { auth: { apiKey: key }, source: key };
						},
					},
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.getAvailable();
		expect(modelRuntime.getProviderAuthStatus("live-auth")).toMatchObject({ configured: true });
		expect(resolutions).toBe(0);

		expect((await modelRuntime.getAuth("live-auth"))?.auth.apiKey).toBe("first");
		key = "second";
		expect((await modelRuntime.getAuth("live-auth"))?.auth.apiKey).toBe("second");
		expect(resolutions).toBe(2);
	});

	it("reads externally mutated credentials live against one published provider view", async () => {
		const credentials = AuthStorage.inMemory();
		const modelRuntime = await runtime(credentials);
		modelRuntime.registerNativeProvider(nativeProvider("external-auth", () => [model("external-auth", "one")]));

		expect(modelRuntime.hasConfiguredAuth("external-auth")).toBe(false);
		expect(modelRuntime.getProviderAuthStatus("external-auth")).toEqual({ configured: false });
		expect(await modelRuntime.checkAuth("external-auth")).toBeUndefined();

		await credentials.modify("external-auth", async () => ({ type: "api_key", key: "live" }));

		expect(modelRuntime.hasConfiguredAuth("external-auth")).toBe(false);
		expect(modelRuntime.getProviderAuthStatus("external-auth")).toEqual({ configured: false });
		expect(await modelRuntime.checkAuth("external-auth")).toEqual({
			type: "api_key",
			source: "external-auth:live",
		});

		await credentials.delete("external-auth");

		expect(modelRuntime.hasConfiguredAuth("external-auth")).toBe(false);
		expect(modelRuntime.getProviderAuthStatus("external-auth")).toEqual({ configured: false });
		expect(await modelRuntime.checkAuth("external-auth")).toBeUndefined();
	});

	it("keeps a complete old catalog view through refresh while checkAuth reads credentials live", async () => {
		const credentials = AuthStorage.inMemory({ staged: { type: "api_key", key: "A" } });
		const modelRuntime = await runtime(credentials);
		let version = "A";
		let refreshGate: Deferred | undefined;
		modelRuntime.registerNativeProvider(
			nativeProvider("staged", () => [model("staged", version)], {
				refreshModels: async () => {
					if (refreshGate) {
						version = "B";
						await refreshGate.promise;
					}
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.refresh({ allowNetwork: false });
		const oldProvider = modelRuntime.getProvider("staged");
		expect(oldProvider?.getModels().map((entry) => entry.id)).toEqual(["A"]);
		expect((await modelRuntime.checkAuth("staged"))?.source).toBe("staged:A");

		await credentials.modify("staged", async () => ({ type: "api_key", key: "B" }));
		refreshGate = deferred();
		const refreshing = modelRuntime.refresh({ allowNetwork: false });
		await waitFor(() => expect(version).toBe("B"));

		// Published catalog stays on the pre-refresh snapshot while work is in flight.
		expect(modelRuntime.getModels("staged").map((entry) => entry.id)).toEqual(["A"]);
		expect(modelRuntime.getModel("staged", "A")).toBeDefined();
		expect(modelRuntime.getModel("staged", "B")).toBeUndefined();
		expect(oldProvider?.getModels().map((entry) => entry.id)).toEqual(["A"]);
		expect((await modelRuntime.checkAuth("staged"))?.source).toBe("staged:B");

		refreshGate.resolve();
		await refreshing;
		expect(modelRuntime.getModels("staged").map((entry) => entry.id)).toEqual(["B"]);
		expect(
			modelRuntime
				.getProvider("staged")
				?.getModels()
				.map((entry) => entry.id),
		).toEqual(["B"]);
		expect((await modelRuntime.checkAuth("staged"))?.source).toBe("staged:B");
		// Captured pre-refresh provider views remain frozen; object identity is not promised.
		expect(oldProvider?.getModels().map((entry) => entry.id)).toEqual(["A"]);
	});

	it("publishes a direct Provider.refreshModels call without mutating its captured view", async () => {
		const modelRuntime = await runtime(AuthStorage.inMemory({ direct: { type: "api_key", key: "key" } }));
		let current = [model("direct", "A")];
		let publishB = false;
		modelRuntime.registerNativeProvider(
			nativeProvider("direct", () => current, {
				refreshModels: async () => {
					if (publishB) current = [model("direct", "B")];
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		const captured = modelRuntime.getProvider("direct");
		expect(captured?.getModels().map((entry) => entry.id)).toEqual(["A"]);
		publishB = true;

		await captured?.refreshModels?.({
			allowNetwork: false,
			credential: { type: "api_key", key: "key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
		});

		expect(modelRuntime.getModels("direct").map((entry) => entry.id)).toEqual(["B"]);
		expect(captured?.getModels().map((entry) => entry.id)).toEqual(["A"]);
	});

	it("publishes successful catalogs and a failed provider's restored cache as one candidate", async () => {
		const credentials = AuthStorage.inMemory({
			success: { type: "api_key", key: "key" },
			failure: { type: "api_key", key: "key" },
		});
		const stores = new InMemoryModelsStore();
		await stores.write("failure", { models: [model("failure", "cached-A")] });
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsStore: stores,
			modelsPath: null,
			allowModelNetwork: false,
		});
		let successModels = [model("success", "old")];
		let failureModels = [model("failure", "old")];
		modelRuntime.registerNativeProvider(
			nativeProvider("success", () => successModels, {
				refreshModels: async ({ allowNetwork }) => {
					if (allowNetwork) successModels = [model("success", "new-B")];
				},
			}),
		);
		modelRuntime.registerNativeProvider(
			nativeProvider("failure", () => failureModels, {
				refreshModels: async ({ allowNetwork, store }) => {
					if (allowNetwork) {
						failureModels = [model("failure", "unpublished-X")];
						throw new Error("network failed");
					}
					failureModels = [...((await store.read())?.models ?? [])] as Array<Model<"openai-completions">>;
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });

		const result = await modelRuntime.refresh({ allowNetwork: true });

		expect(result.errors.get("failure")?.message).toBe("network failed");
		expect(modelRuntime.getModels("success").map((entry) => entry.id)).toEqual(["new-B"]);
		expect(modelRuntime.getModels("failure").map((entry) => entry.id)).toEqual(["cached-A"]);
		expect(
			modelRuntime
				.getProvider("success")
				?.getModels()
				.map((entry) => entry.id),
		).toEqual(["new-B"]);
		expect(
			modelRuntime
				.getProvider("failure")
				?.getModels()
				.map((entry) => entry.id),
		).toEqual(["cached-A"]);
	});

	it("discards an aborted candidate even when its provider and store already changed", async () => {
		const credentials = AuthStorage.inMemory({ abortable: { type: "api_key", key: "key" } });
		const stores = new InMemoryModelsStore();
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsStore: stores,
			modelsPath: null,
			allowModelNetwork: false,
		});
		let current = [model("abortable", "A")];
		let abortDuringRefresh: AbortController | undefined;
		modelRuntime.registerNativeProvider(
			nativeProvider("abortable", () => current, {
				refreshModels: async ({ store }) => {
					if (!abortDuringRefresh) return;
					current = [model("abortable", "B")];
					await store.write({ models: current });
					abortDuringRefresh.abort();
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		const oldProvider = modelRuntime.getProvider("abortable");
		abortDuringRefresh = new AbortController();

		const result = await modelRuntime.refresh({ allowNetwork: true, signal: abortDuringRefresh.signal });

		expect(result.aborted).toBe(true);
		// Aborted candidates must not publish; store side effects may already exist.
		expect(modelRuntime.getModels("abortable").map((entry) => entry.id)).toEqual(["A"]);
		expect(
			modelRuntime
				.getProvider("abortable")
				?.getModels()
				.map((entry) => entry.id),
		).toEqual(["A"]);
		expect(oldProvider?.getModels().map((entry) => entry.id)).toEqual(["A"]);
		expect((await stores.read("abortable"))?.models.map((entry) => entry.id)).toEqual(["B"]);
	});

	it("publishes synchronous registration immediately and prevents an older refresh from overwriting it", async () => {
		const modelRuntime = await runtime(AuthStorage.inMemory({ slow: { type: "api_key", key: "key" } }));
		const gate = deferred();
		let block = false;
		modelRuntime.registerNativeProvider(
			nativeProvider("slow", () => [model("slow", "A")], {
				refreshModels: async () => {
					if (block) await gate.promise;
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.refresh({ allowNetwork: false });
		block = true;
		const stale = modelRuntime.refresh({ allowNetwork: false });
		await Promise.resolve();
		modelRuntime.registerProvider("instant", {
			baseUrl: "https://instant.test/v1",
			apiKey: "key",
			api: "openai-completions",
			models: [model("instant", "B")],
		});

		expect(modelRuntime.getModel("instant", "B")).toBeDefined();
		expect(
			modelRuntime
				.getProvider("instant")
				?.getModels()
				.map((entry) => entry.id),
		).toEqual(["B"]);
		expect(modelRuntime.hasConfiguredAuth("instant")).toBe(true);
		gate.resolve();
		await expect(stale).resolves.toMatchObject({ aborted: true });
		await waitFor(() => expect(modelRuntime.getModel("instant", "B")).toBeDefined());
		expect(modelRuntime.getModels("instant").map((entry) => entry.id)).toEqual(["B"]);
	});

	it("merges model headers with configured headers", async () => {
		const modelRuntime = await runtime();
		modelRuntime.registerProvider("configured-headers", {
			baseUrl: "https://configured-headers.test/v1",
			apiKey: "key",
			api: "openai-completions",
			models: [
				{
					...model("configured-headers", "model"),
					headers: { "x-configured": "configured", "x-shared": "configured" },
				},
			],
		});
		const configured = modelRuntime.getModel("configured-headers", "model");
		expect(configured).toBeDefined();

		const auth = await modelRuntime.getAuth({
			...configured!,
			headers: { "x-model": "model", "x-shared": "model" },
		});

		expect(auth?.auth.headers).toEqual({
			"x-model": "model",
			"x-shared": "configured",
			"x-configured": "configured",
		});
	});

	it("recovers convergence after a transient owner failure when a newer registration arrives", async () => {
		const base = new InMemoryCredentialStore();
		let failNextList = false;
		const failedListStarted = deferred();
		const releaseFailedList = deferred();
		const credentials: CredentialStore = {
			read: (providerId) => base.read(providerId),
			list: async () => {
				if (failNextList) {
					failNextList = false;
					failedListStarted.resolve();
					await releaseFailedList.promise;
					throw new Error("transient convergence failure");
				}
				return base.list();
			},
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const modelRuntime = await runtime(credentials);
		failNextList = true;
		modelRuntime.registerProvider("first", {
			baseUrl: "https://first.test/v1",
			apiKey: "key",
			api: "openai-completions",
			models: [model("first", "one")],
		});
		await failedListStarted.promise;
		modelRuntime.registerProvider("second", {
			baseUrl: "https://second.test/v1",
			apiKey: "key",
			api: "openai-completions",
			models: [model("second", "two")],
		});
		releaseFailedList.resolve();
		await waitFor(() => expect(modelRuntime.getError() ?? "").not.toContain("transient convergence failure"));
		expect(modelRuntime.getModel("first", "one")).toBeDefined();
		expect(modelRuntime.getModel("second", "two")).toBeDefined();
	});

	it("bounds self-triggered convergence churn and accepts a later recovery registration", async () => {
		const modelRuntime = await runtime(AuthStorage.inMemory({ churn: { type: "api_key", key: "key" } }));
		let churn = true;
		let refreshes = 0;
		const churnProvider = nativeProvider("churn", () => [model("churn", "stable")], {
			refreshModels: async () => {
				refreshes++;
				if (churn) modelRuntime.registerNativeProvider(churnProvider);
			},
		});

		modelRuntime.registerNativeProvider(churnProvider);
		await waitFor(() => expect(modelRuntime.getError()).toContain("convergence"));
		// Public contract: self-triggered churn is bounded; exact attempt count is private.
		expect(refreshes).toBeGreaterThan(0);
		expect(refreshes).toBeLessThan(50);
		churn = false;
		modelRuntime.registerProvider("recovery", {
			baseUrl: "https://recovery.test/v1",
			apiKey: "key",
			api: "openai-completions",
			models: [model("recovery", "works")],
		});
		await waitFor(() => expect(modelRuntime.getError() ?? "").not.toContain("convergence"));
		expect(modelRuntime.getModel("recovery", "works")).toBeDefined();
	});

	it("retries a failed global availability read for the same published state", async () => {
		const base = new InMemoryCredentialStore();
		await base.modify("retry", async () => ({ type: "api_key", key: "key" }));
		let failNextRead = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				if (providerId === "retry" && failNextRead) {
					failNextRead = false;
					throw new Error("transient availability read");
				}
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const modelRuntime = await runtime(credentials);
		modelRuntime.registerNativeProvider(nativeProvider("retry", () => [model("retry", "ready")]));
		await modelRuntime.refresh({ allowNetwork: false });
		failNextRead = true;

		await expect(modelRuntime.getAvailable()).rejects.toThrow("transient availability read");
		await expect(modelRuntime.getAvailable()).resolves.toContainEqual(model("retry", "ready"));
		expect(modelRuntime.getError()).toBeUndefined();
	});

	it("preserves stored API-key auth through a compatible same-provider overlay", async () => {
		const modelRuntime = await runtime(
			AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-anthropic" } }),
		);
		const original = modelRuntime.getModels("anthropic");
		expect(original.length).toBeGreaterThan(0);

		modelRuntime.registerProvider("anthropic", { baseUrl: "https://proxy.test/v1" });

		expect(modelRuntime.getProviderAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		expect(modelRuntime.hasConfiguredAuth("anthropic")).toBe(true);
		expect((await modelRuntime.checkAuth("anthropic"))?.type).toBe("api_key");
		expect(modelRuntime.getAvailableSnapshot()).toHaveLength(original.length);
		expect((await modelRuntime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-anthropic");
	});

	it("preserves an unchanged configured provider when another provider is registered", async () => {
		const modelRuntime = await runtime(
			AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-anthropic" } }),
		);
		modelRuntime.registerProvider("anthropic", { baseUrl: "https://first-proxy.test/v1" });
		await modelRuntime.refresh({ allowNetwork: false });
		const available = modelRuntime.getAvailableSnapshot().filter((entry) => entry.provider === "anthropic");

		modelRuntime.registerProvider("unrelated", {
			baseUrl: "https://unrelated.test/v1",
			apiKey: "unrelated-key",
			api: "openai-completions",
			models: [model("unrelated", "one")],
		});

		expect(modelRuntime.getProviderAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		expect((await modelRuntime.checkAuth("anthropic"))?.type).toBe("api_key");
		expect(modelRuntime.getAvailableSnapshot().filter((entry) => entry.provider === "anthropic")).toEqual(available);
		expect((await modelRuntime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-anthropic");
	});

	it("immediately projects compatible stored credentials onto native provider replacements", async () => {
		const credentials = AuthStorage.inMemory({
			"native-api-key": { type: "api_key", key: "native-key" },
			"native-oauth": {
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: Date.now() + 60_000,
			},
		});
		const modelRuntime = await runtime(credentials);
		modelRuntime.registerNativeProvider(nativeProvider("native-api-key", () => [model("native-api-key", "first")]));
		modelRuntime.registerNativeProvider(nativeOAuthProvider("native-oauth", () => [model("native-oauth", "first")]));
		await modelRuntime.refresh({ allowNetwork: false });

		modelRuntime.registerNativeProvider(
			nativeProvider("native-api-key", () => [model("native-api-key", "replacement")]),
		);
		modelRuntime.registerNativeProvider(
			nativeOAuthProvider("native-oauth", () => [model("native-oauth", "replacement")]),
		);

		expect(modelRuntime.getProviderAuthStatus("native-api-key")).toEqual({ configured: true, source: "stored" });
		expect(modelRuntime.getProviderAuthStatus("native-oauth")).toEqual({ configured: true, source: "stored" });
		expect((await modelRuntime.checkAuth("native-api-key"))?.type).toBe("api_key");
		expect((await modelRuntime.checkAuth("native-oauth"))?.type).toBe("oauth");
		expect((await modelRuntime.getAuth("native-api-key"))?.auth.apiKey).toBe("native-key");
		expect((await modelRuntime.getAuth("native-oauth"))?.auth.apiKey).toBe("oauth-access");
	});

	it("immediately fails closed when configured API-key auth replaces stored OAuth", async () => {
		const modelRuntime = await runtime(
			AuthStorage.inMemory({
				"oauth-to-configured-key": {
					type: "oauth",
					access: "oauth-access",
					refresh: "oauth-refresh",
					expires: Date.now() + 60_000,
				},
				"refresh-owner": { type: "api_key", key: "owner-key" },
			}),
		);
		const refreshStarted = deferred();
		const releaseRefresh = deferred();
		let blockRefresh = false;
		modelRuntime.registerNativeProvider(
			nativeOAuthProvider("oauth-to-configured-key", () => [model("oauth-to-configured-key", "oauth")]),
		);
		modelRuntime.registerNativeProvider(
			nativeProvider("refresh-owner", () => [model("refresh-owner", "owner")], {
				refreshModels: async () => {
					if (!blockRefresh) return;
					refreshStarted.resolve();
					await releaseRefresh.promise;
				},
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.refresh({ allowNetwork: false });
		blockRefresh = true;
		const staleRefresh = modelRuntime.refresh({ allowNetwork: false });
		await refreshStarted.promise;

		modelRuntime.registerProvider("oauth-to-configured-key", {
			baseUrl: "https://oauth-to-configured-key.test/v1",
			apiKey: "configured-key",
			api: "openai-completions",
			models: [model("oauth-to-configured-key", "api-key")],
		});

		expect(modelRuntime.hasConfiguredAuth("oauth-to-configured-key")).toBe(false);
		expect(await modelRuntime.checkAuth("oauth-to-configured-key")).toBeUndefined();
		expect(modelRuntime.getProviderAuthStatus("oauth-to-configured-key")).toEqual({ configured: false });
		expect(modelRuntime.getAvailableSnapshot().some((entry) => entry.provider === "oauth-to-configured-key")).toBe(
			false,
		);
		expect(await modelRuntime.getAuth("oauth-to-configured-key")).toBeUndefined();

		releaseRefresh.resolve();
		await expect(staleRefresh).resolves.toMatchObject({ aborted: true });
		await modelRuntime.refresh({ allowNetwork: false });

		modelRuntime.registerProvider("unrelated-after-convergence", {
			baseUrl: "https://unrelated-after-convergence.test/v1",
			apiKey: "unrelated-key",
			api: "openai-completions",
			models: [model("unrelated-after-convergence", "one")],
		});

		expect(modelRuntime.hasConfiguredAuth("oauth-to-configured-key")).toBe(false);
		expect(await modelRuntime.checkAuth("oauth-to-configured-key")).toBeUndefined();
		expect(modelRuntime.getProviderAuthStatus("oauth-to-configured-key")).toEqual({ configured: false });
		expect(modelRuntime.getAvailableSnapshot().some((entry) => entry.provider === "oauth-to-configured-key")).toBe(
			false,
		);
		expect(await modelRuntime.getAuth("oauth-to-configured-key")).toBeUndefined();
	});

	it("fails closed across incompatible provider replacements and removal", async () => {
		const credentials = AuthStorage.inMemory({
			"oauth-to-key": {
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 60_000,
			},
			"key-to-oauth": { type: "api_key", key: "stored-key" },
		});
		const modelRuntime = await runtime(credentials);
		modelRuntime.registerNativeProvider(nativeOAuthProvider("oauth-to-key", () => [model("oauth-to-key", "oauth")]));
		modelRuntime.registerNativeProvider(nativeProvider("key-to-oauth", () => [model("key-to-oauth", "api-key")]));
		await modelRuntime.refresh({ allowNetwork: false });
		expect(modelRuntime.isUsingOAuth("oauth-to-key")).toBe(true);
		expect(modelRuntime.isUsingOAuth("key-to-oauth")).toBe(false);

		modelRuntime.registerNativeProvider(nativeProvider("oauth-to-key", () => [model("oauth-to-key", "api-key")]));
		modelRuntime.registerNativeProvider(nativeOAuthProvider("key-to-oauth", () => [model("key-to-oauth", "oauth")]));
		for (const providerId of ["oauth-to-key", "key-to-oauth"]) {
			expect(modelRuntime.hasConfiguredAuth(providerId)).toBe(false);
			expect(modelRuntime.getProviderAuthStatus(providerId)).toEqual({ configured: false });
			expect(await modelRuntime.checkAuth(providerId)).toBeUndefined();
			expect(await modelRuntime.getAuth(providerId)).toBeUndefined();
		}
		expect(modelRuntime.getAvailableSnapshot().some((entry) => entry.provider === "oauth-to-key")).toBe(false);
		expect(modelRuntime.getAvailableSnapshot().some((entry) => entry.provider === "key-to-oauth")).toBe(false);

		modelRuntime.unregisterProvider("oauth-to-key");
		expect(modelRuntime.getProvider("oauth-to-key")).toBeUndefined();
		expect(modelRuntime.hasConfiguredAuth("oauth-to-key")).toBe(false);
		expect(modelRuntime.getProviderAuthStatus("oauth-to-key")).toEqual({ configured: false });
		expect(await modelRuntime.checkAuth("oauth-to-key")).toBeUndefined();
		expect(modelRuntime.getAvailableSnapshot().some((entry) => entry.provider === "oauth-to-key")).toBe(false);
	});

	it("keeps scoped availability independent from an unrelated blocked global read", async () => {
		const base = new InMemoryCredentialStore();
		await base.modify("scoped", async () => ({ type: "api_key", key: "key" }));
		await base.modify("blocked", async () => ({ type: "api_key", key: "key" }));
		const blocked = deferred<Awaited<ReturnType<CredentialStore["read"]>>>();
		let blockGlobal = false;
		const credentials: CredentialStore = {
			read: (providerId) => (blockGlobal && providerId === "blocked" ? blocked.promise : base.read(providerId)),
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const modelRuntime = await runtime(credentials);
		modelRuntime.registerNativeProvider(nativeProvider("scoped", () => [model("scoped", "ready")]));
		modelRuntime.registerNativeProvider(nativeProvider("blocked", () => [model("blocked", "wait")]));
		await modelRuntime.refresh({ allowNetwork: false });
		await modelRuntime.refresh({ allowNetwork: false });
		blockGlobal = true;
		const globalReadStarted = deferred();
		const originalRead = credentials.read;
		credentials.read = async (providerId) => {
			if (providerId === "blocked") globalReadStarted.resolve();
			return originalRead(providerId);
		};
		const global = modelRuntime.getAvailable();
		await globalReadStarted.promise;

		await expect(modelRuntime.getAvailable("scoped")).resolves.toEqual([model("scoped", "ready")]);
		blocked.reject(new Error("unrelated failure"));
		await expect(global).rejects.toThrow("unrelated failure");
		await expect(modelRuntime.getAvailable("scoped")).resolves.toEqual([model("scoped", "ready")]);
	});

	it("publishes login, logout, and runtime API-key changes only with their refresh transaction", async () => {
		const modelRuntime = await runtime();
		let gate: Deferred | undefined;
		modelRuntime.registerNativeProvider(
			nativeProvider("mutations", () => [model("mutations", "one")], {
				auth: {
					apiKey: {
						name: "mutation key",
						login: async () => ({ type: "api_key", key: "login-key" }),
						check: async ({ credential }) =>
							credential?.key ? { type: "api_key", source: credential.key } : undefined,
						resolve: async ({ credential }) =>
							credential?.key ? { auth: { apiKey: credential.key }, source: credential.key } : undefined,
					},
				},
				refreshModels: async () => gate?.promise,
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false });
		gate = deferred();

		const login = modelRuntime.login("mutations", "api_key", { prompt: async () => "unused", notify: () => {} });
		await Promise.resolve();
		expect(modelRuntime.hasConfiguredAuth("mutations")).toBe(false);
		gate.resolve();
		await login;
		expect((await modelRuntime.checkAuth("mutations"))?.source).toBe("login-key");

		gate = deferred();
		const logout = modelRuntime.logout("mutations");
		await Promise.resolve();
		expect(modelRuntime.hasConfiguredAuth("mutations")).toBe(true);
		gate.resolve();
		await logout;
		expect(modelRuntime.hasConfiguredAuth("mutations")).toBe(false);

		gate = deferred();
		const setKey = modelRuntime.setRuntimeApiKey("mutations", "runtime-key", { allowNetwork: false });
		await Promise.resolve();
		expect(modelRuntime.hasConfiguredAuth("mutations")).toBe(false);
		gate.resolve();
		await setKey;
		expect((await modelRuntime.checkAuth("mutations"))?.source).toBe("runtime-key");

		gate = deferred();
		const removeKey = modelRuntime.removeRuntimeApiKey("mutations");
		await Promise.resolve();
		expect(modelRuntime.hasConfiguredAuth("mutations")).toBe(true);
		gate.resolve();
		await removeKey;
		expect(modelRuntime.hasConfiguredAuth("mutations")).toBe(false);
	});
});
