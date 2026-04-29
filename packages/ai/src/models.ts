import { MODELS } from "./models.generated.js";
import { MODELS_GLOO } from "./models.gloo.js";
import type { Api, KnownProvider, Model, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load. MODELS_GLOO merges in
// after the upstream-generated MODELS so the Gloo entries survive an
// upstream regeneration (`npm run generate-models`) — the regen rewrites
// models.generated.ts but never touches models.gloo.ts.
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}
for (const [provider, models] of Object.entries(MODELS_GLOO)) {
	const providerModels = modelRegistry.get(provider) ?? new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

// Merged type-level catalog so getModel("gloo", "gloo-...") gets autocomplete
// from the MODELS_GLOO file just like the auto-generated MODELS entries.
type AllModels = typeof MODELS & typeof MODELS_GLOO;

type ModelApi<
	TProvider extends keyof AllModels,
	TModelId extends keyof AllModels[TProvider],
> = AllModels[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends keyof AllModels, TModelId extends keyof AllModels[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider as string);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends keyof AllModels>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof AllModels[TProvider]>>[] {
	const models = modelRegistry.get(provider as string);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof AllModels[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 / GPT-5.5 model families
 * - DeepSeek V4 Pro
 * - Opus 4.6+ models (xhigh maps to adaptive effort "max" on Anthropic-compatible providers)
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (
		model.id.includes("gpt-5.2") ||
		model.id.includes("gpt-5.3") ||
		model.id.includes("gpt-5.4") ||
		model.id.includes("gpt-5.5") ||
		model.id.includes("deepseek-v4-pro")
	) {
		return true;
	}

	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7")
	) {
		return true;
	}

	return false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
