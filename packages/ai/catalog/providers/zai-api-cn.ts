import { defineProvider } from "../define.ts";
import { ZAI_COMPLETIONS_COMPAT, zaiModels } from "./zai.ts";

// Zhipu (bigmodel.cn) pay-as-you-go API. The `zai-coding-cn` provider is the
// China GLM Coding Plan endpoint.
export default defineProvider({
	id: "zai-api-cn",
	models: (ctx) => zaiModels(ctx, "zhipuai", "https://open.bigmodel.cn/api/paas/v4"),
	compat: { "openai-completions": ZAI_COMPLETIONS_COMPAT },
});
