import { defineProvider } from "../define.ts";
import { OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";
import { siliconflowModels } from "./siliconflow.ts";

export default defineProvider({
	id: "siliconflow-cn",
	models: (ctx) => siliconflowModels(ctx, "siliconflow-cn", "https://api.siliconflow.cn/v1"),
	compat: { "openai-completions": OPENAI_COMPATIBLE_HOST_COMPAT },
});
