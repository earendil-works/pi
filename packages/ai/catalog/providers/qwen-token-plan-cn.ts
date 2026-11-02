import { defineProvider } from "../define.ts";
import { QWEN_COMPLETIONS_COMPAT, qwenTokenPlanModels } from "./qwen-token-plan.ts";

export default defineProvider({
	id: "qwen-token-plan-cn",
	models: (ctx) =>
		qwenTokenPlanModels(
			ctx,
			"alibaba-token-plan-cn",
			"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		),
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
