import { defineProvider, modelsDevModels } from "../define.ts";
import { catalogedEffortCompat, OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";

// Nebius Token Factory.
export default defineProvider({
	id: "nebius",
	models: (ctx) =>
		modelsDevModels(ctx, "nebius", {
			api: "openai-completions",
			baseUrl: "https://api.tokenfactory.nebius.com/v1",
			map: (model, source) => ({ ...model, compat: catalogedEffortCompat(source) }),
		}),
	compat: { "openai-completions": OPENAI_COMPATIBLE_HOST_COMPAT },
});
