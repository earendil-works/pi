import type { ModelCost, ModelCostTier, ModelServiceTier } from "../types.ts";

/** OpenRouter's per-token prices, as decimal strings. */
export interface OpenRouterPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	overrides?: OpenRouterPricingOverride[];
}

/**
 * A conditional price. `min_prompt_tokens` selects prompt-length pricing; `utc_*` fields select
 * time-of-day or weekday pricing. Missing rates keep the base price.
 */
export interface OpenRouterPricingOverride {
	min_prompt_tokens?: number;
	utc_start?: number;
	utc_end?: number;
	utc_days?: string[];
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

/** The fields pi reads from a model in OpenRouter's `GET /models` and `GET /models/user`. */
export interface OpenRouterModel {
	id: string;
	context_length?: number | null;
	top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
	pricing?: OpenRouterPricing;
	/** Non-default tiers the model sells, cheapest first, as `service_tier` request values. */
	service_tiers?: string[] | null;
}

/**
 * Convert OpenRouter's tier ids into pi service tiers, labelled for a speed picker.
 * An absent or null list means the listing does not say, which keeps any tier the
 * caller already knows; an explicit empty list means the model sells none.
 */
export function openRouterServiceTiers(
	serviceTiers: readonly string[] | null | undefined,
): ModelServiceTier[] | undefined {
	if (serviceTiers === null || serviceTiers === undefined) return undefined;
	return serviceTiers.map((id) => ({ id, name: openRouterServiceTierName(id) }));
}

/** OpenRouter's own tier vocabulary, with a title-cased fallback for a tier pi has not seen yet. */
function openRouterServiceTierName(id: string): string {
	const known: Record<string, string> = { flex: "Flex", priority: "Priority", ultrafast: "Ultrafast" };
	return known[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Convert one $/token price to $/1M tokens. 0 means free. Missing, invalid and negative prices use
 * the fallback: OpenRouter reports -1 for router models such as `openrouter/auto`, whose price
 * depends on the model they pick.
 */
function perMillion(value: string | undefined, fallback: number): number {
	const perToken = Number.parseFloat(value ?? "");
	return perToken >= 0 ? Number((perToken * 1_000_000).toFixed(6)) : fallback;
}

/**
 * Convert OpenRouter's $/token prices to pi's $/1M tokens. Missing, invalid and negative base
 * prices are 0. Prompt-length overrides become request-wide tiers; a rate a tier does not list
 * keeps the base price. Time-of-day overrides are skipped because ModelCost cannot express them.
 */
export function openRouterCost(pricing: OpenRouterPricing | undefined): ModelCost {
	const base = {
		input: perMillion(pricing?.prompt, 0),
		output: perMillion(pricing?.completion, 0),
		cacheRead: perMillion(pricing?.input_cache_read, 0),
		cacheWrite: perMillion(pricing?.input_cache_write, 0),
	};
	const tiers = (pricing?.overrides ?? []).flatMap((override): ModelCostTier[] => {
		if (
			override.min_prompt_tokens === undefined ||
			override.utc_start !== undefined ||
			override.utc_end !== undefined ||
			override.utc_days !== undefined
		) {
			return [];
		}
		return [
			{
				inputTokensAbove: override.min_prompt_tokens,
				input: perMillion(override.prompt, base.input),
				output: perMillion(override.completion, base.output),
				cacheRead: perMillion(override.input_cache_read, base.cacheRead),
				cacheWrite: perMillion(override.input_cache_write, base.cacheWrite),
			},
		];
	});
	return tiers.length > 0 ? { ...base, tiers } : base;
}
