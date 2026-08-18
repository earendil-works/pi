import type { ApiKeyCredential, Credential, CredentialStore, Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string): Model<"openai-completions"> {
	return {
		id: "dynamic",
		name: "Dynamic",
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function provider(
	id: string,
	options: {
		login?: () => Promise<ApiKeyCredential>;
		refreshModels?: Provider["refreshModels"];
	} = {},
): Provider<"openai-completions"> {
	const providerModel = model(id);
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				login: async () => options.login?.() ?? { type: "api_key", key: `${id}-key` },
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [providerModel],
		refreshModels: options.refreshModels,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

async function runtimeWithProvider(
	registered: Provider,
	credentials: AuthStorage = AuthStorage.inMemory(),
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(registered);
	await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
	return runtime;
}

describe("ModelRuntime credential synchronization", () => {
	it("publishes locally consistent availability before login and logout resolve", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(provider("dynamic"), credentials);

		await runtime.login("dynamic", "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
		expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toContain("dynamic");
		expect(await credentials.read("dynamic")).toEqual({ type: "api_key", key: "dynamic-key" });

		await runtime.logout("dynamic");
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "dynamic")).toBe(false);
		expect(await credentials.read("dynamic")).toBeUndefined();
	});

	it("orders same-provider credential operations through local synchronization", async () => {
		let markLoginStarted: (() => void) | undefined;
		let finishLogin: (() => void) | undefined;
		const loginStarted = new Promise<void>((resolve) => {
			markLoginStarted = resolve;
		});
		const blockedLogin = new Promise<void>((resolve) => {
			finishLogin = resolve;
		});
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("ordered", {
				login: async () => {
					markLoginStarted?.();
					await blockedLogin;
					return { type: "api_key", key: "ordered-key" };
				},
			}),
			credentials,
		);

		const login = runtime.login("ordered", "api_key", { prompt: async () => "unused", notify: () => {} });
		await loginStarted;
		const logout = runtime.logout("ordered");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await credentials.read("ordered")).toBeUndefined();

		finishLogin?.();
		await Promise.all([login, logout]);
		expect(await credentials.read("ordered")).toBeUndefined();
		expect(runtime.hasConfiguredAuth("ordered")).toBe(false);
	});

	it("allows different providers to run credential flows concurrently", async () => {
		let firstStarted: (() => void) | undefined;
		let secondStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const second = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			provider("one", {
				login: async () => {
					firstStarted?.();
					await blocked;
					return { type: "api_key", key: "one" };
				},
			}),
		);
		runtime.registerNativeProvider(
			provider("two", {
				login: async () => {
					secondStarted?.();
					await blocked;
					return { type: "api_key", key: "two" };
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });

		const one = runtime.login("one", "api_key", { prompt: async () => "unused", notify: () => {} });
		const two = runtime.login("two", "api_key", { prompt: async () => "unused", notify: () => {} });
		await Promise.all([first, second]);
		finish?.();
		await Promise.all([one, two]);
	});

	it("does not wait for unrelated provider availability during local synchronization", async () => {
		let stallUnrelated = false;
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(provider("target"));
		const unrelated = provider("unrelated");
		if (unrelated.auth.apiKey) {
			unrelated.auth.apiKey.check = async () => {
				if (stallUnrelated) await new Promise<void>(() => {});
				return undefined;
			};
		}
		runtime.registerNativeProvider(unrelated);
		await runtime.refresh({ allowNetwork: false, providers: ["target", "unrelated"] });
		stallUnrelated = true;

		await runtime.login("target", "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(runtime.hasConfiguredAuth("target")).toBe(true);
		await expect(runtime.refresh({ allowNetwork: false, providers: ["target"] })).resolves.toMatchObject({
			aborted: false,
		});
	});

	it("reports cancellation that occurs during provider-scoped availability", async () => {
		let blockAvailability = false;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const registered = provider("cancelled-availability");
		if (registered.auth.apiKey) {
			registered.auth.apiKey.check = async ({ credential }) => {
				if (blockAvailability) {
					markStarted?.();
					await new Promise<void>(() => {});
				}
				return credential ? { type: "api_key", source: "stored" } : undefined;
			};
		}
		const runtime = await runtimeWithProvider(registered);
		await runtime.setRuntimeApiKey(registered.id, "key");
		blockAvailability = true;
		const controller = new AbortController();
		const refresh = runtime.refresh({
			allowNetwork: false,
			providers: [registered.id],
			signal: controller.signal,
		});
		await started;
		controller.abort();

		await expect(refresh).resolves.toMatchObject({ aborted: true });
	});

	it("does not run network refresh inside the credential operation chain", async () => {
		const networkRefresh = vi.fn(async () => new Promise<void>(() => {}));
		const runtime = await runtimeWithProvider(
			provider("local-only", {
				refreshModels: async (context) => {
					if (context.allowNetwork) await networkRefresh();
				},
			}),
		);

		await runtime.login("local-only", "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(networkRefresh).not.toHaveBeenCalled();
		expect(runtime.hasConfiguredAuth("local-only")).toBe(true);
	});

	it("keeps provider-scoped refreshes from superseding unrelated providers", async () => {
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		let firstSignal: AbortSignal | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			provider("one", {
				refreshModels: async (context) => {
					if (!context.allowNetwork) return;
					firstSignal = context.signal;
					markStarted?.();
					await blocked;
				},
			}),
		);
		runtime.registerNativeProvider(provider("two"));
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });
		await runtime.setRuntimeApiKey("one", "one-key");
		await runtime.setRuntimeApiKey("two", "two-key");

		const first = runtime.refresh({ allowNetwork: true, providers: ["one"] });
		await started;
		await runtime.refresh({ allowNetwork: true, providers: ["two"] });
		expect(firstSignal?.aborted).toBe(false);

		finish?.();
		await first;
	});

	it("waits for a committed credential mutation to settle before reporting cancellation", async () => {
		let stored: Credential | undefined;
		let markCommitted: (() => void) | undefined;
		let finishMutation: (() => void) | undefined;
		const committed = new Promise<void>((resolve) => {
			markCommitted = resolve;
		});
		const mutationFinished = new Promise<void>((resolve) => {
			finishMutation = resolve;
		});
		const credentials: CredentialStore = {
			read: async () => stored,
			list: async () => (stored ? [{ providerId: "delayed-commit", type: stored.type }] : []),
			modify: async (_providerId, update) => {
				const next = await update(stored);
				if (next) stored = next;
				markCommitted?.();
				await mutationFinished;
				return stored;
			},
			delete: async () => {
				stored = undefined;
			},
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerNativeProvider(provider("delayed-commit"));
		await runtime.refresh({ allowNetwork: false, providers: ["delayed-commit"] });
		const controller = new AbortController();
		let settled = false;
		const login = runtime.login("delayed-commit", "api_key", {
			signal: controller.signal,
			prompt: async () => "unused",
			notify: () => {},
		});
		const outcome = login.then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		await committed;
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		finishMutation?.();
		await expect(outcome).resolves.toMatchObject({
			name: "CredentialSynchronizationError",
			credential: { type: "api_key", key: "delayed-commit-key" },
		});
		expect(stored).toEqual({ type: "api_key", key: "delayed-commit-key" });
	});

	it("reports a typed error when cancellation interrupts post-commit synchronization", async () => {
		let blockCacheRefresh = false;
		let markCacheRefreshStarted: (() => void) | undefined;
		const cacheRefreshStarted = new Promise<void>((resolve) => {
			markCacheRefreshStarted = resolve;
		});
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("cancelled-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && blockCacheRefresh) {
						markCacheRefreshStarted?.();
						await new Promise<void>(() => {});
					}
				},
			}),
			credentials,
		);
		blockCacheRefresh = true;
		const controller = new AbortController();
		const login = runtime.login("cancelled-sync", "api_key", {
			signal: controller.signal,
			prompt: async () => "unused",
			notify: () => {},
		});
		await cacheRefreshStarted;
		controller.abort();

		await expect(login).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "cancelled-sync",
			operation: "login",
			credential: { type: "api_key", key: "cancelled-sync-key" },
		});
		expect(await credentials.read("cancelled-sync")).toEqual({
			type: "api_key",
			key: "cancelled-sync-key",
		});
	});

	it("reports committed credentials when local synchronization fails", async () => {
		let failCacheRefresh = false;
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("broken-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && failCacheRefresh) throw new Error("cache restore failed");
				},
			}),
			credentials,
		);
		failCacheRefresh = true;

		const login = runtime.login("broken-sync", "api_key", { prompt: async () => "unused", notify: () => {} });
		await expect(login).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "broken-sync",
			operation: "login",
			credential: { type: "api_key", key: "broken-sync-key" },
		});
		await expect(login).rejects.toBeInstanceOf(CredentialSynchronizationError);
		expect(await credentials.read("broken-sync")).toEqual({ type: "api_key", key: "broken-sync-key" });
	});
});
