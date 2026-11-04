import { defineProvider } from "../define.ts";
import { ZAI_COMPLETIONS_COMPAT, zaiModels } from "./zai.ts";

export default defineProvider({
	id: "zai-coding-cn",
	models: (ctx) => zaiModels(ctx, "zhipuai-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4", "zai"),
	compat: { "openai-completions": ZAI_COMPLETIONS_COMPAT },
});
