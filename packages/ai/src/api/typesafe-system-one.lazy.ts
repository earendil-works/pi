import type { ProviderClassifier } from "../types.ts";

export const typesafeSystemOneApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./typesafe-system-one.ts")).classify(model, context, options),
});
