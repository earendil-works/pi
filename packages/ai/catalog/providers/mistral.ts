import { defineProvider, modelsDevModels } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import { roundCost } from "../sources/models-dev.ts";

export default defineProvider({
	id: "mistral",
	// No skipDeprecated: models.dev marks Mistral models deprecated as soon as Mistral announces their
	// retirement, while they keep working, e.g. devstral-2512: marked 2026-06-02, retired 2026-07-31.
	models: (ctx) =>
		modelsDevModels(ctx, "mistral", {
			api: "mistral-conversations",
			baseUrl: "https://api.mistral.ai",
			recordReasoning: false,
			map: (model, source) => {
				// Models with effort values use `reasoning_effort` with these levels.
				// Reasoning models without them (Magistral) use `prompt_mode`.
				const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
				return {
					...model,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					cost: {
						input: source.cost.input || 0,
						output: source.cost.output || 0,
						// Mistral bills cached input at 10% when models.dev does not say otherwise.
						cacheRead: source.cost.cacheRead ?? (source.cost.input ? roundCost(source.cost.input * 0.1) : 0),
						cacheWrite: source.cost.cacheWrite || 0,
					},
				};
			},
		}),
});
