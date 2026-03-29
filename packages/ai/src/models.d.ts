import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, Provider, Usage } from "./types.js";
/** Providers that exist in the generated MODELS constant */
type GeneratedProvider = keyof typeof MODELS;
type ModelApi<TProvider extends GeneratedProvider, TModelId extends keyof (typeof MODELS)[TProvider]> = (typeof MODELS)[TProvider][TModelId] extends {
    api: infer TApi;
} ? (TApi extends Api ? TApi : never) : never;
/**
 * Get a model by provider and model ID.
 * For providers in MODELS, this returns a strongly-typed model.
 */
export declare function getModel<TProvider extends GeneratedProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(provider: TProvider, modelId: TModelId): Model<ModelApi<TProvider, TModelId>>;
/**
 * Get a model by provider and model ID.
 * For dynamic providers (OAuth, custom), this returns Model<Api> | undefined.
 */
export declare function getModel(provider: Provider, modelId: string): Model<Api> | undefined;
export declare function getProviders(): KnownProvider[];
export declare function getModels<TProvider extends GeneratedProvider>(provider: TProvider): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[];
export declare function getModels(provider: Provider): Model<Api>[];
export declare function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"];
/**
 * Check if a model supports xhigh thinking level.
 * Currently only certain OpenAI models support this.
 */
export declare function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean;
export {};
//# sourceMappingURL=models.d.ts.map