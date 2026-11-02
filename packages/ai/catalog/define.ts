import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownApi,
	Model,
	ModelInputLimits,
	ThinkingLevelMap,
} from "../src/types.ts";
import type { CatalogSources } from "./sources/index.ts";
import { type ModelsDevModel, modelsDevChatModels, modelsDevCost } from "./sources/models-dev.ts";

export type ChatModel = Model<Api>;
export type ModelCompat<TApi extends Api> = NonNullable<Model<TApi>["compat"]>;

/**
 * Compat defaults per API. They sit under each model's own compat, so model
 * values win. A function receives the model to vary defaults by model.
 */
export type ApiCompatDefaults = {
	[TApi in KnownApi]?: ModelCompat<TApi> | ((model: Model<TApi>) => ModelCompat<TApi>);
};

/** Passed to every provider hook. */
export interface ProviderContext {
	/** The provider being built. */
	readonly providerId: string;
	readonly sources: CatalogSources;
	/** Fail instead of degrading when upstream data is unexpected. */
	readonly strict: boolean;
	/** Copies of another provider's chat models before shared rules run. */
	providerModels(providerId: string): ChatModel[];
	/** The models.dev entry a model was built from, if it was recorded. */
	modelsDevSource(model: ChatModel): ModelsDevModel | undefined;
	/** Record the models.dev entry so shared rules can use its reasoning metadata. */
	recordModelsDevSource(model: ChatModel, source: ModelsDevModel): void;
}

/**
 * One built-in provider's catalog. The build runs, in order:
 * 1. `models()`: upstream models plus authored ones, with data corrections.
 * 2. `compat` defaults and the shared model-family rules in `families/`.
 * 3. `finalize()`: provider-specific behavior that must win over shared rules.
 * 4. Shared normalization (image input limits), then `finalizeAll()`.
 */
export interface ProviderDefinition {
	id: string;
	models?(ctx: ProviderContext): ChatModel[];
	images?(ctx: ProviderContext): ImageModel<ImageApi>[];
	classifiers?(ctx: ProviderContext): ClassifierModel<ClassifierApi>[];
	compat?: ApiCompatDefaults;
	finalize?(model: ChatModel, ctx: ProviderContext): void;
	finalizeAll?(models: ChatModel[], ctx: ProviderContext): void;
}

export function defineProvider(definition: ProviderDefinition): ProviderDefinition {
	return definition;
}

/** Shallow-merge compat flags into a model. */
export function mergeCompat<TApi extends Api>(model: Model<TApi>, compat: ModelCompat<TApi>): void {
	model.compat = { ...model.compat, ...compat } as ModelCompat<TApi>;
}

/** Shallow-merge thinking level mappings into a model. Later values win. */
export function mergeThinking(model: ChatModel, map: ThinkingLevelMap): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

/** Provider input limits for image-capable models. Limits the model already carries take precedence. */
export function withInputLimits(model: ChatModel, limits: ModelInputLimits): void {
	if (!model.input.includes("image")) return;
	model.inputLimits = {
		...limits,
		...model.inputLimits,
		images: { ...limits.images, ...model.inputLimits?.images },
	};
}

/** Add models only when upstream has not listed them (yet). */
export function addMissing(models: ChatModel[], additions: readonly ChatModel[]): ChatModel[] {
	for (const addition of additions) {
		if (!models.some((model) => model.id === addition.id)) models.push(addition);
	}
	return models;
}

export interface ModelsDevOptions<TApi extends Api> {
	api: TApi;
	baseUrl: string;
	compat?: ModelCompat<TApi>;
	headers?: Record<string, string>;
	/** Only models models.dev lists on this API protocol (e.g. "responses"). */
	protocol?: string;
	/** Skip models models.dev marks deprecated. */
	skipDeprecated?: boolean;
	/** Expose models.dev effort levels through the shared rules. Defaults to true. */
	recordReasoning?: boolean;
	/** Fallback limits when models.dev has none. Defaults to 4096 each. */
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	/** Extra filter. Models without tool support are always skipped. */
	include?(source: ModelsDevModel): boolean;
	/** Adjust or replace the mapped model. Return undefined to skip it. */
	map?(model: Model<TApi>, source: ModelsDevModel): ChatModel | undefined;
}

/** Map one models.dev provider's tool-capable chat models onto pi models. */
export function modelsDevModels<TApi extends Api>(
	ctx: ProviderContext,
	sourceProvider: string,
	options: ModelsDevOptions<TApi>,
): ChatModel[] {
	const models: ChatModel[] = [];
	for (const source of modelsDevChatModels(ctx.sources.modelsDev, sourceProvider)) {
		if (!source.toolCall) continue;
		if (options.protocol && !source.apis.some((api) => api.protocol === options.protocol)) continue;
		if (options.skipDeprecated && source.status === "deprecated") continue;
		if (options.include && !options.include(source)) continue;
		const base: Model<TApi> = {
			id: source.id,
			name: source.name || source.id,
			api: options.api,
			provider: ctx.providerId,
			baseUrl: options.baseUrl,
			reasoning: source.reasoning,
			input: source.imageInput ? ["text", "image"] : ["text"],
			cost: modelsDevCost(source.cost),
			contextWindow: source.contextWindow || options.defaultContextWindow || 4096,
			maxTokens: source.maxTokens || options.defaultMaxTokens || 4096,
			...(options.headers ? { headers: { ...options.headers } } : {}),
			...(options.compat ? { compat: { ...options.compat } } : {}),
		};
		const model = options.map ? options.map(base, source) : base;
		if (!model) continue;
		if (options.recordReasoning !== false) ctx.recordModelsDevSource(model, source);
		models.push(model);
	}
	return models;
}
