import { defineProvider } from "../define.ts";
import { finalizeMoonshotModel, MOONSHOT_COMPLETIONS_COMPAT, moonshotModels } from "./moonshotai.ts";

export default defineProvider({
	id: "moonshotai-cn",
	models: (ctx) => moonshotModels(ctx, "moonshotai-cn", "https://api.moonshot.cn/v1"),
	compat: { "openai-completions": MOONSHOT_COMPLETIONS_COMPAT },
	finalize: finalizeMoonshotModel,
});
