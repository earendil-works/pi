import { type Static, Type } from "typebox";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_THINKING_LEVELS = ["off", ...THINKING_LEVELS] as const;
export const MODEL_INPUT_MODALITIES = ["text", "image"] as const;
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export const MODEL_PROMPT_CACHE_RETENTIONS = ["short", "long"] as const;

export const ThinkingLevelSchema = Type.Enum(THINKING_LEVELS);
export const ModelThinkingLevelSchema = Type.Enum(MODEL_THINKING_LEVELS);
export const ModelInputModalitySchema = Type.Enum(MODEL_INPUT_MODALITIES);
export const CacheRetentionSchema = Type.Enum(CACHE_RETENTIONS);

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
export const ThinkingLevelMapSchema = Type.Partial(Type.Record(ModelThinkingLevelSchema, ThinkingLevelMapValueSchema));

export const ModelPromptCacheSchema = Type.Partial(
	Type.Record(Type.Enum(MODEL_PROMPT_CACHE_RETENTIONS), Type.Number({ exclusiveMinimum: 0 })),
);

const ModelCostRatesProperties = {
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
};

export const ModelCostRatesSchema = Type.Object(ModelCostRatesProperties);
export const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number(),
	...ModelCostRatesProperties,
});
export const ModelCostSchema = Type.Object({
	...ModelCostRatesProperties,
	tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
});

export const ModelImageResizeOptionsSchema = Type.Object({
	maxWidth: Type.Optional(Type.Integer({ minimum: 1 })),
	maxHeight: Type.Optional(Type.Integer({ minimum: 1 })),
	maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
	jpegQuality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ModelImageInputLimitsSchema = Type.Object({
	resize: Type.Optional(ModelImageResizeOptionsSchema),
	maxPerMessage: Type.Optional(Type.Integer({ minimum: 1 })),
	maxPerRequest: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const ModelInputLimitsSchema = Type.Object({
	maxRequestBytes: Type.Optional(Type.Integer({ minimum: 1 })),
	images: Type.Optional(ModelImageInputLimitsSchema),
});

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type ModelThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
export type ThinkingLevelMap = Static<typeof ThinkingLevelMapSchema>;
export type ModelInputModality = Static<typeof ModelInputModalitySchema>;
export type CacheRetention = Static<typeof CacheRetentionSchema>;
export type ModelPromptCache = Static<typeof ModelPromptCacheSchema>;
export type ModelCostRates = Static<typeof ModelCostRatesSchema>;
export type ModelCostTier = Static<typeof ModelCostTierSchema>;
export type ModelCost = Static<typeof ModelCostSchema>;
export type ModelImageResizeOptions = Static<typeof ModelImageResizeOptionsSchema>;
export type ModelImageInputLimits = Static<typeof ModelImageInputLimitsSchema>;
export type ModelInputLimits = Static<typeof ModelInputLimitsSchema>;
