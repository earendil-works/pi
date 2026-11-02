import type { ClassifierModel, Model, ModelCost, ModelCostRates, ModelCostTier } from "../../src/types.ts";

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
// TypeSafe-compatible System One endpoint for evaluation models.
// https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
const AI_GATEWAY_TYPESAFE_BASE_URL = "https://ai-gateway.vercel.sh/typesafe/v1";

/** A prompt-length bracket. `min` is inclusive and `max` exclusive, both in prompt tokens. */
export interface AiGatewayPriceTier {
	cost?: string | number;
	min?: number;
	max?: number;
}

/** Vercel AI Gateway pricing in $/token. */
export interface AiGatewayPricing {
	input?: string | number;
	output?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
	input_tiers?: AiGatewayPriceTier[];
	output_tiers?: AiGatewayPriceTier[];
	input_cache_read_tiers?: AiGatewayPriceTier[];
	input_cache_write_tiers?: AiGatewayPriceTier[];
}

const RATE_FIELDS = [
	{ rate: "input", tiers: "input_tiers" },
	{ rate: "output", tiers: "output_tiers" },
	{ rate: "cacheRead", tiers: "input_cache_read_tiers" },
	{ rate: "cacheWrite", tiers: "input_cache_write_tiers" },
] as const;

function perMillion(value: string | number | undefined): number {
	const parsed = typeof value === "number" ? value : parseFloat(value ?? "0");
	return Number.isFinite(parsed) ? Number((parsed * 1_000_000).toFixed(6)) : 0;
}

/**
 * Convert AI Gateway pricing to $/million tokens. Each rate lists its own prompt-length brackets;
 * every bracket start above zero becomes a request-wide tier with the rates in effect there.
 */
export function getAiGatewayCost(pricing: AiGatewayPricing | undefined): ModelCost {
	const base: ModelCostRates = {
		input: perMillion(pricing?.input),
		output: perMillion(pricing?.output),
		cacheRead: perMillion(pricing?.input_cache_read),
		cacheWrite: perMillion(pricing?.input_cache_write),
	};

	const starts = new Set<number>();
	for (const field of RATE_FIELDS) {
		for (const bracket of pricing?.[field.tiers] ?? []) {
			if (bracket.min !== undefined && bracket.min > 0) starts.add(bracket.min);
		}
	}

	const tiers = [...starts]
		.sort((a, b) => a - b)
		.map((start): ModelCostTier => {
			const tier: ModelCostTier = { inputTokensAbove: start - 1, ...base };
			for (const field of RATE_FIELDS) {
				const bracket = pricing?.[field.tiers]?.find(
					(candidate) => (candidate.min ?? 0) <= start && (candidate.max === undefined || start < candidate.max),
				);
				if (bracket?.cost !== undefined) tier[field.rate] = perMillion(bracket.cost);
			}
			return tier;
		});

	return tiers.length > 0 ? { ...base, tiers } : base;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	type?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: AiGatewayPricing;
}

export interface AiGatewayCatalog {
	chat: Model<"anthropic-messages">[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}

/** Fetch tool-capable chat models and evaluation (classifier) models. */
export async function fetchAiGatewayCatalog(): Promise<AiGatewayCatalog> {
	const response = await fetch(AI_GATEWAY_MODELS_URL);
	if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
	const data = (await response.json()) as { data?: unknown };
	const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
	const chat: AiGatewayCatalog["chat"] = [];
	const classifiers: AiGatewayCatalog["classifiers"] = [];

	for (const model of items) {
		// Evaluation models such as TypeSafe's Jev are served through the
		// TypeSafe-compatible System One endpoint.
		if (model.type === "evaluation") {
			classifiers.push({
				type: "classifier",
				id: model.id,
				name: model.name || model.id,
				api: "typesafe-system-one",
				provider: "vercel-ai-gateway",
				baseUrl: AI_GATEWAY_TYPESAFE_BASE_URL,
				input: ["text"],
				cost: {
					input: perMillion(model.pricing?.input),
					output: perMillion(model.pricing?.output),
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: model.context_window || 4096,
			});
			continue;
		}
		const tags = Array.isArray(model.tags) ? model.tags : [];
		// Only include models that support tools
		if (!tags.includes("tool-use")) continue;

		chat.push({
			id: model.id,
			name: model.name || model.id,
			api: "anthropic-messages",
			baseUrl: AI_GATEWAY_BASE_URL,
			provider: "vercel-ai-gateway",
			reasoning: tags.includes("reasoning"),
			input: tags.includes("vision") ? ["text", "image"] : ["text"],
			compat: { allowEmptySignature: true },
			cost: getAiGatewayCost(model.pricing),
			contextWindow: model.context_window || 4096,
			maxTokens: model.max_tokens || 4096,
		});
	}
	return { chat, classifiers };
}
