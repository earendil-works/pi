import { defineProvider } from "../define.ts";
import { ZAI_COMPLETIONS_COMPAT, zaiCodingPlanModels } from "./zai.ts";

export default defineProvider({
	id: "zai-coding-cn",
	models: (ctx) => zaiCodingPlanModels(ctx, "zhipuai-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4"),
	compat: { "openai-completions": ZAI_COMPLETIONS_COMPAT },
});
