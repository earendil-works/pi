import type { Model } from "../types.ts";
import type { KiroCatalogModel } from "./kiro.shared.ts";
import { getKiroEndpoints } from "./kiro.shared.ts";

export type KiroModel = Model<"kiro-api"> & {
	kiroModelId?: string;
	kiroRegion?: string;
	kiroProfileArn?: string;
	additionalModelRequestFieldsSchema?: Record<string, unknown>;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
const KIRO_RUNTIME = getKiroEndpoints("us-east-1").runtime;

function isReasoningModel(id: string): boolean {
	return /auto|claude-opus|claude-sonnet|deepseek|gpt|glm|qwen/i.test(id);
}

function createBootstrapModel(
	id: string,
	options: Partial<Pick<KiroModel, "reasoning" | "input" | "contextWindow" | "maxTokens" | "thinkingLevelMap">> = {},
): KiroModel {
	return {
		id,
		name: id
			.split("-")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" "),
		api: "kiro-api",
		provider: "kiro",
		baseUrl: KIRO_RUNTIME,
		reasoning: options.reasoning ?? isReasoningModel(id),
		input: options.input ?? (/^(auto|claude)/i.test(id) ? ["text", "image"] : ["text"]),
		cost: { ...ZERO_COST },
		contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
		kiroModelId: id,
	};
}

/**
 * Kiro's management catalog is account/profile scoped, so these models are only
 * a safe bootstrap. A successful List-Available-Models response replaces them.
 */
export const KIRO_MODELS: readonly KiroModel[] = [
	createBootstrapModel("auto", { contextWindow: 1_000_000, maxTokens: 65_536, thinkingLevelMap: { max: "max" } }),
	createBootstrapModel("claude-opus-5", {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	}),
	createBootstrapModel("claude-sonnet-5", {
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	}),
	createBootstrapModel("claude-opus-4.8", {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	}),
	createBootstrapModel("claude-opus-4.7", {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	}),
	createBootstrapModel("claude-opus-4.6", { maxTokens: 32_768, thinkingLevelMap: { max: "max" } }),
	createBootstrapModel("claude-sonnet-4.6", { maxTokens: 65_536, thinkingLevelMap: { max: "max" } }),
	createBootstrapModel("claude-opus-4.5", { maxTokens: 65_536 }),
	createBootstrapModel("claude-sonnet-4.5", { maxTokens: 65_536 }),
	createBootstrapModel("claude-sonnet-4", { maxTokens: 65_536 }),
	createBootstrapModel("claude-haiku-4.5", { reasoning: false, maxTokens: 65_536 }),
	createBootstrapModel("gpt-5.6-sol"),
	createBootstrapModel("gpt-5.6-terra"),
	createBootstrapModel("gpt-5.6-luna"),
	createBootstrapModel("deepseek-3.2"),
	createBootstrapModel("minimax-m2.5", { reasoning: false }),
	createBootstrapModel("minimax-m2.1", { reasoning: false }),
	createBootstrapModel("glm-5"),
	createBootstrapModel("qwen3-coder-next"),
];

export function mapKiroCatalogToModels(catalog: readonly KiroCatalogModel[], region: string): KiroModel[] {
	const seen = new Set<string>();
	return catalog.map((model) => {
		const id = model.modelId.trim();
		if (!id || seen.has(id)) throw new Error(`Kiro management catalog contains duplicate model ID ${id}`);
		seen.add(id);
		const existing = KIRO_MODELS.find((candidate) => candidate.kiroModelId === id || candidate.id === id);
		const limits = model.tokenLimits;
		const reasoning =
			model.additionalModelRequestFieldsSchema !== undefined || (existing?.reasoning ?? isReasoningModel(id));
		return {
			...(existing ?? createBootstrapModel(id)),
			id,
			name: model.displayName?.trim() || existing?.name || id,
			baseUrl: getKiroEndpoints(region).runtime,
			reasoning,
			contextWindow: limits?.maxInputTokens ?? existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: limits?.maxOutputTokens ?? existing?.maxTokens ?? DEFAULT_MAX_TOKENS,
			kiroModelId: id,
			kiroRegion: region,
			...(model.additionalModelRequestFieldsSchema
				? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
				: {}),
		};
	});
}
