import { describe, expect, it, vi } from "vitest";

describe("model-config: runtime provider registrations", () => {
	it("overlays runtime provider models and can unregister by sourceId", async () => {
		vi.resetModules();

		vi.doMock("os", () => ({
			homedir: () => "/tmp/mu-home-runtime-provider-registry",
		}));

		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => ["openai"],
			getModels: () => [
				{
					id: "gpt-4o",
					name: "GPT-4o (built-in)",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 4096,
				},
			],
			getApiKey: () => "built-in-key",
		}));

		const { loadAndMergeModels, registerRuntimeProvider, unregisterRuntimeProvidersBySourceId } = await import(
			"../src/model-config.js"
		);

		// Sanity: built-in shows up
		const before = loadAndMergeModels();
		expect(before.error).toBeNull();
		expect(before.models.find((m) => m.provider === "openai" && m.id === "gpt-4o")?.name).toBe("GPT-4o (built-in)");

		registerRuntimeProvider(
			"openai",
			{
				baseUrl: "https://example.com/v1",
				apiKey: "RUNTIME_OPENAI_KEY",
				api: "openai-responses",
				headers: { "X-Test": "1" },
				models: [
					{
						id: "gpt-4o",
						name: "GPT-4o (runtime override)",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 10,
					},
				],
			},
			{ sourceId: "ext:test", priority: 10 },
		);

		const after = loadAndMergeModels();
		expect(after.error).toBeNull();
		const overridden = after.models.filter((m) => m.provider === "openai" && m.id === "gpt-4o");
		expect(overridden.length).toBe(1);
		expect(overridden[0]?.name).toBe("GPT-4o (runtime override)");
		expect(overridden[0]?.baseUrl).toBe("https://example.com/v1");
		expect(overridden[0]?.headers).toEqual({ "X-Test": "1" });

		unregisterRuntimeProvidersBySourceId("ext:test");

		const final = loadAndMergeModels();
		expect(final.error).toBeNull();
		expect(final.models.find((m) => m.provider === "openai" && m.id === "gpt-4o")?.name).toBe("GPT-4o (built-in)");
	});

	it("uses runtime provider apiKey config before built-in getApiKey", async () => {
		vi.resetModules();

		process.env.RUNTIME_OPENAI_KEY = "runtime-key";

		vi.doMock("os", () => ({
			homedir: () => "/tmp/mu-home-runtime-provider-registry-2",
		}));

		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => ["openai"],
			getModels: () => [
				{
					id: "gpt-4o",
					name: "GPT-4o (built-in)",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 4096,
				},
			],
			getApiKey: () => "built-in-key",
		}));

		const { getApiKeyForModel, registerRuntimeProvider } = await import("../src/model-config.js");

		registerRuntimeProvider(
			"openai",
			{
				baseUrl: "https://example.com/v1",
				apiKey: "RUNTIME_OPENAI_KEY",
				api: "openai-responses",
				models: [
					{
						id: "gpt-4o",
						name: "GPT-4o (runtime)",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 10,
					},
				],
			},
			{ sourceId: "ext:test" },
		);

		const key = await getApiKeyForModel({ provider: "openai" } as never);
		expect(key).toBe("runtime-key");
	});
});
