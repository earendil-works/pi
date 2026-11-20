import { defineProvider } from "../define.ts";
import { CN_BASE_URL, QWEN_COMPLETIONS_COMPAT, qwenTokenPlanModels } from "./qwen-token-plan.ts";
import { INDIVIDUAL_MODEL_IDS } from "./qwen-token-plan-individual.ts";

// QwenCloud Token Plan Individual on the China endpoint: the Individual allowlist served from the China catalog.
export default defineProvider({
	id: "qwen-token-plan-individual-cn",
	models: (ctx) => qwenTokenPlanModels(ctx, "alibaba-token-plan-cn", CN_BASE_URL, INDIVIDUAL_MODEL_IDS),
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
