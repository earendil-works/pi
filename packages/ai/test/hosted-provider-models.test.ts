import { describe, expect, it } from "vitest";
import { hasApi } from "../src/models.ts";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

const HOSTS = [
	["deepinfra", "https://api.deepinfra.com/v1/openai"],
	["nebius", "https://api.tokenfactory.nebius.com/v1"],
	["ollama-cloud", "https://ollama.com/v1"],
	["scaleway", "https://api.scaleway.ai/v1"],
	["siliconflow", "https://api.siliconflow.com/v1"],
	["siliconflow-cn", "https://api.siliconflow.cn/v1"],
	["stepfun", "https://api.stepfun.ai/v1"],
	["stepfun-cn", "https://api.stepfun.com/v1"],
] as const;

function completionsModels(provider: (typeof HOSTS)[number][0]): Model<"openai-completions">[] {
	return getBuiltinModels(provider).filter((model) => hasApi(model, "openai-completions"));
}

describe("hosted OpenAI-compatible providers", () => {
	it.each(HOSTS)("serves %s through Chat Completions without OpenAI-only request features", (provider, baseUrl) => {
		const models = getBuiltinModels(provider);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model).toMatchObject({ provider, api: "openai-completions", baseUrl });
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsLongCacheRetention: false,
			});
		}
	});

	it.each(HOSTS)("sends reasoning_effort on %s only for models with cataloged effort levels", (provider) => {
		for (const model of completionsModels(provider)) {
			if (!model.reasoning) continue;
			if (model.compat?.supportsReasoningEffort === false) {
				expect(model.thinkingLevelMap).toBeUndefined();
			} else {
				expect(model.thinkingLevelMap).toBeDefined();
			}
		}
	});

	it("toggles SiliconFlow thinking with enable_thinking, including for DeepSeek V4", () => {
		const models = completionsModels("siliconflow");
		expect(models.filter((model) => model.compat?.thinkingFormat === "qwen").length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.compat?.thinkingFormat).not.toBe("deepseek");
		}
	});

	it("uses DeepSeek-style reasoning on StepFun", () => {
		for (const provider of ["stepfun", "stepfun-cn"] as const) {
			expect(getBuiltinModel(provider, "step-3.7-flash").compat).toMatchObject({
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: true,
			});
		}
	});

	it("caps Scaleway output with max_completion_tokens", () => {
		for (const model of completionsModels("scaleway")) {
			expect(model.compat?.maxTokensField).toBe("max_completion_tokens");
		}
	});
});
