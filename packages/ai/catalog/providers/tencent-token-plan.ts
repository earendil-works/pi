import { defineProvider } from "../define.ts";
import { TENCENT_HY_COMPLETIONS_COMPAT, tencentHyModels } from "./tencent-tokenhub.ts";

// Tencent Hunyuan on the prepaid Token Plan endpoint: same models and compat as
// TokenHub, with its own base URL and API key.
export const TOKEN_PLAN_BASE_URL = "https://api.lkeap.cloud.tencent.com/plan/v3";

export default defineProvider({
	id: "tencent-token-plan",
	models: (ctx) => tencentHyModels(ctx, "tencent-token-plan", TOKEN_PLAN_BASE_URL),
	compat: { "openai-completions": TENCENT_HY_COMPLETIONS_COMPAT },
});
