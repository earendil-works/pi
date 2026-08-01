import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinModels } from "../src/providers/all.ts";
import { clinePassProvider } from "../src/providers/cline-pass.ts";

const originalClineApiKey = process.env.CLINE_API_KEY;

afterEach(() => {
	if (originalClineApiKey === undefined) {
		delete process.env.CLINE_API_KEY;
	} else {
		process.env.CLINE_API_KEY = originalClineApiKey;
	}
});

describe("ClinePass models", () => {
	it("registers subscription models via the OpenAI-compatible Chat Completions API", () => {
		const model = getModel("cline-pass", "cline-pass/glm-5.2");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("cline-pass");
		expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsReasoningEffort: false,
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
			thinkingFormat: "openrouter",
		});
	});

	it("carries the remaining catalog models with models.dev pricing", () => {
		const kimiK3 = getModel("cline-pass", "cline-pass/kimi-k3");
		expect(kimiK3.input).toEqual(["text", "image"]);
		expect(kimiK3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		expect(kimiK3.contextWindow).toBe(1048576);

		const qwenPlus = getModel("cline-pass", "cline-pass/qwen3.7-plus");
		expect(qwenPlus.input).toEqual(["text", "image"]);
		expect(qwenPlus.cost).toEqual({ input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 });
		expect(qwenPlus.contextWindow).toBe(1000000);

		const mimo = getModel("cline-pass", "cline-pass/mimo-v2.5");
		expect(mimo.input).toEqual(["text", "image"]);
		expect(mimo.cost).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });
	});

	it("models the ClinePass DeepSeek lanes with deepseek-v4 thinking semantics", () => {
		const model = getModel("cline-pass", "cline-pass/deepseek-v4-pro");
		expect(model.cost).toEqual({ input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 });
		expect(model.compat).toMatchObject({
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
		});
	});

	it("registers all ClinePass models on the built-in provider", () => {
		const models = builtinModels();
		const clinePassModels = models.getModels("cline-pass");
		expect(clinePassModels.length).toBe(11);
		expect(clinePassModels.every((m) => m.provider === "cline-pass")).toBe(true);
		expect(clinePassModels.every((m) => m.api === "openai-completions")).toBe(true);
	});

	it("exposes the ClinePass provider factory with CLINE_API_KEY auth", () => {
		const provider = clinePassProvider();
		expect(provider.id).toBe("cline-pass");
		expect(provider.name).toBe("ClinePass");
		expect(provider.baseUrl).toBe("https://api.cline.bot/api/v1");
		expect(provider.getModels().length).toBe(11);
	});

	it("resolves CLINE_API_KEY from the environment", () => {
		process.env.CLINE_API_KEY = "test-cline-key";

		expect(findEnvKeys("cline-pass")).toEqual(["CLINE_API_KEY"]);
		expect(getEnvApiKey("cline-pass")).toBe("test-cline-key");
	});
});
