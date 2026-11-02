import { assertExactModelIds } from "../../scripts/model-data.ts";
import { defineProvider } from "../define.ts";
import { INTERNATIONAL_BASE_URL, QWEN_COMPLETIONS_COMPAT, qwenTokenPlanModels } from "./qwen-token-plan.ts";

// QwenCloud Token Plan Individual text-model allowlist, verified 2026-09-03.
// It shares the international endpoint with a narrower catalog.
// https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
const MODEL_IDS = new Set<string>([
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
]);

export default defineProvider({
	id: "qwen-token-plan-individual",
	models: (ctx) => {
		const models = qwenTokenPlanModels(ctx, "alibaba-token-plan", INTERNATIONAL_BASE_URL, MODEL_IDS);
		if (ctx.strict) {
			assertExactModelIds(
				ctx.providerId,
				MODEL_IDS,
				models.map((model) => model.id),
			);
		}
		return models;
	},
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
