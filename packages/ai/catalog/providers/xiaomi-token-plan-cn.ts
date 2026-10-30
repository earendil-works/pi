import { defineProvider } from "../define.ts";
import { XIAOMI_COMPLETIONS_COMPAT, xiaomiModels } from "./xiaomi.ts";

export default defineProvider({
	id: "xiaomi-token-plan-cn",
	models: (ctx) => xiaomiModels(ctx, "https://token-plan-cn.xiaomimimo.com/v1"),
	compat: { "openai-completions": XIAOMI_COMPLETIONS_COMPAT },
});
