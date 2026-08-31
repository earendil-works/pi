import { afterEach, describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalMeliousApiKey = process.env.MELIOUS_API_KEY;

afterEach(() => {
	if (originalMeliousApiKey === undefined) {
		delete process.env.MELIOUS_API_KEY;
	} else {
		process.env.MELIOUS_API_KEY = originalMeliousApiKey;
	}
});

describe("Melious models", () => {
	it("registers the default GLM-5.1 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("melious", "glm-5.1");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("melious");
		expect(model.baseUrl).toBe("https://api.melious.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(203000);
		expect(model.maxTokens).toBe(203000);
		expect(model.cost).toEqual({
			input: 1.521,
			output: 4.68,
			cacheRead: 0.3744,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
			thinkingFormat: "openai",
		});
	});

	it("exposes only the low, medium and high efforts Melious documents", () => {
		// Melious takes reasoning_effort low|medium|high on every reasoning model and returns the
		// reasoning in reasoning_content. An explicit "none" silences some models and is ignored by
		// others, so no off level is offered.
		const expectedThinkingLevelMap = {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		};

		for (const modelId of ["glm-5.1", "kimi-k3", "deepseek-v4-pro"] as const) {
			expect(getModel("melious", modelId).thinkingLevelMap).toEqual(expectedThinkingLevelMap);
		}

		const nonReasoning = getModel("melious", "qwen3-coder-next");
		expect(nonReasoning.reasoning).toBe(false);
		expect(nonReasoning.thinkingLevelMap).toBeUndefined();
		expect(nonReasoning.compat?.supportsReasoningEffort).toBe(false);
		expect(nonReasoning.compat?.thinkingFormat).toBeUndefined();
	});

	it("keeps the Melious reasoning contract on its DeepSeek V4 models", () => {
		// Melious serves DeepSeek V4 through the same gateway contract as everything else, so the
		// DeepSeek-specific thinking format and effort levels must not be applied here.
		for (const modelId of ["deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731"] as const) {
			const model = getModel("melious", modelId);
			expect(model.compat?.thinkingFormat).toBe("openai");
			expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
			expect(model.thinkingLevelMap).toMatchObject({ low: "low", medium: "medium", high: "high", max: null });
		}
	});

	it("marks image input only for models Melious accepts images on", () => {
		expect(getModel("melious", "mistral-small-3.2-24b-instruct").input).toEqual(["text", "image"]);
		expect(getModel("melious", "kimi-k2.6").input).toEqual(["text", "image"]);
		expect(getModel("melious", "glm-5.2").input).toEqual(["text"]);
	});

	it("registers a tool-capable chat catalog served from the European endpoint", () => {
		const models = getModels("melious");

		expect(models.length).toBe(42);
		expect(models.every((model) => model.api === "openai-completions")).toBe(true);
		expect(models.every((model) => model.baseUrl === "https://api.melious.ai/v1")).toBe(true);
		expect(models.every((model) => model.contextWindow > 0 && model.maxTokens > 0)).toBe(true);
		expect(models.every((model) => model.compat?.supportsDeveloperRole === false)).toBe(true);
	});

	it("omits models Melious advertises but does not serve", () => {
		// Every one of these returns provider_error, invalid_request_error or model_not_found for a
		// plain completion. They are excluded in scripts/generate-models.ts until the endpoint serves
		// them again; see MELIOUS_UNAVAILABLE_MODEL_IDS there.
		const unavailable = [
			"deepseek-v3.1",
			"gpt-oss-20b",
			"llama-3.3-70b-instruct",
			"mistral-medium-3.5-128b",
			"nemotron-3-super-120b-a12b",
			"qwen3-32b",
			"qwen3-vl-235b-a22b-instruct",
			"qwen3.8-max",
		];
		const ids = new Set(getModels("melious").map((model) => model.id));

		expect(unavailable.filter((id) => ids.has(id))).toEqual([]);
	});

	it("resolves MELIOUS_API_KEY from the environment", () => {
		process.env.MELIOUS_API_KEY = "test-melious-key";

		expect(findEnvKeys("melious")).toEqual(["MELIOUS_API_KEY"]);
		expect(getEnvApiKey("melious")).toBe("test-melious-key");
	});
});
