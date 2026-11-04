import { defineProvider } from "../define.ts";
import { ZAI_COMPLETIONS_COMPAT, zaiModels } from "./zai.ts";

// Z.AI pay-as-you-go API. The `zai` provider is the GLM Coding Plan endpoint.
export default defineProvider({
	id: "zai-api",
	models: (ctx) => zaiModels(ctx, "zai", "https://api.z.ai/api/paas/v4"),
	compat: { "openai-completions": ZAI_COMPLETIONS_COMPAT },
});
