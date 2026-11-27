import { afterEach, describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { ctyunTokenPlanProvider } from "../src/providers/ctyun-token-plan.ts";

const originalApiKey = process.env.CTYUN_TOKEN_PLAN_API_KEY;

afterEach(() => {
	if (originalApiKey === undefined) {
		delete process.env.CTYUN_TOKEN_PLAN_API_KEY;
	} else {
		process.env.CTYUN_TOKEN_PLAN_API_KEY = originalApiKey;
	}
});

const MODEL_IDS = [
	"minimax-m3",
	"kimi-k2.6",
	"glm-5.1",
	"glm-5.2",
	"deepseek-v4-flash-0731-new",
	"deepseek-v4-pro-0813",
	"ctyun-smart-router",
] as const;

describe("CTYUN Token Plan models", () => {
	it("registers all seven models via OpenAI-compatible Chat Completions API", () => {
		for (const id of MODEL_IDS) {
			const model = getModel("ctyun-token-plan", id);
			expect(model).toBeDefined();
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("ctyun-token-plan");
			expect(model.baseUrl).toBe("https://ai.ctaigw.cn/coding/v1");
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			});
		}
		expect(getModels("ctyun-token-plan")).toHaveLength(7);
	});

	it("exposes the runtime provider with the CTYUN base URL and auth env", () => {
		const provider = ctyunTokenPlanProvider();
		expect(provider.id).toBe("ctyun-token-plan");
		expect(provider.baseUrl).toBe("https://ai.ctaigw.cn/coding/v1");
		expect(provider.getModels()).toHaveLength(7);
	});

	it("resolves CTYUN_TOKEN_PLAN_API_KEY from the environment", () => {
		process.env.CTYUN_TOKEN_PLAN_API_KEY = "test-ctyun-key";

		expect(findEnvKeys("ctyun-token-plan")).toEqual(["CTYUN_TOKEN_PLAN_API_KEY"]);
		expect(getEnvApiKey("ctyun-token-plan")).toBe("test-ctyun-key");
	});
});
