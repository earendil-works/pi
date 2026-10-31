import { defineProvider } from "../define.ts";
import { STEPFUN_COMPLETIONS_COMPAT, stepfunModels } from "./stepfun.ts";

export default defineProvider({
	id: "stepfun-cn",
	models: (ctx) => stepfunModels(ctx, "stepfun", "https://api.stepfun.com/v1"),
	compat: { "openai-completions": STEPFUN_COMPLETIONS_COMPAT },
});
