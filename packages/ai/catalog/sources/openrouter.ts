import { type OpenRouterModel, openRouterCost } from "../../src/providers/openrouter-api.ts";
import type { ClassifierModel, ImageModel, Model, ThinkingLevel, ThinkingLevelMap } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface OpenRouterReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: Array<ThinkingLevel | "none">;
	default_effort?: ThinkingLevel | "none";
}

/** Convert OpenRouter's reasoning metadata into Pi model capabilities. */
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	if (!reasoning.supported_efforts?.length) return reasoning.mandatory === true ? { off: null } : undefined;

	// OpenRouter's supported_efforts uses the same effort values as models.dev reasoning_options,
	// so both sources can share the same Pi thinking-level conversion.
	const map = getEffortThinkingLevelMap([{ type: "effort", values: reasoning.supported_efforts }]);
	if (!map) return reasoning.mandatory === true ? { off: null } : undefined;
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}

export interface OpenRouterModelListItem extends OpenRouterModel {
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
	reasoning?: OpenRouterReasoningMetadata;
}

export interface OpenRouterCatalog {
	chat: Model<"anthropic-messages" | "openai-completions">[];
	images: ImageModel<"openrouter-images">[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}

function modalities(values: string[] | undefined): ("text" | "image")[] {
	return Array.from(
		new Set((values ?? []).filter((value): value is "text" | "image" => value === "text" || value === "image")),
	);
}

/**
 * Build the OpenRouter catalog from the default listing and the
 * `output_modalities=image` and `output_modalities=decisions` listings. The
 * default listing omits image-only and decision models, so those come from
 * the other listings. An upstream model may appear in several results; it then
 * gets separate entries per operation.
 */
export function buildOpenRouterCatalog(
	listed: readonly OpenRouterModelListItem[],
	imageListed: readonly OpenRouterModelListItem[],
	decisionListed: readonly OpenRouterModelListItem[],
): OpenRouterCatalog {
	const chat: OpenRouterCatalog["chat"] = [];

	for (const model of listed) {
		// Only include models that support tools
		if (!model.supported_parameters?.includes("tools")) continue;
		// Parse input modalities
		const input: ("text" | "image")[] = ["text"];
		if (model.architecture?.modality?.includes("image")) {
			input.push("image");
		}

		const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);
		// Includes the `~anthropic/claude-*-latest` aliases, which OpenRouter's Messages endpoint accepts.
		const useAnthropicMessages = /^~?anthropic\//.test(model.id) && !model.id.endsWith(":batch");
		chat.push({
			type: "chat",
			id: model.id,
			name: model.name,
			api: useAnthropicMessages ? "anthropic-messages" : "openai-completions",
			baseUrl: useAnthropicMessages ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1",
			provider: "openrouter",
			reasoning: model.supported_parameters?.includes("reasoning") || false,
			...(thinkingLevelMap && { thinkingLevelMap }),
			input,
			cost: openRouterCost(model.pricing),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			maxTokens: model.top_provider?.max_completion_tokens || 4096,
		});
	}

	const images: OpenRouterCatalog["images"] = [];
	for (const model of imageListed) {
		if (images.some((entry) => entry.id === model.id)) continue;
		const output = modalities(model.architecture?.output_modalities);
		if (!output.includes("image")) continue;
		const input = modalities(model.architecture?.input_modalities);
		images.push({
			type: "image",
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			output,
			cost: openRouterCost(model.pricing),
		});
	}

	// Decision models such as TypeSafe's Jev are served through OpenRouter's
	// TypeSafe-compatible System One endpoint.
	const classifiers: OpenRouterCatalog["classifiers"] = [];
	for (const model of decisionListed) {
		if (classifiers.some((entry) => entry.id === model.id)) continue;
		if (!model.architecture?.output_modalities?.includes("decisions")) continue;
		const input = modalities(model.architecture.input_modalities);
		classifiers.push({
			type: "classifier",
			id: model.id,
			name: model.name,
			api: "typesafe-system-one",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			cost: openRouterCost(model.pricing),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			// OpenRouter answers TypeSafe `assets` with 200 but drops the images.
			compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
		});
	}

	return { chat, images, classifiers };
}

async function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	const response = await fetch(`${OPENROUTER_MODELS_URL}${query}`);
	if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
	const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
	return data.data ?? [];
}

/** Fetch the tool-capable chat, image, and decision listings. */
export async function fetchOpenRouterCatalog(): Promise<OpenRouterCatalog> {
	const [listed, imageListed, decisionListed] = await Promise.all([
		fetchOpenRouterList(""),
		fetchOpenRouterList("?output_modalities=image"),
		fetchOpenRouterList("?output_modalities=decisions"),
	]);
	return buildOpenRouterCatalog(listed, imageListed, decisionListed);
}
