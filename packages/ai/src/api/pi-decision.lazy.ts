import type { ProviderClassifier } from "../types.ts";

export const piDecisionApi = (): ProviderClassifier => ({
	classify: async (model, context, options) => (await import("./pi-decision.ts")).classify(model, context, options),
});
