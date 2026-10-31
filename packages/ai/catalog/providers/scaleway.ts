import { defineProvider, modelsDevModels } from "../define.ts";
import { catalogedEffortCompat, OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";

// Scaleway Generative APIs take `max_completion_tokens` and native `reasoning_effort`.
export default defineProvider({
	id: "scaleway",
	models: (ctx) =>
		modelsDevModels(ctx, "scaleway", {
			api: "openai-completions",
			baseUrl: "https://api.scaleway.ai/v1",
			map: (model, source) => ({ ...model, compat: catalogedEffortCompat(source) }),
		}),
	compat: {
		"openai-completions": { ...OPENAI_COMPATIBLE_HOST_COMPAT, maxTokensField: "max_completion_tokens" },
	},
});
