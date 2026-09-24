import type { ProviderClassifier } from "../types.ts";

export const cloudflareWorkersAISystemOneApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./cloudflare-workers-ai-system-one.ts")).classify(model, context, options),
});
