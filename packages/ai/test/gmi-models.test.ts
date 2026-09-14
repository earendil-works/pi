import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { GMI_MODELS } from "../src/providers/gmi.models.ts";
import { gmiProvider } from "../src/providers/gmi.ts";

const GMI_BASE_URL = "https://api.gmi-serving.com/v1";

describe("GMI Cloud model catalog", () => {
	const models = Object.values(GMI_MODELS);

	it("ships a non-empty catalog registered under the gmi provider", () => {
		expect(models.length).toBeGreaterThan(0);
		expect(getModels("gmi").length).toBe(models.length);
	});

	it("points every model at the GMI base URL over openai-completions", () => {
		for (const model of models) {
			expect(model.provider).toBe("gmi");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe(GMI_BASE_URL);
		}
	});

	it("gives every model a usable context window and output limit", () => {
		for (const model of models) {
			expect(model.contextWindow, model.id).toBeGreaterThan(0);
			expect(model.maxTokens, model.id).toBeGreaterThan(0);
			// maxTokens is an output budget carved out of the context window.
			expect(model.maxTokens, model.id).toBeLessThanOrEqual(model.contextWindow);
		}
	});

	it("prices every model in $/million tokens", () => {
		for (const model of models) {
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				expect(Number.isFinite(model.cost[field]), `${model.id}.${field}`).toBe(true);
				expect(model.cost[field], `${model.id}.${field}`).toBeGreaterThanOrEqual(0);
			}
			for (const tier of model.cost.tiers ?? []) {
				expect(tier.inputTokensAbove, model.id).toBeGreaterThan(0);
				expect(tier.input, model.id).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("disables the developer role, which the GLM and Qwen upstreams reject", () => {
		for (const model of models) {
			expect(model.compat?.supportsDeveloperRole, model.id).toBe(false);
		}
	});

	it("requires reasoning_content on replayed assistant messages for reasoning models", () => {
		const reasoning = models.filter((model) => model.reasoning);
		expect(reasoning.length).toBeGreaterThan(0);
		for (const model of reasoning) {
			expect(model.compat?.requiresReasoningContentOnAssistantMessages, model.id).toBe(true);
		}
	});

	it("keeps thinking on the OpenAI reasoning_effort format", () => {
		for (const model of models) {
			// "deepseek"/"zai" would send a top-level `thinking` object, which GMI rejects
			// with "Unsupported conversion: cursor_claude -> openai_chat_completion".
			// Detection would otherwise pick "deepseek" for the deepseek-v4 model ids.
			expect(model.compat?.thinkingFormat, model.id).toBe("openai");
		}
	});

	it("excludes models that GMI lists but cannot serve over chat completions", () => {
		const ids = new Set<string>(models.map((model) => model.id));
		// Deprecated upstream, no available source, no target server, and a
		// Responses-API-only model that 400s on /v1/chat/completions.
		expect(ids.has("Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8")).toBe(false);
		expect(ids.has("zai-org/GLM-4.7-FP8")).toBe(false);
		expect(ids.has("anthropic/claude-fable-5")).toBe(false);
		expect(ids.has("moonshotai/Kimi-K2-Thinking")).toBe(false);
		expect(ids.has("openai/gpt-5.4-pro")).toBe(false);
	});
});

describe("GMI Cloud provider", () => {
	it("is configured for API-key auth against the GMI base URL", () => {
		const provider = gmiProvider();
		expect(provider.id).toBe("gmi");
		expect(provider.name).toBe("GMI Cloud");
		expect(provider.baseUrl).toBe(GMI_BASE_URL);
		expect(provider.getModels().length).toBeGreaterThan(0);
	});

	it("resolves credentials from both the pi and the GMI-published env var", () => {
		const previous = { gmi: process.env.GMI_API_KEY, gmicloud: process.env.GMICLOUD_API_KEY };
		try {
			process.env.GMI_API_KEY = "gmi-test-key";
			process.env.GMICLOUD_API_KEY = "gmicloud-test-key";
			expect(findEnvKeys("gmi")).toEqual(["GMI_API_KEY", "GMICLOUD_API_KEY"]);

			delete process.env.GMI_API_KEY;
			process.env.GMICLOUD_API_KEY = "gmicloud-test-key";
			expect(getEnvApiKey("gmi")).toBe("gmicloud-test-key");

			process.env.GMI_API_KEY = "gmi-test-key";
			expect(getEnvApiKey("gmi")).toBe("gmi-test-key");
		} finally {
			if (previous.gmi === undefined) delete process.env.GMI_API_KEY;
			else process.env.GMI_API_KEY = previous.gmi;
			if (previous.gmicloud === undefined) delete process.env.GMICLOUD_API_KEY;
			else process.env.GMICLOUD_API_KEY = previous.gmicloud;
		}
	});
});
