import { describe, expect, it } from "vitest";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";

describe("Alibaba Cloud Model Studio (DashScope pay-as-you-go)", () => {
	it.each([
		["alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
		["alibaba-cn", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
	] as const)("serves %s through the compatible-mode API", (provider, baseUrl) => {
		const models = getBuiltinModels(provider);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model).toMatchObject({ provider, api: "openai-completions", baseUrl });
			// Model Studio toggles thinking with enable_thinking, like the Token Plan.
			expect(model.compat).toMatchObject({
				thinkingFormat: "qwen",
				supportsDeveloperRole: false,
				supportsStore: false,
			});
		}
	});

	it("keeps Model Studio's thinking format for DeepSeek V4", () => {
		const model = getBuiltinModel("alibaba", "deepseek-v4-pro");
		expect(model.compat).toMatchObject({ thinkingFormat: "qwen" });
		expect(model.compat).not.toHaveProperty("requiresReasoningContentOnAssistantMessages");
	});

	it("sends reasoning_effort only for models with cataloged effort levels", () => {
		expect(getBuiltinModel("alibaba", "qwen3.7-max").compat).toMatchObject({ supportsReasoningEffort: false });
		expect(getBuiltinModel("alibaba", "qwen3.8-max").compat).toMatchObject({ supportsReasoningEffort: true });
	});
});

describe("Z.AI API (pay-as-you-go)", () => {
	it.each([
		["zai-api", "https://api.z.ai/api/paas/v4"],
		["zai-api-cn", "https://open.bigmodel.cn/api/paas/v4"],
	] as const)("serves %s with the Z.AI thinking format", (provider, baseUrl) => {
		const models = getBuiltinModels(provider);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model).toMatchObject({ provider, api: "openai-completions", baseUrl });
			expect(model.compat).toMatchObject({ thinkingFormat: "zai", maxTokensField: "max_tokens" });
		}
	});

	it("uses each API's own prices", () => {
		const global = getBuiltinModel("zai-api", "glm-5.3");
		const china = getBuiltinModel("zai-api-cn", "glm-5.3");
		expect(global.cost).toEqual(getBuiltinModel("zai", "glm-5.3").cost);
		// bigmodel.cn bills in CNY; models.dev converts to USD, so it differs from Z.AI's rates.
		expect(china.cost.input).toBeGreaterThan(0);
		expect(china.cost).not.toEqual(global.cost);
	});
});
