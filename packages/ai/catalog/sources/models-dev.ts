import type { ModelCost } from "../../src/types.ts";

// models.dev v2 catalog. The schema is published as experimental, so everything
// the catalog reads goes through `normalizeModelsDevModel()` below.
// https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema-v2.ts
export const MODELS_DEV_URL = "https://models.dev/experimental/v2.0/api.json";
// v2 has no provider-agnostic decision metadata endpoint; v1 still serves it.
export const MODELS_DEV_DECISIONS_URL = "https://models.dev/models.json?type=decision";

export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| {
			type: "effort";
			values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null>;
	  }
	| { type: "budget_tokens"; min?: number; max?: number };

type ModelsDevEffort = Extract<ModelsDevReasoningOption, { type: "effort" }>["values"][number];

interface V2CachePrices {
	read?: number;
	write?: number | Record<string, number>;
	explicit?: { read?: number; write?: number | Record<string, number> };
}

interface V2CostOverride {
	when: Record<string, unknown>;
	price?: number;
	cache?: V2CachePrices;
}

interface V2ModalityCost {
	input?: { unit?: string; price: number; cache?: V2CachePrices; overrides?: V2CostOverride[] };
	output?: { unit?: string; price: number; overrides?: V2CostOverride[] };
}

interface V2ApiEntry {
	base_url: string;
	path?: string;
	sdk?: { aisdk?: string };
	compatibility?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
}

/** The subset of a models.dev v2 model the catalog reads. */
export interface ModelsDevV2Model {
	id: string;
	type: string;
	name: string;
	status?: string;
	modalities: { input: string[]; output: string[] };
	capabilities: {
		tools: { supported: boolean };
		reasoning: {
			supported: boolean;
			toggle?: boolean;
			effort?: ModelsDevEffort[];
			budget?: { min?: number; max?: number };
		};
		structured_output?: boolean;
	};
	limit?: { context?: number; input?: number; output?: number };
	cost?: { text?: V2ModalityCost };
	api: Record<string, V2ApiEntry>;
}

export type ModelsDevV2Catalog = Record<string, { models?: Record<string, ModelsDevV2Model> }>;

/** Prices as models.dev lists them. Missing prices stay undefined. */
export interface ModelsDevCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Context-size tiers. Unlisted rates fall back to the base rates. */
	tiers?: Array<{ above: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
}

/** One API a model is served on, in the order models.dev lists them. */
export interface ModelsDevApi {
	protocol: string;
	baseUrl: string;
	aisdk?: string;
}

/** A models.dev model normalized for the catalog. */
export interface ModelsDevModel {
	id: string;
	name: string;
	type: string;
	status?: string;
	toolCall: boolean;
	structuredOutput: boolean;
	reasoning: boolean;
	/** Undefined when the model does not reason. */
	reasoningOptions?: ModelsDevReasoningOption[];
	imageInput: boolean;
	textInput: boolean;
	textOutput: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost: ModelsDevCost;
	apis: ModelsDevApi[];
	/** The full v2 entry, for fields not normalized above. */
	source: ModelsDevV2Model;
}

/** Provider-agnostic decision model metadata from models.dev. */
export interface ModelsDevDecisionMetadata {
	id: string;
	type?: string;
	name: string;
	limit?: { context?: number };
}

function firstPrice(write: number | Record<string, number> | undefined): number | undefined {
	return typeof write === "object" ? Object.values(write)[0] : write;
}

// models.dev lists one cache write price per TTL; the first is the host's default.
function cacheWritePrice(cache: V2CachePrices | undefined): number | undefined {
	return firstPrice(cache?.write) ?? firstPrice(cache?.explicit?.write);
}

function contextThreshold(when: Record<string, unknown>): number | undefined {
	const keys = Object.keys(when);
	if (keys.length !== 1 || keys[0] !== "context") return undefined;
	const context = when.context as { gt?: unknown; gte?: unknown };
	const size = context.gt ?? context.gte;
	return typeof size === "number" ? size : undefined;
}

function normalizeCost(cost: ModelsDevV2Model["cost"]): ModelsDevCost {
	const input = cost?.text?.input;
	const output = cost?.text?.output;
	const perToken = (unit: string | undefined) => unit === undefined || unit === "token";
	if (!input || !output || !perToken(input.unit) || !perToken(output.unit)) return {};

	// Only context-size overrides map onto pi's cost tiers. Region, service-tier,
	// and time-based prices have no pi equivalent yet.
	const tiers = new Map<number, NonNullable<ModelsDevCost["tiers"]>[number]>();
	const tier = (above: number) => {
		let entry = tiers.get(above);
		if (!entry) {
			entry = { above };
			tiers.set(above, entry);
		}
		return entry;
	};
	for (const override of input.overrides ?? []) {
		const above = contextThreshold(override.when);
		if (above === undefined) continue;
		const entry = tier(above);
		if (override.price !== undefined) entry.input = override.price;
		if (override.cache?.read !== undefined) entry.cacheRead = override.cache.read;
		const cacheWrite = cacheWritePrice(override.cache);
		if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
	}
	for (const override of output.overrides ?? []) {
		const above = contextThreshold(override.when);
		if (above === undefined) continue;
		if (override.price !== undefined) tier(above).output = override.price;
	}

	return {
		input: input.price,
		output: output.price,
		cacheRead: input.cache?.read,
		cacheWrite: cacheWritePrice(input.cache),
		...(tiers.size > 0 ? { tiers: [...tiers.values()] } : {}),
	};
}

function reasoningOptions(reasoning: ModelsDevV2Model["capabilities"]["reasoning"]): ModelsDevReasoningOption[] {
	const options: ModelsDevReasoningOption[] = [];
	if (reasoning.toggle) options.push({ type: "toggle" });
	if (reasoning.effort !== undefined) options.push({ type: "effort", values: reasoning.effort });
	if (reasoning.budget !== undefined) options.push({ type: "budget_tokens", ...reasoning.budget });
	return options;
}

export function normalizeModelsDevModel(model: ModelsDevV2Model): ModelsDevModel {
	const input = model.modalities?.input ?? [];
	const reasoning = model.capabilities?.reasoning;
	return {
		id: model.id,
		name: model.name,
		type: model.type,
		status: model.status,
		toolCall: model.capabilities?.tools?.supported === true,
		structuredOutput: model.capabilities?.structured_output === true,
		reasoning: reasoning?.supported === true,
		reasoningOptions: reasoning?.supported ? reasoningOptions(reasoning) : undefined,
		imageInput: input.some((modality) => modality === "image" || modality.startsWith("image/")),
		textInput: input.includes("text"),
		textOutput: (model.modalities?.output ?? []).includes("text"),
		contextWindow: model.limit?.context,
		maxTokens: model.limit?.output,
		cost: normalizeCost(model.cost),
		apis: Object.entries(model.api ?? {}).map(([protocol, entry]) => ({
			protocol,
			baseUrl: entry.base_url,
			aisdk: entry.sdk?.aisdk,
		})),
		source: model,
	};
}

export function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

/** Converts models.dev prices to pi's cost shape. Missing rates are free. */
export function modelsDevCost(cost: ModelsDevCost): ModelCost {
	const base = {
		input: cost.input || 0,
		output: cost.output || 0,
		cacheRead: cost.cacheRead || 0,
		cacheWrite: cost.cacheWrite || 0,
	};
	const tiers = cost.tiers?.map((tier) => ({
		inputTokensAbove: tier.above,
		input: tier.input ?? base.input,
		output: tier.output ?? base.output,
		cacheRead: tier.cacheRead ?? base.cacheRead,
		cacheWrite: tier.cacheWrite ?? base.cacheWrite,
	}));
	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}

/**
 * Chat models of one models.dev provider. Specialized types (image, speech,
 * realtime, decision, ...) only appear in v2 and are left out here.
 */
export function modelsDevChatModels(catalog: ModelsDevV2Catalog, provider: string): ModelsDevModel[] {
	return (
		Object.values(catalog[provider]?.models ?? {})
			// Unlike pi models, models.dev v2 always states the type.
			.filter(({ type }) => type === "chat")
			.map(normalizeModelsDevModel)
	);
}
