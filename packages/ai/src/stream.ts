import { supportsXhigh } from "./models.js";
import { type AnthropicOptions, streamAnthropic } from "./providers/anthropic.js";
import { type GoogleOptions, streamGoogle } from "./providers/google.js";
import { type GoogleGeminiCliOptions, streamGoogleGeminiCli } from "./providers/google-gemini-cli.js";
import { streamOpenAICodexResponses } from "./providers/openai-codex-responses.js";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "./providers/openai-completions.js";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "./providers/openai-responses.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	KnownProvider,
	Model,
	OpenAICodexResponsesOptions,
	OptionsForApi,
	ReasoningEffort,
	SimpleStreamOptions,
	ZAICompletionsOptions,
} from "./types.js";
import { getOAuthApiKey, getOAuthProviderForModelProvider } from "./utils/oauth/index.js";

const apiKeys: Map<string, string> = new Map();

export function setApiKey(provider: KnownProvider, key: string): void;
export function setApiKey(provider: string, key: string): void;
export function setApiKey(provider: any, key: string): void {
	apiKeys.set(provider, key);
}

const envKeyByProvider: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	synthetic: "SYNTHETIC_API_KEY",
};

/**
 * Get API key from environment variables (sync).
 * Does NOT check OAuth credentials - use resolveApiKey() for OAuth support.
 */
export function getApiKey(provider: KnownProvider): string | undefined;
export function getApiKey(provider: string): string | undefined;
export function getApiKey(provider: any): string | undefined {
	// Check explicit keys first
	const key = apiKeys.get(provider);
	if (key) return key;

	// Fall back to environment variables
	if (provider === "github-copilot") {
		return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	}

	const envVar = envKeyByProvider[provider];
	return envVar ? process.env[envVar] : undefined;
}

export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: KnownProvider | string): string | undefined {
	if (provider === "github-copilot") {
		return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	}

	const envVar = envKeyByProvider[provider];
	return envVar ? process.env[envVar] : undefined;
}

/**
 * Resolve API key from OAuth credentials or environment (async).
 * Automatically refreshes expired OAuth tokens.
 *
 * Priority:
 * 1. Explicitly set keys (via setApiKey)
 * 2. OAuth credentials from ~/.mu/agent/oauth.json
 * 3. Environment variables
 */
export async function resolveApiKey(provider: KnownProvider): Promise<string | undefined>;
export async function resolveApiKey(provider: string): Promise<string | undefined>;
export async function resolveApiKey(provider: any): Promise<string | undefined> {
	// Check explicit keys first
	const key = apiKeys.get(provider);
	if (key) return key;

	// Check OAuth credentials (auto-refresh if expired)
	const oauthProvider = getOAuthProviderForModelProvider(provider);
	if (oauthProvider) {
		const oauthKey = await getOAuthApiKey(oauthProvider);
		if (oauthKey) return oauthKey;
	}

	// Fall back to sync getApiKey for env vars
	return getApiKey(provider);
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

		case "openai-codex-responses":
			return streamOpenAICodexResponses(
				model as Model<"openai-codex-responses">,
				context,
				providerOptions as OpenAICodexResponsesOptions,
			);

		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, providerOptions);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				model as Model<"google-gemini-cli">,
				context,
				providerOptions as GoogleGeminiCliOptions,
			);

		case "zai-completions":
			// Z.ai uses OpenAI-compatible completions API
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);

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

	// Helper to clamp xhigh to high for providers that don't support it
	const clampReasoning = (effort: ReasoningEffort | undefined) => (effort === "xhigh" ? "high" : effort);

	switch (model.api) {
		case "anthropic-messages": {
			// Explicitly disable thinking when reasoning is not specified
			if (!options?.reasoning) {
				return { ...base, thinkingEnabled: false } satisfies AnthropicOptions;
			}

			const anthropicBudgets = {
				minimal: 1024,
				low: 2048,
				medium: 8192,
				high: 16384,
			};

			return {
				...base,
				thinkingEnabled: true,
				thinkingBudgetTokens: anthropicBudgets[clampReasoning(options.reasoning)!],
			} satisfies AnthropicOptions;
		}

		case "openai-completions":
			return {
				...base,
				reasoningEffort: supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning),
			} satisfies OpenAICompletionsOptions;

		case "openai-responses":
			return {
				...base,
				reasoningEffort: supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning),
			} satisfies OpenAIResponsesOptions;

		case "openai-codex-responses":
			return {
				...base,
				reasoningEffort: supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning),
			} satisfies OpenAICodexResponsesOptions;

		case "google-generative-ai": {
			// Explicitly disable thinking when reasoning is not specified
			// This is needed because Gemini has "dynamic thinking" enabled by default
			if (!options?.reasoning) {
				return { ...base, thinking: { enabled: false } } satisfies GoogleOptions;
			}

			const googleModel = model as Model<"google-generative-ai">;
			const effort = clampReasoning(options.reasoning)!;

			// Use budgetTokens for thinking (compatible with local @google/genai)
			return {
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(googleModel, effort),
				},
			} satisfies GoogleOptions;
		}

		case "google-gemini-cli": {
			if (!options?.reasoning) {
				return { ...base, thinking: { enabled: false } } satisfies GoogleGeminiCliOptions;
			}

			const effort = clampReasoning(options.reasoning)!;

			// Use budgetTokens for all models (simpler approach compatible with local @google/genai)
			const budgets: Record<ClampedReasoningEffort, number> = {
				minimal: 1024,
				low: 2048,
				medium: 8192,
				high: 16384,
			};

			return {
				...base,
				thinking: {
					enabled: true,
					budgetTokens: budgets[effort],
				},
			} satisfies GoogleGeminiCliOptions;
		}

		case "zai-completions":
			return base as ZAICompletionsOptions;

		default: {
			// Exhaustiveness check
			const _exhaustive: never = model.api;
			throw new Error(`Unhandled API in mapOptionsForApi: ${_exhaustive}`);
		}
	}
}

type ClampedReasoningEffort = Exclude<ReasoningEffort, "xhigh">;

function getGoogleBudget(model: Model<"google-generative-ai">, effort: ClampedReasoningEffort): number {
	// See https://ai.google.dev/gemini-api/docs/thinking#set-budget
	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ClampedReasoningEffort, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash")) {
		// Covers 2.5-flash-lite as well
		const budgets: Record<ClampedReasoningEffort, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	// Unknown model - use dynamic
	return -1;
}
