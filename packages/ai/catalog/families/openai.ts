// OpenAI GPT models: facts that hold on every host that serves them.

import type { Api, Model, ModelCost } from "../../src/types.ts";
import { type ChatModel, mergeCompat, mergeThinking } from "../define.ts";
import { roundCost } from "../sources/models-dev.ts";

export const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;

/** OpenAI bills prompts above 272K input tokens at 2x input and 1.5x output rates. */
export function withOpenAiLongContextPricing(cost: ModelCost): ModelCost {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

// Keep current OpenAI prices authoritative until models.dev and passthrough
// catalogs catch up.
// https://developers.openai.com/api/docs/pricing
export const OPENAI_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
};

/** The standard price of an OpenAI model with long-context pricing. */
export function openAiStandardCost(id: string): ModelCost {
	return withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS[id]);
}

// GPT-5.5 and older put tools loaded through tool search or additional_tools in a namespace named
// after the tool and reject replayed calls without it, so history from other models fails there
// (#11415). Like Codex, dynamic tool loading therefore starts with GPT-5.6, which does not do this.
/** Models that accept tool search and `additional_tools`. */
export const OPENAI_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);
/** Models that accept mid-conversation developer messages. */
export const OPENAI_MID_CONVO_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	...OPENAI_TOOL_SEARCH_MODEL_IDS,
]);

const RESPONSES_APIS = new Set<Api>(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

function isResponsesApi(model: ChatModel): boolean {
	return RESPONSES_APIS.has(model.api);
}

export function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		modelId.includes("gpt-6")
	);
}

const GPT_6_MODEL_IDS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"]);

/** Thinking levels of GPT models on any host. */
export function applyOpenAiFamilyRules(model: ChatModel): void {
	if ((model.api === "openai-responses" || model.api === "azure-openai-responses") && model.id.startsWith("gpt-5")) {
		mergeThinking(model, { off: null });
	}
	if (GPT_6_MODEL_IDS.has(model.id) && isResponsesApi(model)) {
		mergeThinking(model, {
			// GPT-6 Astra and GPT-6.1 Sol reject reasoning.effort "none"; GPT-6.1 Terra accepts it. All reject
			// "minimal" (verified on Codex, October 2026).
			off: model.id === "gpt-6-astra" || model.id === "gpt-6.1-sol" ? null : "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinking(model, { xhigh: "xhigh" });
	}
	if (
		(model.id.includes("gpt-5.6") || model.id.includes("gpt-6")) &&
		(isResponsesApi(model) || model.api === "openai-completions")
	) {
		mergeThinking(model, { max: "max" });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinking(model, { off: null, minimal: null, low: null });
	}
}

/**
 * OpenAI custom grammar tools on Responses endpoints. OpenAI rejects
 * `type: "custom"` tools for pre-GPT-5 models (gpt-4.x, gpt-4o, o-series).
 */
export function enableOpenAiGrammarTools(model: ChatModel): void {
	if (!isResponsesApi(model)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	mergeCompat(model as Model<"openai-responses">, { supportsOpenAIGrammarTools: true });
}

/**
 * Newer OpenAI Responses models accept developer messages after the
 * conversation has started. Proxies that pass them through also pass
 * `additional_tools` items through unchanged, for the models that accept them.
 */
export function enableOpenAiMidConvoSystemMessages(model: ChatModel, options: { proxy: boolean }): void {
	if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return;
	if (!OPENAI_MID_CONVO_MODEL_IDS.has(model.id)) return;
	mergeCompat(model as Model<"openai-responses">, {
		supportsMidConvoSystemMessages: true,
		...(options.proxy && OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id) ? { supportsAdditionalTools: true } : {}),
	});
}
