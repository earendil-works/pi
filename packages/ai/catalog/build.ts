import type {
	AnyModel,
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownApi,
	Model,
	OpenAICompletionsCompat,
} from "../src/types.ts";
import type { ApiCompatDefaults, ChatModel, ProviderContext, ProviderDefinition } from "./define.ts";
import { mergeThinking } from "./define.ts";
import { applyClaudeFamilyRules } from "./families/anthropic.ts";
import { applyDeepSeekCompatRules, applyDeepSeekFamilyRules } from "./families/deepseek.ts";
import { applyOpenAiFamilyRules } from "./families/openai.ts";
import { getEffortThinkingLevelMap } from "./reasoning.ts";
import type { CatalogSources } from "./sources/index.ts";
import type { ModelsDevModel } from "./sources/models-dev.ts";

export interface ProviderCatalog {
	chat: (Model<Api> & { type: "chat" })[];
	image: ImageModel<ImageApi>[];
	classifier: ClassifierModel<ClassifierApi>[];
}

// Keep the generated default no less restrictive than coding-agent's historical
// image preprocessing. Provider limits can narrow this profile, but unknown
// providers retain the cache-safe 2000px / 4.5 MiB behavior.
const DEFAULT_IMAGE_RESIZE = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
} as const;

function modelKey(model: Pick<AnyModel, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

function applyCompatDefaults(model: ChatModel, defaults: ApiCompatDefaults | undefined): void {
	const entry = defaults?.[model.api as KnownApi] as
		| Model<Api>["compat"]
		| ((model: Model<Api>) => Model<Api>["compat"])
		| undefined;
	if (!entry) return;
	const compat = typeof entry === "function" ? entry(model) : entry;
	model.compat = { ...compat, ...model.compat } as Model<Api>["compat"];
}

/** Whether the model's API sends models.dev effort values to the host as-is. */
function sendsNativeEffort(model: ChatModel): boolean {
	if (model.api === "anthropic-messages") {
		return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
	}
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return true;
	}
	if (model.api !== "openai-completions") return false;
	const compat: OpenAICompletionsCompat = (model as Model<"openai-completions">).compat ?? {};
	return (compat.thinkingFormat ?? "openai") === "openai" && (compat.supportsReasoningEffort ?? true);
}

function applyModelsDevEffort(model: ChatModel, source: ModelsDevModel | undefined): void {
	if (!source?.reasoningOptions || !sendsNativeEffort(model)) return;
	const map = getEffortThinkingLevelMap(source.reasoningOptions);
	if (map) mergeThinking(model, map);
}

function applyImageResizeDefaults(model: AnyModel): void {
	if (!model.input.includes("image")) return;
	const images = model.inputLimits?.images;
	model.inputLimits = {
		...model.inputLimits,
		images: { ...images, resize: { ...DEFAULT_IMAGE_RESIZE, ...images?.resize } },
	};
}

/** Build every provider's catalog from the fetched sources. */
export function buildCatalog(
	definitions: readonly ProviderDefinition[],
	sources: CatalogSources,
	strict: boolean,
): Record<string, ProviderCatalog> {
	const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
	const modelsDevSources = new Map<string, ModelsDevModel>();
	const stageOne = new Map<string, ChatModel[]>();
	const building = new Set<string>();

	function context(providerId: string): ProviderContext {
		return {
			providerId,
			sources,
			strict,
			providerModels: (id) => structuredClone(buildModels(id)),
			modelsDevSource: (model) => modelsDevSources.get(modelKey(model)),
			recordModelsDevSource: (model, source) => {
				modelsDevSources.set(modelKey(model), source);
			},
		};
	}

	function buildModels(providerId: string): ChatModel[] {
		const built = stageOne.get(providerId);
		if (built) return built;
		const definition = definitionsById.get(providerId);
		if (!definition) throw new Error(`Unknown provider: ${providerId}`);
		if (building.has(providerId)) throw new Error(`Provider ${providerId} depends on itself`);
		building.add(providerId);
		const models = definition.models?.(context(providerId)) ?? [];
		building.delete(providerId);
		for (const model of models) {
			if (model.provider !== providerId) {
				throw new Error(`${providerId} produced ${modelKey(model)} for another provider`);
			}
		}
		stageOne.set(providerId, models);
		return models;
	}

	for (const definition of definitions) buildModels(definition.id);

	const catalogs: Record<string, ProviderCatalog> = {};
	for (const definition of definitions) {
		const ctx = context(definition.id);
		const chat: ChatModel[] = [];
		const seen = new Set<string>();
		for (const model of stageOne.get(definition.id) ?? []) {
			// The first source listing a model wins.
			if (seen.has(model.id)) continue;
			seen.add(model.id);
			chat.push(model);
		}

		for (const model of chat) {
			applyCompatDefaults(model, definition.compat);
			applyDeepSeekCompatRules(model);
			applyModelsDevEffort(model, ctx.modelsDevSource(model));
			applyOpenAiFamilyRules(model);
			applyClaudeFamilyRules(model);
			applyDeepSeekFamilyRules(model);
		}
		for (const model of chat) definition.finalize?.(model, ctx);
		for (const model of chat) {
			if (model.compat && Object.keys(model.compat).length === 0) delete model.compat;
			applyImageResizeDefaults(model);
		}
		definition.finalizeAll?.(chat, ctx);

		const image = definition.images?.(ctx) ?? [];
		for (const model of image) applyImageResizeDefaults(model);
		const classifier = definition.classifiers?.(ctx) ?? [];
		catalogs[definition.id] = {
			chat: chat.map((model) => ({ ...model, type: "chat" as const })),
			image,
			classifier,
		};
	}
	return catalogs;
}
