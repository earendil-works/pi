import { defineProvider } from "../define.ts";
import { dashscopeModels } from "./alibaba.ts";
import { QWEN_COMPLETIONS_COMPAT } from "./qwen-token-plan.ts";

export default defineProvider({
	id: "alibaba-cn",
	models: (ctx) => dashscopeModels(ctx, "alibaba-cn", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
