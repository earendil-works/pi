import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { ApiKeyAuth, CredentialStore, OAuthAuth, OAuthCredential, ProviderAuth } from "../src/auth/types.ts";
import { calculateCost, createModels, createProvider, hasApi, type Provider } from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions, Usage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function testModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "test-api",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

function doneMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface ProviderCall {
	model: Model<Api>;
	options: StreamOptions | undefined;
}

/** Ambient auth for keyless test providers; reports "configured" with no auth values. */
const ambientAuth: ApiKeyAuth = {
	name: "Ambient",
	resolve: async () => ({ auth: {} }),
};

function testProvider(input: {
	id: string;
	models?: Model<Api>[];
	auth?: ProviderAuth;
	getModels?: () => readonly Model<Api>[];
	refreshModels?: Provider["refreshModels"];
	calls?: ProviderCall[];
}): Provider {
	const models = input.models ?? [testModel(input.id, "model-a")];
	const respond = (model: Model<Api>, options: StreamOptions | undefined) => {
		input.calls?.push({ model, options });
		const stream = new AssistantMessageEventStream();
		const message = doneMessage(model, "ok");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	return {
		id: input.id,
		name: input.id,
		auth: input.auth ?? { apiKey: ambientAuth },
		getModels: input.getModels ?? (() => models),
		refreshModels: input.refreshModels,
		stream: (model, _context, options) => respond(model, options as StreamOptions | undefined),
		streamSimple: (model, _context, options) => respond(model, options as SimpleStreamOptions | undefined),
	};
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

function envKeyAuth(key: string | undefined): ApiKeyAuth {
	return {
		name: "Test API key",
		resolve: async ({ credential }) => {
			const resolved = credential?.key ?? key;
			if (!resolved) return undefined;
			return { auth: { apiKey: resolved }, source: credential ? "stored" : "env" };
		},
	};
}

function testOAuth(overrides?: Partial<OAuthAuth>): OAuthAuth {
	return {
		name: "Test OAuth",
		login: async () => {
			throw new Error("not used");
		},
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({ apiKey: credential.access }),
		...overrides,
	};
}

describe("Models runtime", () => {
	it("enumerates credential metadata without exposing secrets", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("api-provider", async () => ({ type: "api_key", key: "secret" }));
		await credentials.modify("oauth-provider", async () => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 60_000,
		}));

		expect(await credentials.list()).toEqual([
			{ providerId: "api-provider", type: "api_key" },
			{ providerId: "oauth-provider", type: "oauth" },
		]);
	});

	it("applies request-wide pricing tiers above the configured input threshold", () => {
		const model = testModel("openai", "gpt-5.6-sol");
		model.cost = {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [
				{
					inputTokensAbove: 272000,
					input: 10,
					output: 45,
					cacheRead: 1,
					cacheWrite: 12.5,
				},
			],
		};
		const createUsage = (cacheWrite: number): Usage => ({
			input: 200000,
			output: 100000,
			cacheRead: 72000,
			cacheWrite,
			totalTokens: 372000 + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		const short = calculateCost(model, createUsage(0));
		expect(short).toMatchObject({ input: 1, output: 3, cacheRead: 0.036, cacheWrite: 0 });

		const long = calculateCost(model, createUsage(1));
		expect(long.input).toBe(2);
		expect(long.output).toBe(4.5);
		expect(long.cacheRead).toBe(0.072);
		expect(long.cacheWrite).toBe(0.0000125);
	});

	it("registers, replaces, and deletes providers", () => {
		const models = createModels();
		models.setProvider(testProvider({ id: "p1" }));
		models.setProvider(testProvider({ id: "p2" }));
		expect(models.getProviders().map((p) => p.id)).toEqual(["p1", "p2"]);

		const replacement = testProvider({ id: "p1" });
		models.setProvider(replacement);
		expect(models.getProvider("p1")).toBe(replacement);
		expect(models.getProviders()).toHaveLength(2);

		models.deleteProvider("p1");
		expect(models.getProvider("p1")).toBeUndefined();

		models.clearProviders();
		expect(models.getProviders()).toHaveLength(0);
	});

	it("lists and finds models per provider", async () => {
		const models = createModels();
		models.setProvider(testProvider({ id: "p1", models: [testModel("p1", "m1"), testModel("p1", "m2")] }));
		models.setProvider(testProvider({ id: "p2", models: [testModel("p2", "m3")] }));

		expect(models.getModels().map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
		expect(models.getModels("p1").map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(models.getModels("nope").length).toBe(0);
		expect(models.getModel("p2", "m3")?.id).toBe("m3");
		expect(models.getModel("p2", "missing")).toBeUndefined();

		// hasApi() narrows dynamically looked-up models with a runtime check
		const found = models.getModel("p2", "m3");
		expect(found && hasApi(found, "openai-completions")).toBe(false);
		expect(found && hasApi(found, "test-api")).toBe(true);
		if (found && hasApi(found, "test-api")) {
			const _typed: Model<"test-api"> = found;
			expect(_typed.id).toBe("m3");
		}
	});

	it("swallows provider source failures for both all-provider and single-provider listing", () => {
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "broken",
				getModels: () => {
					throw new Error("boom");
				},
			}),
		);
		models.setProvider(testProvider({ id: "ok", models: [testModel("ok", "m1")] }));

		expect(models.getModels().map((m) => m.id)).toEqual(["m1"]);
		expect(models.getModels("broken")).toEqual([]);
		// precise failures come from the provider directly
		expect(() => models.getProvider("broken")?.getModels()).toThrow("boom");
	});

	it("refresh() updates every configured dynamic provider and reports failures", async () => {
		let list = [testModel("dyn", "before")];
		let refreshes = 0;
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "dyn",
				getModels: () => list,
				refreshModels: async (refresh) => {
					if (!refresh.allowNetwork) return;
					refreshes++;
					await refresh.publish({
						update: () => {
							list = [testModel("dyn", "after")];
						},
					});
				},
			}),
		);
		models.setProvider(testProvider({ id: "static", models: [testModel("static", "s1")] }));

		expect(models.getModel("dyn", "before")).toBeDefined();
		const first = await models.refresh();
		expect(first.errors.size).toBe(0);
		expect(refreshes).toBe(1);
		expect(models.getModel("dyn", "after")).toBeDefined();
		expect(models.getModel("dyn", "before")).toBeUndefined();

		models.setProvider(
			testProvider({
				id: "flaky",
				refreshModels: async ({ allowNetwork }) => {
					if (allowNetwork) throw new Error("fetch failed");
				},
			}),
		);
		const second = await models.refresh();
		expect(refreshes).toBe(2);
		expect(second.errors.get("flaky")?.message).toBe("fetch failed");
	});

	it("restricts refresh work to selected providers", async () => {
		const calls: string[] = [];
		const models = createModels();
		for (const id of ["one", "two"]) {
			models.setProvider(
				testProvider({
					id,
					refreshModels: async ({ allowNetwork }) => {
						calls.push(`${id}:${allowNetwork ? "network" : "cache"}`);
					},
				}),
			);
		}

		const result = await models.refresh({ providers: ["two", "unknown"] });

		expect(result.errors.size).toBe(0);
		expect(calls).toEqual(["two:cache", "two:network"]);
	});

	it("restores cached models before waiting for network auth", async () => {
		const store = new InMemoryModelsStore();
		await store.write("dynamic", { models: [testModel("dynamic", "cached")] });
		let markAuthStarted: (() => void) | undefined;
		let finishAuth: (() => void) | undefined;
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		const blockedAuth = new Promise<void>((resolve) => {
			finishAuth = resolve;
		});
		const provider = createProvider({
			id: "dynamic",
			auth: {
				apiKey: {
					name: "Blocked auth",
					resolve: async () => {
						markAuthStarted?.();
						await blockedAuth;
						return { auth: { apiKey: "key" } };
					},
				},
			},
			models: [],
			fetchModels: async () => {
				throw new Error("must not fetch");
			},
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		const controller = new AbortController();
		const pending = models.refresh({ providers: ["dynamic"], signal: controller.signal });
		await authStarted;

		expect(models.getModel("dynamic", "cached")).toBeDefined();
		controller.abort();
		expect(await pending).toMatchObject({ aborted: true });
		finishAuth?.();
	});

	it("lets providers choose persistent deletion and ephemeral publication atomically", async () => {
		let entry: ModelsStoreEntry | undefined = { models: [testModel("dynamic", "stored")] };
		const store: ModelsStore = {
			read: async () => entry,
			write: async (_providerId, next) => {
				entry = next;
			},
			delete: async () => {
				entry = undefined;
			},
		};
		let state = "initial";
		const models = createModels({ modelsStore: store });
		models.setProvider(
			testProvider({
				id: "dynamic",
				refreshModels: async (context) => {
					expect(context.stored?.models[0]?.id).toBe("stored");
					await context.publish({
						persist: null,
						update: () => {
							expect(entry).toBeUndefined();
							state = "deleted";
						},
					});
					await context.publish({
						update: () => {
							state = "ephemeral";
						},
					});
				},
			}),
		);

		const result = await models.refresh({ allowNetwork: false });

		expect(result.errors.size).toBe(0);
		expect(entry).toBeUndefined();
		expect(state).toBe("ephemeral");
	});

	it("persists dynamic catalogs and restores them without network access", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		await credentials.modify("dynamic", async () => ({ type: "api_key", key: "key" }));
		const createDynamicProvider = (fetchModels: (() => Promise<readonly Model<Api>[]>) | undefined) =>
			createProvider({
				id: "dynamic",
				auth: { apiKey: envKeyAuth(undefined) },
				models: [],
				fetchModels: fetchModels ? () => fetchModels() : undefined,
				api: {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			});

		const online = createModels({ credentials, modelsStore });
		online.setProvider(createDynamicProvider(async () => [testModel("dynamic", "fetched")]));
		expect((await online.refresh()).errors.size).toBe(0);
		expect(online.getModel("dynamic", "fetched")).toBeDefined();

		const offline = createModels({ credentials, modelsStore });
		offline.setProvider(
			createDynamicProvider(async () => {
				throw new Error("must not fetch");
			}),
		);
		expect((await offline.refresh({ allowNetwork: false })).errors.size).toBe(0);
		expect(offline.getModel("dynamic", "fetched")).toBeDefined();
	});

	it("passes effective API-key credentials and refresh options while skipping unconfigured providers", async () => {
		let effectiveCredential: unknown;
		let forceRefresh: boolean | undefined;
		let unconfiguredRefreshes = 0;
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "configured",
				auth: { apiKey: envKeyAuth("ambient-key") },
				refreshModels: async (context) => {
					if (!context.allowNetwork) return;
					effectiveCredential = context.credential;
					forceRefresh = context.force;
				},
			}),
		);
		models.setProvider(
			testProvider({
				id: "unconfigured",
				auth: { apiKey: envKeyAuth(undefined) },
				refreshModels: async ({ allowNetwork }) => {
					if (allowNetwork) unconfiguredRefreshes++;
				},
			}),
		);

		await models.refresh({ force: true });
		expect(effectiveCredential).toEqual({ type: "api_key", key: "ambient-key", env: undefined });
		expect(forceRefresh).toBe(true);
		expect(unconfiguredRefreshes).toBe(0);
	});

	it("refreshes expired OAuth before refreshing models", async () => {
		const credentials = new InMemoryCredentialStore();
		let modelRefreshCredential: unknown;
		await credentials.modify("oauth-dynamic", async () => ({
			type: "oauth",
			access: "expired",
			refresh: "refresh",
			expires: 0,
		}));
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "oauth-dynamic",
				auth: {
					oauth: testOAuth({
						refresh: async () => ({
							type: "oauth",
							access: "fresh",
							refresh: "rotated",
							expires: Date.now() + 60_000,
						}),
					}),
				},
				refreshModels: async (context) => {
					if (context.allowNetwork) modelRefreshCredential = context.credential;
				},
			}),
		);

		expect((await models.refresh()).errors.size).toBe(0);
		expect(modelRefreshCredential).toMatchObject({ type: "oauth", access: "fresh", refresh: "rotated" });
		expect(await credentials.read("oauth-dynamic")).toMatchObject({ access: "fresh", refresh: "rotated" });
	});

	it("always gives providers a concrete signal", async () => {
		let receivedSignal: AbortSignal | undefined;
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "dynamic",
				refreshModels: async ({ signal }) => {
					receivedSignal = signal;
				},
			}),
		);

		const result = await models.refresh();
		expect(result.aborted).toBe(false);
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(receivedSignal?.aborted).toBe(false);
	});

	it("binds model-store waits to the provider refresh signal", async () => {
		const storageSignals: (AbortSignal | undefined)[] = [];
		const store: ModelsStore = {
			read: async (_providerId, options) => {
				storageSignals.push(options?.signal);
				return undefined;
			},
			write: async (_providerId, _entry, options) => {
				storageSignals.push(options?.signal);
			},
			delete: async (_providerId, options) => {
				storageSignals.push(options?.signal);
			},
		};
		let providerSignal: AbortSignal | undefined;
		const models = createModels({ modelsStore: store });
		models.setProvider(
			testProvider({
				id: "dynamic",
				auth: { apiKey: envKeyAuth("key") },
				refreshModels: async (context) => {
					providerSignal = context.signal;
					if (!context.allowNetwork) return;
					await context.publish({ persist: { models: [testModel("dynamic", "fresh")] } });
				},
			}),
		);

		const result = await models.refresh({ providers: ["dynamic"] });

		expect(result.errors.size).toBe(0);
		expect(storageSignals).toHaveLength(3);
		expect(storageSignals.every((signal) => signal === providerSignal)).toBe(true);
	});

	it("returns aborted state without reporting cancellation as a provider error", async () => {
		const controller = new AbortController();
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "dynamic",
				refreshModels: async ({ signal }) => {
					controller.abort();
					if (signal.aborted) return;
				},
			}),
		);

		const result = await models.refresh({ signal: controller.signal });
		expect(result.aborted).toBe(true);
		expect(result.errors.size).toBe(0);
	});

	it("stops waiting on abort when a provider ignores its signal", async () => {
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		let rejectRefresh: ((error: Error) => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const stalled = new Promise<void>((_resolve, reject) => {
			rejectRefresh = reject;
		});
		let calls = 0;
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "dynamic",
				refreshModels: async () => {
					calls++;
					if (calls !== 1) return;
					markStarted?.();
					await stalled;
				},
			}),
		);

		const pending = models.refresh({ signal: controller.signal });
		await started;
		controller.abort();

		const result = await pending;
		expect(result.aborted).toBe(true);
		expect(result.errors.size).toBe(0);

		rejectRefresh?.(new Error("late provider failure"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(result.errors.size).toBe(0);
	});

	it("rejects late publication from a superseded non-cooperative provider", async () => {
		const store = new InMemoryModelsStore();
		let state = "initial";
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstBlocked = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(
			testProvider({
				id: "dynamic",
				refreshModels: async (context) => {
					if (!context.allowNetwork) return;
					calls++;
					const current = calls;
					if (current === 1) {
						markFirstStarted?.();
						await firstBlocked;
					}
					const value = `generation-${current}`;
					await context.publish({
						persist: { models: [testModel("dynamic", value)] },
						update: () => {
							state = value;
						},
					});
				},
			}),
		);

		const first = models.refresh({ providers: ["dynamic"] });
		await firstStarted;
		const second = models.refresh({ providers: ["dynamic"] });
		await second;
		await first;
		finishFirst?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state).toBe("generation-2");
		expect((await store.read("dynamic"))?.models[0]?.id).toBe("generation-2");
	});

	it("passes caller signals to provider auth callbacks", async () => {
		const controller = new AbortController();
		const received: AbortSignal[] = [];
		const apiKey: ApiKeyAuth = {
			name: "Signal auth",
			login: async (interaction) => {
				received.push(interaction.signal);
				return { type: "api_key", key: "saved" };
			},
			check: async ({ signal }) => {
				received.push(signal);
				return { type: "api_key" };
			},
			resolve: async ({ signal }) => {
				received.push(signal);
				return { auth: { apiKey: "resolved" } };
			},
		};
		const models = createModels();
		models.setProvider(testProvider({ id: "p1", auth: { apiKey } }));

		await models.checkAuth("p1", { signal: controller.signal });
		await models.getAuth("p1", { signal: controller.signal });
		await models.login("p1", "api_key", {
			signal: controller.signal,
			prompt: async () => "unused",
			notify: () => {},
		});

		expect(received).toEqual([controller.signal, controller.signal, controller.signal]);
	});

	it("stops waiting for non-cooperative auth callbacks", async () => {
		let startCheck: (() => void) | undefined;
		let finishCheck: (() => void) | undefined;
		const checkStarted = new Promise<void>((resolve) => {
			startCheck = resolve;
		});
		const blockedCheck = new Promise<void>((resolve) => {
			finishCheck = resolve;
		});
		let startResolve: (() => void) | undefined;
		let finishResolve: (() => void) | undefined;
		const resolveStarted = new Promise<void>((resolve) => {
			startResolve = resolve;
		});
		const blockedResolve = new Promise<void>((resolve) => {
			finishResolve = resolve;
		});
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Blocked auth",
						check: async () => {
							startCheck?.();
							await blockedCheck;
							return { type: "api_key" };
						},
						resolve: async () => {
							startResolve?.();
							await blockedResolve;
							return { auth: { apiKey: "key" } };
						},
					},
				},
			}),
		);

		const availableController = new AbortController();
		const available = models.getAvailable(undefined, { signal: availableController.signal });
		await checkStarted;
		availableController.abort();
		await expect(available).rejects.toMatchObject({ name: "AbortError" });

		const authController = new AbortController();
		const auth = models.getAuth("p1", { signal: authController.signal });
		await resolveStarted;
		authController.abort();
		await expect(auth).rejects.toMatchObject({ name: "AbortError" });

		finishCheck?.();
		finishResolve?.();
	});

	it("cancels queued credential mutations without running them later", async () => {
		const credentials = new InMemoryCredentialStore();
		let finishFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		let secondRan = false;
		const first = credentials.modify("p1", async () => {
			await firstBlocked;
			return { type: "api_key", key: "first" };
		});
		const controller = new AbortController();
		const second = credentials.modify(
			"p1",
			async () => {
				secondRan = true;
				return { type: "api_key", key: "second" };
			},
			{ signal: controller.signal },
		);

		controller.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		finishFirst?.();
		await first;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(secondRan).toBe(false);
		expect(await credentials.read("p1")).toEqual({ type: "api_key", key: "first" });
	});

	it("passes cancellation to OAuth refresh and preserves the previous credential", async () => {
		const credentials = new InMemoryCredentialStore();
		const previous: OAuthCredential = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 };
		await credentials.modify("p1", async () => previous);
		let startRefresh: (() => void) | undefined;
		let finishRefresh: ((credential: typeof previous) => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			startRefresh = resolve;
		});
		const blockedRefresh = new Promise<typeof previous>((resolve) => {
			finishRefresh = resolve;
		});
		let receivedSignal: AbortSignal | undefined;
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						refresh: async (_credential, signal) => {
							receivedSignal = signal;
							startRefresh?.();
							return blockedRefresh;
						},
					}),
				},
			}),
		);
		const controller = new AbortController();
		const auth = models.getAuth("p1", { signal: controller.signal });
		await refreshStarted;
		controller.abort();

		await expect(auth).rejects.toMatchObject({ name: "AbortError" });
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(receivedSignal?.aborted).toBe(true);
		expect(receivedSignal?.reason).toBe(controller.signal.reason);
		finishRefresh?.({ ...previous, access: "new", expires: Date.now() + 60_000 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await credentials.read("p1")).toEqual(previous);
	});

	it("resolves auth: stored credential owns the provider, ambient only when nothing stored", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { apiKey: envKeyAuth("env-key"), oauth: testOAuth() } }));
		const model = testModel("p1", "model-a");

		// model and provider-id overloads resolve the same provider-scoped auth
		expect((await models.getAuth(model))?.auth.apiKey).toBe("env-key");
		expect((await models.getAuth(model.provider))?.auth.apiKey).toBe("env-key");
		expect((await models.getAuth(model, { apiKey: "explicit-key" }))?.auth.apiKey).toBe("explicit-key");

		// stored oauth credential (persisted via the single write path): beats ambient env
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "oauth-token",
			refresh: "r",
			expires: Date.now() + 10 * 60_000,
		}));
		const resolution = await models.getAuth(model.provider);
		expect(resolution?.auth.apiKey).toBe("oauth-token");
		expect(resolution?.source).toBe("OAuth");

		// stored api-key credential resolves through apiKey auth, beats env
		await credentials.modify("p1", async () => ({ type: "api_key", key: "stored-key" }));
		const apiKeyResolution = await models.getAuth(model.provider);
		expect(apiKeyResolution?.auth.apiKey).toBe("stored-key");
		expect(apiKeyResolution?.source).toBe("stored");
	});

	it("checks provider auth without refreshing OAuth and filters available models", async () => {
		const credentials = new InMemoryCredentialStore();
		let refreshes = 0;
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "ambient", auth: { apiKey: envKeyAuth("env-key") } }));
		models.setProvider(testProvider({ id: "missing", auth: { apiKey: envKeyAuth(undefined) } }));
		models.setProvider(
			testProvider({
				id: "oauth",
				auth: {
					oauth: testOAuth({
						refresh: async (credential) => {
							refreshes++;
							return credential;
						},
					}),
				},
			}),
		);
		await credentials.modify("oauth", async () => ({
			type: "oauth",
			access: "expired",
			refresh: "refresh",
			expires: 0,
		}));

		expect(await models.checkAuth("ambient")).toEqual({ source: "env", type: "api_key" });
		expect(await models.checkAuth("missing")).toBeUndefined();
		expect(await models.checkAuth("oauth")).toEqual({ source: "OAuth", type: "oauth" });
		expect(refreshes).toBe(0);
		expect((await models.getAvailable()).map((model) => model.provider)).toEqual(["ambient", "oauth"]);
		expect((await models.getAvailable("ambient")).map((model) => model.provider)).toEqual(["ambient"]);
	});

	it("runs provider login and logout through the credential store", async () => {
		const credentials = new InMemoryCredentialStore();
		const apiKey = envKeyAuth(undefined);
		apiKey.login = async () => ({ type: "api_key", key: "logged-in" });
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { apiKey } }));

		const credential = await models.login("p1", "api_key", {
			prompt: async () => "unused",
			notify: () => {},
		});
		expect(credential).toEqual({ type: "api_key", key: "logged-in" });
		expect(await credentials.read("p1")).toEqual(credential);

		await models.logout("p1");
		expect(await credentials.read("p1")).toBeUndefined();
	});

	it("a stored credential without a matching handler blocks ambient fallback", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		// provider has only apiKey auth, but an oauth credential is stored (stale config)
		models.setProvider(testProvider({ id: "p1", auth: { apiKey: envKeyAuth("env-key") } }));
		await credentials.modify("p1", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }));

		expect(await models.getAuth("p1")).toBeUndefined();
	});

	it("refreshes expired oauth credentials and persists the rotated credential", async () => {
		const credentials = new InMemoryCredentialStore();
		const oauth = testOAuth({
			refresh: async (credential) => ({ ...credential, access: "new-token", expires: Date.now() + 60 * 60_000 }),
		});
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth } }));
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "old-token",
			refresh: "r",
			expires: 0,
		}));

		const resolution = await models.getAuth("p1");
		expect(resolution?.auth.apiKey).toBe("new-token");
		expect(((await credentials.read("p1")) as { access: string }).access).toBe("new-token");
	});

	it("refreshes oauth credentials with less than five minutes remaining", async () => {
		const credentials = new InMemoryCredentialStore();
		const refresh = vi.fn(async (credential) => ({
			...credential,
			access: "new-token",
			expires: Date.now() + 60 * 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth: testOAuth({ refresh }) } }));
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "old-token",
			refresh: "r",
			expires: Date.now() + 60_000,
		}));

		expect((await models.getAuth("p1"))?.auth.apiKey).toBe("new-token");
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("honors a caller's longer OAuth minimum validity", async () => {
		const credentials = new InMemoryCredentialStore();
		const refresh = vi.fn(async (credential) => ({
			...credential,
			access: "new-token",
			expires: Date.now() + 60 * 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth: testOAuth({ refresh }) } }));
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "old-token",
			refresh: "r",
			expires: Date.now() + 10 * 60_000,
		}));

		expect((await models.getAuth("p1", { minOAuthValidityMs: 30 * 60_000 }))?.auth.apiKey).toBe("new-token");
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("rejects with code oauth when refresh fails, preserving the stored credential", async () => {
		const credentials = new InMemoryCredentialStore();
		const oauth = testOAuth({
			refresh: async () => {
				throw new Error("invalid_grant");
			},
		});
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth } }));
		await credentials.modify("p1", async () => ({ type: "oauth", access: "old", refresh: "r", expires: 0 }));

		await expect(models.getAuth("p1")).rejects.toMatchObject({ code: "oauth" });
		// credential preserved for retry / re-login
		expect(((await credentials.read("p1")) as { access: string }).access).toBe("old");
	});

	it("serializes concurrent OAuth refreshes through store.modify (no double refresh)", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => ({ type: "oauth", access: "old", refresh: "r1", expires: 0 }));

		let refreshes = 0;
		const oauth = testOAuth({
			refresh: async () => {
				refreshes++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { type: "oauth", access: `new-${refreshes}`, refresh: "r2", expires: Date.now() + 60 * 60_000 };
			},
		});
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth } }));
		const model = testModel("p1", "model-a");

		const [a, b] = await Promise.all([models.getAuth(model.provider), models.getAuth(model.provider)]);
		expect(refreshes).toBe(1);
		expect(a?.auth.apiKey).toBe("new-1");
		expect(b?.auth.apiKey).toBe("new-1");
	});

	it("valid oauth tokens resolve without touching modify", async () => {
		let modifies = 0;
		const base = new InMemoryCredentialStore();
		const credentials: CredentialStore = {
			read: (pid) => base.read(pid),
			list: () => base.list(),
			modify: (pid, fn) => {
				modifies++;
				return base.modify(pid, fn);
			},
			delete: (pid) => base.delete(pid),
		};
		await base.modify("p1", async () => ({
			type: "oauth",
			access: "valid",
			refresh: "r",
			expires: Date.now() + 10 * 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth: testOAuth() } }));

		expect((await models.getAuth("p1"))?.auth.apiKey).toBe("valid");
		expect(modifies).toBe(0);
	});

	it("wraps credential store failures in ModelsError", async () => {
		// read failure
		const readFailing: CredentialStore = {
			read: async () => {
				throw new Error("disk on fire");
			},
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		};
		const models = createModels({ credentials: readFailing });
		models.setProvider(testProvider({ id: "p1", auth: { apiKey: envKeyAuth("env-key") } }));
		await expect(models.getAuth("p1")).rejects.toMatchObject({ code: "auth" });

		// modify failure during refresh
		const modifyFailing: CredentialStore = {
			read: async () => ({ type: "oauth", access: "old", refresh: "r", expires: 0 }),
			list: async () => [{ providerId: "p1", type: "oauth" }],
			modify: async () => {
				throw new Error("disk on fire");
			},
			delete: async () => {},
		};
		const oauthModels = createModels({ credentials: modifyFailing });
		oauthModels.setProvider(testProvider({ id: "p1", auth: { oauth: testOAuth() } }));
		await expect(oauthModels.getAuth("p1")).rejects.toMatchObject({ code: "auth" });
	});

	it("keeps the underlying reason in wrapped oauth refresh errors", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => ({ type: "oauth", access: "old", refresh: "r", expires: 0 }));
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						refresh: async () => {
							throw new Error("token refresh failed (400): invalid_grant");
						},
					}),
				},
			}),
		);

		await expect(models.getAuth("p1")).rejects.toThrow(
			"OAuth refresh failed for p1: token refresh failed (400): invalid_grant",
		);
	});

	it("wraps api-key auth failures in ModelsError", async () => {
		const failing: ApiKeyAuth = {
			name: "Failing",
			resolve: async () => {
				throw new Error("nope");
			},
		};
		const models = createModels();
		models.setProvider(testProvider({ id: "p1", auth: { apiKey: failing } }));
		await expect(models.getAuth("p1")).rejects.toMatchObject({ code: "auth" });
	});

	it("uses explicit request api key and env during provider auth resolution", async () => {
		const calls: ProviderCall[] = [];
		const apiKey: ApiKeyAuth = {
			name: "Scoped",
			resolve: async ({ credential, ctx }) => {
				const account = credential?.env?.ACCOUNT_ID ?? (await ctx.env("ACCOUNT_ID"));
				if (!credential?.key || !account) return undefined;
				return {
					auth: { apiKey: credential.key, baseUrl: `https://example.test/${account}` },
					env: { ACCOUNT_ID: account },
				};
			},
		};
		const models = createModels();
		models.setProvider(testProvider({ id: "p1", auth: { apiKey }, calls }));
		const model = testModel("p1", "model-a");

		await models.completeSimple(model, context, { apiKey: "explicit-key", env: { ACCOUNT_ID: "acct" } });

		expect(calls[0].model.baseUrl).toBe("https://example.test/acct");
		expect(calls[0].options?.apiKey).toBe("explicit-key");
		expect(calls[0].options?.env).toEqual({ ACCOUNT_ID: "acct" });
	});

	it("merges resolved auth into stream options; explicit options win per field", async () => {
		const calls: ProviderCall[] = [];
		const apiKey: ApiKeyAuth = {
			name: "Test",
			resolve: async () => ({
				auth: {
					apiKey: "resolved-key",
					headers: { Authorization: "Bearer resolved-key", "x-a": "auth", "x-b": "auth" },
					baseUrl: "https://auth.test/v1",
				},
			}),
		};
		const models = createModels();
		models.setProvider(testProvider({ id: "p1", auth: { apiKey }, calls }));
		const model = testModel("p1", "model-a");

		const result = await models.completeSimple(model, context, {
			apiKey: "explicit-key",
			headers: { authorization: "Explicit token", "x-b": "explicit" },
		});
		expect(result.stopReason).toBe("stop");
		expect(calls).toHaveLength(1);
		expect(calls[0].options?.apiKey).toBe("explicit-key");
		expect(calls[0].options?.headers).toEqual({ authorization: "Explicit token", "x-a": "auth", "x-b": "explicit" });
		expect(calls[0].model.baseUrl).toBe("https://auth.test/v1");

		// without explicit options, resolved auth applies
		const result2 = await models.completeSimple(model, context);
		expect(result2.stopReason).toBe("stop");
		expect(calls[1].options?.apiKey).toBe("resolved-key");
	});

	it("adds model headers only for model auth and transforms assembled headers once", async () => {
		const calls: ProviderCall[] = [];
		const models = createModels();
		models.setProvider(testProvider({ id: "p1", auth: { apiKey: envKeyAuth("key") }, calls }));
		const model = testModel("p1", "model-a");
		model.headers = { "x-model": "model", "x-shared": "model" };

		expect((await models.getAuth("p1"))?.auth.headers).toBeUndefined();
		expect((await models.getAuth(model))?.auth.headers).toEqual({ "x-model": "model", "x-shared": "model" });

		let transforms = 0;
		await models.completeSimple(model, context, {
			headers: { "x-explicit": "explicit", "X-Shared": "explicit" },
			transformHeaders: async (headers) => {
				transforms++;
				expect(headers).toEqual({ "x-model": "model", "x-explicit": "explicit", "X-Shared": "explicit" });
				return { ...headers, "x-transformed": "yes" };
			},
		});

		expect(transforms).toBe(1);
		expect(calls[0].options?.headers).toEqual({
			"x-model": "model",
			"x-explicit": "explicit",
			"X-Shared": "explicit",
			"x-transformed": "yes",
		});
		expect(calls[0].options).not.toHaveProperty("transformHeaders");
	});

	it("produces an error stream for unknown providers instead of throwing", async () => {
		const models = createModels();
		const result = await models.completeSimple(testModel("ghost", "model-a"), context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unknown provider: ghost");
	});

	it("streams through the provider", async () => {
		const models = createModels();
		models.setProvider(testProvider({ id: "p1" }));
		const model = testModel("p1", "model-a");

		const events: string[] = [];
		const stream = models.streamSimple(model, context);
		for await (const event of stream) {
			events.push(event.type);
		}
		expect(events).toEqual(["start", "done"]);
		const message = await stream.result();
		expect(message.stopReason).toBe("stop");
	});
});
