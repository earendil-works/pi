import type { Context } from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

export const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

interface ContextWindowModel {
	id: string;
	provider: string;
	contextWindow: number;
}

export function resolveOpenAIResponsesMaxOutputTokens(
	model: ContextWindowModel,
	context: Context,
	maxTokens: number | undefined,
): number | undefined {
	if (maxTokens === undefined) return undefined;
	if (maxTokens >= OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) return maxTokens;
	if (model.contextWindow <= 0) return OPENAI_RESPONSES_MIN_OUTPUT_TOKENS;

	const usedTokens = estimateContextTokens(context).tokens;
	const remainingTokens = model.contextWindow - usedTokens;
	if (remainingTokens >= OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) return OPENAI_RESPONSES_MIN_OUTPUT_TOKENS;

	throw new Error(
		`Context is exhausted for ${model.provider}/${model.id}: OpenAI Responses requires at least ${OPENAI_RESPONSES_MIN_OUTPUT_TOKENS} output tokens, but only ${Math.max(0, remainingTokens)} estimated context tokens remain (${usedTokens}/${model.contextWindow} used). Compact the conversation or reduce tool output before retrying.`,
	);
}
