import { defineProvider } from "../define.ts";
import { CN_BASE_URL, QWEN_COMPLETIONS_COMPAT, qwenTokenPlanModels } from "./qwen-token-plan.ts";

export default defineProvider({
	id: "qwen-token-plan-cn",
	models: (ctx) => qwenTokenPlanModels(ctx, "alibaba-token-plan-cn", CN_BASE_URL),
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
