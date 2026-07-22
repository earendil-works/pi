import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "extension-oauth",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("extension provider model lifecycle", () => {
	it("registers native pi-ai providers with their auth implementation", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const nativeModel = {
			...model("native"),
			provider: "extension-native",
			baseUrl: "https://fallback.test/v1",
		};
		const provider: Provider = {
			id: "extension-native",
			name: "Extension Native",
			auth: {
				apiKey: {
					name: "Native setup",
					login: async (interaction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "API key" }),
					}),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored native key" } : undefined,
					resolve: async ({ credential }) =>
						credential?.key
							? {
									auth: { apiKey: credential.key, baseUrl: "https://resolved.test/v1" },
									source: "stored native key",
								}
							: undefined,
				},
			},
			getModels: () => [nativeModel],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};

		runtime.registerNativeProvider(provider);
		const registry = new ModelRegistry(runtime);
		expect(registry.getProvider("extension-native")).toBe(provider);
		expect(registry.getRegisteredNativeProvider("extension-native")).toBe(provider);
		expect(registry.getRegisteredProviderIds()).toContain("extension-native");
		expect(registry.find("extension-native", "native")).toBeDefined();

		await runtime.login("extension-native", "api_key", {
			prompt: async () => "secret",
			notify: () => {},
		});
		expect(await registry.getProviderAuth("extension-native")).toMatchObject({
			auth: { apiKey: "secret", baseUrl: "https://resolved.test/v1" },
		});

		registry.unregisterProvider("extension-native");
		expect(registry.getProvider("extension-native")).toBeUndefined();
	});

	it("applies models.json overrides above native providers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-native-provider-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"extension-native": {
						modelOverrides: {
							native: { contextWindow: 4242 },
						},
					},
				},
			}),
		);
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: false,
			});
			const nativeModel = {
				...model("native"),
				provider: "extension-native",
				baseUrl: "https://native.test/v1",
			};
			runtime.registerNativeProvider({
				id: "extension-native",
				name: "Extension Native",
				auth: {
					apiKey: {
						name: "Native key",
						resolve: async () => ({ auth: { apiKey: "key" }, source: "native" }),
					},
				},
				getModels: () => [nativeModel],
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
			});

			expect(runtime.getModel("extension-native", "native")?.contextWindow).toBe(4242);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes refreshModels results without forcing ModelsStore persistence", async () => {
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("extension-dynamic", {
			baseUrl: "http://localhost:8080/v1",
			apiKey: "local",
			api: "openai-completions",
			refreshModels: async () => [
				{
					...model("live"),
					provider: "extension-dynamic",
					baseUrl: "http://localhost:8080/v1",
				},
			],
		});

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("extension-dynamic", "live")).toBeDefined();
		expect(await modelsStore.read("extension-dynamic")).toBeUndefined();
	});

	it("applies legacy OAuth modifyModels after async credential initialization", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"extension-oauth": {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("extension-oauth", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			models: [model("base")],
			oauth: {
				name: "Extension OAuth",
				login: async () => {
					throw new Error("not used");
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
				modifyModels: (models, credential) =>
					credential.access === "access" ? [...models, model("credential-model")] : models,
			},
		});

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("extension-oauth", "base")).toBeDefined();
		expect(runtime.getModel("extension-oauth", "credential-model")).toBeDefined();

		await runtime.logout("extension-oauth");
		expect(runtime.getModel("extension-oauth", "credential-model")).toBeUndefined();
	});
});
