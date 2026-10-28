import type { ProviderClassifier } from "../types.ts";

export const llamaCppClassifyApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./llama-cpp-classify.ts")).classify(model, context, options),
});
