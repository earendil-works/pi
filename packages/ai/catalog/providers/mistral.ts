import { addMissing, defineProvider, modelsDevModels } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import { roundCost } from "../sources/models-dev.ts";

export default defineProvider({
	id: "mistral",
	models: (ctx) =>
		addMissing(
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
			[
				{
					id: "mistral-medium-3.5",
					name: "Mistral Medium 3.5",
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: true,
					thinkingLevelMap: getEffortThinkingLevelMap([{ type: "effort", values: ["none", "high"] }]),
					input: ["text", "image"],
					cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 262144,
					maxTokens: 262144,
				},
			],
		),
});
