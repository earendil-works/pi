/**
 * pi-ai's configuration schemas (built with pi-schema) as TypeBox schemas, for the coding agent's own TypeBox-built
 * configuration schemas (models.json, settings.json): the same JSON, typed for TypeBox's `Static`.
 */

import {
	type ProviderCompat,
	ProviderCompatSchema as ProviderCompatJsonSchema,
} from "@earendil-works/pi-ai/providers/compat-schema";
import {
	type ModelCost,
	ModelCostSchema as ModelCostJsonSchema,
	type ModelInputLimits,
	ModelInputLimitsSchema as ModelInputLimitsJsonSchema,
	type ModelInputModality,
	ModelInputModalitySchema as ModelInputModalityJsonSchema,
	type ModelPromptCache,
	ModelPromptCacheSchema as ModelPromptCacheJsonSchema,
	type ModelThinkingLevel,
	ModelThinkingLevelSchema as ModelThinkingLevelJsonSchema,
	type ThinkingLevelMap,
	ThinkingLevelMapSchema as ThinkingLevelMapJsonSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { Type } from "typebox";

export const ProviderCompatSchema = Type.Unsafe<ProviderCompat>(ProviderCompatJsonSchema);
export const ModelCostSchema = Type.Unsafe<ModelCost>(ModelCostJsonSchema);
export const ModelInputLimitsSchema = Type.Unsafe<ModelInputLimits>(ModelInputLimitsJsonSchema);
export const ModelInputModalitySchema = Type.Unsafe<ModelInputModality>(ModelInputModalityJsonSchema);
export const ModelPromptCacheSchema = Type.Unsafe<ModelPromptCache>(ModelPromptCacheJsonSchema);
export const ModelThinkingLevelSchema = Type.Unsafe<ModelThinkingLevel>(ModelThinkingLevelJsonSchema);
export const ThinkingLevelMapSchema = Type.Unsafe<ThinkingLevelMap>(ThinkingLevelMapJsonSchema);

/** `ModelCostSchema` with every field optional, for model overrides that change some of the rates. */
export const PartialModelCostSchema = Type.Unsafe<Partial<ModelCost>>(withoutRequired(ModelCostJsonSchema));

function withoutRequired(schema: object): object {
	const { required: _required, ...rest } = schema as { required?: unknown };
	return rest;
}
