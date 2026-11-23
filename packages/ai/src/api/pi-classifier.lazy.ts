import type { ProviderClassifier } from "../types.ts";

export const piClassifierApi = (): ProviderClassifier => ({
	classify: async (model, context, options) => (await import("./pi-classifier.ts")).classify(model, context, options),
});
