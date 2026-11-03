import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	Model,
	ModelThinkingLevel,
	SamplingParams,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
// OpenRouter counts the input with its own tokenizer and rejects input + max_tokens above the
// window before routing. It counted prose up to 12% above the provider's count (#10497).
const CONTEXT_SAFETY_RATIO = 0.15;
// The 15% margin is kept only while it leaves at least this much output. Otherwise (a nearly full
// large window, or any small window such as a 32k local model) only the fixed margin is kept, and
// output is capped at this size so an OpenRouter overcount still fits for a while before compaction.
const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
const MIN_MAX_TOKENS = 1;

/** Fit maxTokens into the context window, leaving room for the input being counted higher than estimated. */
export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const input = estimateContextTokens(context).tokens;
	const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(input * CONTEXT_SAFETY_RATIO));
	let room = model.contextWindow - input - margin;
	if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
		room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
	}
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
}

export function resolveSamplingParams(
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	return model.samplingParams || thinkingLevelParams || requestParams
		? { ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
		: undefined;
}

export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		telemetry: options?.telemetry,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		disableContinuation: options?.disableContinuation,
		headers: options?.headers,
		identity: options?.identity,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	const level = clampReasoning(reasoningLevel)!;
	return budgets[level]!;
}

/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
