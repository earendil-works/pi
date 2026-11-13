import {
	type Annotations,
	arr,
	int,
	nul,
	num,
	oneOf,
	opt,
	type Static,
	type StaticObject,
	str,
	union,
} from "@earendil-works/pi-schema";
import { openObject as object } from "./schema-builders.ts";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_THINKING_LEVELS = ["off", ...THINKING_LEVELS] as const;
export const MODEL_INPUT_MODALITIES = ["text", "image"] as const;
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export const MODEL_PROMPT_CACHE_RETENTIONS = ["short", "long"] as const;

export const ThinkingLevelSchema = oneOf(THINKING_LEVELS);
export const ModelThinkingLevelSchema = oneOf(MODEL_THINKING_LEVELS);
export const ModelInputModalitySchema = oneOf(MODEL_INPUT_MODALITIES);
export const CacheRetentionSchema = oneOf(CACHE_RETENTIONS);

const ThinkingLevelMapValueSchema = union([str(), nul()]);
export const ThinkingLevelMapSchema = object(
	{
		off: opt(ThinkingLevelMapValueSchema),
		minimal: opt(ThinkingLevelMapValueSchema),
		low: opt(ThinkingLevelMapValueSchema),
		medium: opt(ThinkingLevelMapValueSchema),
		high: opt(ThinkingLevelMapValueSchema),
		xhigh: opt(ThinkingLevelMapValueSchema),
		max: opt(ThinkingLevelMapValueSchema),
	},
	{
		description:
			"Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported.",
	},
);

const PromptCacheLifetimeSchema = num({ exclusiveMinimum: 0 });
export const ModelPromptCacheSchema = object(
	{ short: opt(PromptCacheLifetimeSchema), long: opt(PromptCacheLifetimeSchema) },
	{
		description:
			"Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Pi warms only tiers with a known lifetime.",
	},
);

const ModelCostRatesProperties = {
	input: num({ description: "Input cost in USD per million tokens." }),
	output: num({ description: "Output cost in USD per million tokens." }),
	cacheRead: num({ description: "Cache-read cost in USD per million tokens." }),
	cacheWrite: num({ description: "Cache-write cost in USD per million tokens." }),
};

export const ModelCostRatesSchema = object(ModelCostRatesProperties);
export const ModelCostTierSchema = object({
	inputTokensAbove: num({
		description: "Use this tier when total request input exceeds this token count.",
	}),
	...ModelCostRatesProperties,
});
export const ModelCostSchema = object({
	...ModelCostRatesProperties,
	tiers: opt(
		arr(ModelCostTierSchema, {
			description: "Request-wide pricing tiers. The highest matching input threshold applies to the full request.",
		}),
	),
});

const ModelImageResizeProperties = {
	maxWidth: opt(int({ minimum: 1 })),
	maxHeight: opt(int({ minimum: 1 })),
	maxBytes: opt(int({ minimum: 1, description: "Maximum base64-encoded payload size in bytes." })),
	jpegQuality: opt(int({ minimum: 1, maximum: 100 })),
};

function modelImageResizeOptions(options?: Annotations<StaticObject<typeof ModelImageResizeProperties>>) {
	return object(ModelImageResizeProperties, options);
}

export const ModelImageResizeOptionsSchema = modelImageResizeOptions();

export const ModelImageInputLimitsSchema = object({
	resize: opt(
		modelImageResizeOptions({
			description: "Cache-safe resize profile applied before a new image enters conversation history.",
		}),
	),
	maxPerMessage: opt(int({ minimum: 1, description: "Maximum images accepted in one provider message." })),
	maxPerRequest: opt(int({ minimum: 1, description: "Maximum images accepted across one provider request." })),
});

export const ModelInputLimitsSchema = object({
	maxRequestBytes: opt(int({ minimum: 1, description: "Maximum serialized provider request size in bytes." })),
	images: opt(ModelImageInputLimitsSchema),
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
