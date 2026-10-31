import { defineProvider, modelsDevModels } from "../define.ts";
import { catalogedEffortCompat, OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";

// DeepInfra's OpenAI-compatible endpoint rejects developer messages with a 422.
export default defineProvider({
	id: "deepinfra",
	models: (ctx) =>
		modelsDevModels(ctx, "deepinfra", {
			api: "openai-completions",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			map: (model, source) => ({ ...model, compat: catalogedEffortCompat(source) }),
		}),
	compat: { "openai-completions": OPENAI_COMPATIBLE_HOST_COMPAT },
});
