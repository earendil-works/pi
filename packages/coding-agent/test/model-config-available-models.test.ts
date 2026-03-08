import { describe, expect, it, vi } from "vitest";

describe("getAvailableModels", () => {
	it("skips models whose credential lookup throws and still returns other available models", async () => {
		vi.resetModules();

		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => ["anthropic", "openai"],
			getModels: (provider: string) => {
				if (provider === "anthropic") {
					return [
						{
							id: "claude-sonnet-4-20250514",
							name: "Claude Sonnet 4",
							api: "anthropic-messages",
							provider: "anthropic",
							baseUrl: "https://api.anthropic.com/v1",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8192,
						},
					];
				}

				return [
					{
						id: "gpt-4o-mini",
						name: "GPT-4o mini",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://api.openai.com/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 16384,
					},
				];
			},
			getApiKey: (provider: string) => (provider === "openai" ? "test-openai-key" : undefined),
		}));

		vi.doMock("../../ai/src/utils/oauth/index.js", () => ({
			getOAuthApiKey: async () => null,
			getOAuthProviderForModelProvider: (provider: string) => (provider === "anthropic" ? "anthropic" : undefined),
			loadOAuthCredentials: () => null,
		}));

		vi.doMock("fs", async () => {
			const actual = await vi.importActual<typeof import("fs")>("fs");
			return {
				...actual,
				existsSync: () => false,
			};
		});

		const { getAvailableModels } = await import("../src/model-config.js");
		const result = await getAvailableModels();

		expect(result.error).toBeNull();
		expect(result.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["openai/gpt-4o-mini"]);
	});
});
