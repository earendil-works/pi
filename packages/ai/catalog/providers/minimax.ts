import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// MiniMax asked to hide older models from its direct providers (#2596).
const HIDDEN_MODEL_IDS = new Set(["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"]);

/** MiniMax's Anthropic-compatible API. The SDK appends /v1/messages. */
export function minimaxModels(ctx: ProviderContext, source: string, baseUrl: string) {
	return modelsDevModels(ctx, source, {
		api: "anthropic-messages",
		baseUrl,
		recordReasoning: false,
		include: (model) => !HIDDEN_MODEL_IDS.has(model.id),
		map: (model, source) => {
			// Models with effort levels (e.g. MiniMax-M3.1-Flash) take adaptive thinking with
			// output_config.effort and reject thinking.type="disabled" (no "none" effort, so off is null).
			const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
			return thinkingLevelMap ? { ...model, thinkingLevelMap, compat: { forceAdaptiveThinking: true } } : model;
		},
	});
}

export default defineProvider({
	id: "minimax",
	models: (ctx) => minimaxModels(ctx, "minimax", "https://api.minimax.io/anthropic"),
});
