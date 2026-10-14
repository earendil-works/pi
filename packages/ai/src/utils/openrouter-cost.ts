import type { Usage } from "../types.ts";

export interface OpenRouterUsageAccounting {
	/** Amount charged to the user's OpenRouter account. */
	cost: number | null;
	/** Whether OpenRouter used the user's upstream provider key. */
	is_byok: boolean;
	cost_details: {
		/** Total inference cost billed through the user's upstream provider account, when available. */
		upstream_inference_cost: number | null;
		/** Upstream cost for prompt processing, including any provider-side cache pricing. */
		upstream_inference_prompt_cost: number;
		/** Upstream cost for completion generation. */
		upstream_inference_completions_cost: number;
		/** Metered server-tool cost already included in OpenRouter's charged `cost`. */
		server_tool_cost?: number | null;
	} | null;
}

function isValidCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isOpenRouterModel(model: { provider: string; baseUrl: string }): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
}

/** Replace the catalog total with OpenRouter's billed cost when the response contains complete, valid accounting. */
export function applyOpenRouterReportedCost(usage: Usage, reported: OpenRouterUsageAccounting): void {
	if (!isValidCost(reported.cost)) return;

	if (reported.is_byok === false) {
		usage.cost.total = reported.cost;
		return;
	}

	if (reported.is_byok === true) {
		const details = reported.cost_details;
		if (!details) return;
		let upstreamCost: unknown = details.upstream_inference_cost;
		if (upstreamCost === null) {
			if (
				!isValidCost(details.upstream_inference_prompt_cost) ||
				!isValidCost(details.upstream_inference_completions_cost)
			) {
				return;
			}
			upstreamCost = details.upstream_inference_prompt_cost + details.upstream_inference_completions_cost;
		}
		if (!isValidCost(upstreamCost)) return;
		usage.cost.total = reported.cost + upstreamCost;
	}
}
