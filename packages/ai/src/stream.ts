import { type AnthropicOptions, streamAnthropic } from "./providers/anthropic.js";
import { type GoogleOptions, streamGoogle } from "./providers/google.js";
import {
	type GoogleCloudCodeAssistOptions,
	streamGoogleCloudCodeAssist,
} from "./providers/google-cloud-code-assist.js";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "./providers/openai-completions.js";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "./providers/openai-responses.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	KnownProvider,
	Model,
	OptionsForApi,
	ReasoningEffort,
	SimpleStreamOptions,
} from "./types.js";

const apiKeys: Map<string, string> = new Map();

export function setApiKey(provider: KnownProvider, key: string): void;
export function setApiKey(provider: string, key: string): void;
export function setApiKey(provider: any, key: string): void {
	apiKeys.set(provider, key);
}

export function getApiKey(provider: KnownProvider): string | undefined;
export function getApiKey(provider: string): string | undefined;
export function getApiKey(provider: any): string | undefined {
	// Check explicit keys first
	const key = apiKeys.get(provider);
	if (key) return key;

	// Fall back to environment variables
	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GEMINI_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		zai: "ZAI_API_KEY",
		mistral: "MISTRAL_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? process.env[envVar] : undefined;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey || getApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	const providerOptions = { ...options, apiKey };

	const api: Api = model.api;
	switch (api) {
		case "anthropic-messages":
			return streamAnthropic(model as Model<"anthropic-messages">, context, providerOptions);

		case "openai-completions":
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);

		case "openai-responses":
			return streamOpenAIResponses(model as Model<"openai-responses">, context, providerOptions as any);

		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, providerOptions);

		case "google-cloud-code-assist":
			return streamGoogleCloudCodeAssist(
				model as Model<"google-cloud-code-assist">,
				context,
				providerOptions as any,
			);

		default: {
			// This should never be reached if all Api cases are handled
			const _exhaustive: never = api;
			throw new Error(`Unhandled API: ${_exhaustive}`);
		}
	}
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey || getApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const providerOptions = mapOptionsForApi(model, options, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const base = {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
	};

	switch (model.api) {
		case "anthropic-messages": {
			if (!options?.reasoning) return base satisfies AnthropicOptions;

			// Opus 4.5 supports larger thinking budgets - geometric 4x progression, 1024-aligned
			const isOpus45 = model.id.includes("opus-4-5") || model.id.includes("opus-4.5");
			const anthropicBudgets = isOpus45
				? {
						minimal: 1024, // 1KB
						low: 4096, // 4KB
						medium: 16384, // 16KB
						high: 32768, // 32KB
						xhigh: 65536, // 64KB
					}
				: {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 32768,
					};

			return {
				...base,
				thinkingEnabled: true,
				thinkingBudgetTokens: anthropicBudgets[options.reasoning],
			} satisfies AnthropicOptions;
		}

		case "openai-completions":
			return {
				...base,
				reasoningEffort: options?.reasoning,
			} satisfies OpenAICompletionsOptions;

		case "openai-responses":
			return {
				...base,
				reasoningEffort: options?.reasoning,
			} satisfies OpenAIResponsesOptions;

		case "google-generative-ai": {
			if (!options?.reasoning) return base as any;

			const googleBudget = getGoogleBudget(model as Model<"google-generative-ai">, options.reasoning);
			return {
				...base,
				thinking: {
					enabled: true,
					budgetTokens: googleBudget,
				},
			} satisfies GoogleOptions;
		}

		case "google-cloud-code-assist": {
			if (!options?.reasoning) return base as any;

			const googleBudget = getGoogleBudget(model as any, options.reasoning);
			return {
				...base,
				thinking: {
					enabled: true,
					budgetTokens: googleBudget,
				},
			} satisfies GoogleCloudCodeAssistOptions;
		}

		default: {
			// Exhaustiveness check
			const _exhaustive: never = model.api;
			throw new Error(`Unhandled API in mapOptionsForApi: ${_exhaustive}`);
		}
	}
}

function getGoogleBudget(model: Model<"google-generative-ai">, effort: ReasoningEffort): number {
	// See https://ai.google.dev/gemini-api/docs/thinking#set-budget
	if (model.id.includes("2.5-pro")) {
		const budgets = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
			xhigh: 65536,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash")) {
		// Covers 2.5-flash-lite as well
		const budgets = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
			xhigh: 49152,
		};
		return budgets[effort];
	}

	// Unknown model - use dynamic
	return -1;
}
