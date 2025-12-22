import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, Usage } from "./types.js";
type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends {
	api: infer TApi;
}
	? TApi extends Api
		? TApi
		: never
	: never;
export declare function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>>;
export declare function getProviders(): KnownProvider[];
export declare function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[];
export declare function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"];
/**
 * Check if a model supports xhigh thinking level.
 * Currently only certain OpenAI models support this.
 */
export declare function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean;
//# sourceMappingURL=models.d.ts.map
