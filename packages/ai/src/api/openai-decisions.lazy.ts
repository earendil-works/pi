import type { ProviderClassifier } from "../types.ts";

export const openAIDecisionsApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./openai-decisions.ts")).classify(model, context, options),
});
