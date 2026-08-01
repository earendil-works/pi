import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinModels } from "../src/providers/all.ts";
import { clineProvider } from "../src/providers/cline.ts";

const originalClineApiKey = process.env.CLINE_API_KEY;

afterEach(() => {
	if (originalClineApiKey === undefined) {
		delete process.env.CLINE_API_KEY;
	} else {
		process.env.CLINE_API_KEY = originalClineApiKey;
	}
});

describe("Cline models", () => {
	it("registers the default Claude model via the OpenAI-compatible Chat Completions API", () => {
		const model = getModel("cline", "anthropic/claude-opus-5");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("cline");
		expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsReasoningEffort: false,
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
			thinkingFormat: "openrouter",
			cacheControlFormat: "anthropic",
		});
	});

	it("uses OpenRouter-style model ids for the remaining recommended gateway models", () => {
		const kimiK3 = getModel("cline", "moonshotai/kimi-k3");
		expect(kimiK3.api).toBe("openai-completions");
		expect(kimiK3.reasoning).toBe(true);
		expect(kimiK3.input).toEqual(["text", "image"]);
		expect(kimiK3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		expect(kimiK3.contextWindow).toBe(1048576);

		const glm52 = getModel("cline", "zai/glm-5.2");
		expect(glm52.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		expect(glm52.contextWindow).toBe(1000000);

		const grok45 = getModel("cline", "x-ai/grok-4.5");
		expect(grok45.cost).toEqual({ input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 });

		const gpt56 = getModel("cline", "openai/gpt-5.6-sol");
		expect(gpt56.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
	});

	it("marks free-tier models with zero cost", () => {
		for (const id of [
			"deepseek/deepseek-v4-flash",
			"cline-free/glm-5.2",
			"poolside/laguna-s-2.1:free",
			"stepfun/step-3.7-flash",
		] as const) {
			const model = getModel("cline", id);
			expect(model).toBeDefined();
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("models the Cline DeepSeek lane with deepseek-v4 thinking semantics", () => {
		const model = getModel("cline", "deepseek/deepseek-v4-flash");
		expect(model.compat).toMatchObject({
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
		});
	});

	it("registers all Cline models on the built-in provider", () => {
		const models = builtinModels();
		const clineModels = models.getModels("cline");
		expect(clineModels.length).toBe(9);
		expect(clineModels.every((m) => m.provider === "cline")).toBe(true);
		expect(clineModels.every((m) => m.api === "openai-completions")).toBe(true);
	});

	it("exposes the Cline provider factory with CLINE_API_KEY auth", () => {
		const provider = clineProvider();
		expect(provider.id).toBe("cline");
		expect(provider.name).toBe("Cline");
		expect(provider.baseUrl).toBe("https://api.cline.bot/api/v1");
		expect(provider.getModels().length).toBe(9);
	});

	it("resolves CLINE_API_KEY from the environment", () => {
		process.env.CLINE_API_KEY = "test-cline-key";

		expect(findEnvKeys("cline")).toEqual(["CLINE_API_KEY"]);
		expect(getEnvApiKey("cline")).toBe("test-cline-key");
	});
});
