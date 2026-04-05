import { supportsXhigh } from "./models.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamGoogle } from "./providers/google.js";
import { streamGoogleGeminiCli } from "./providers/google-gemini-cli.js";
import { streamOpenAICodexResponses } from "./providers/openai-codex-responses.js";
import { streamOpenAICompletions } from "./providers/openai-completions.js";
import { streamOpenAIResponses } from "./providers/openai-responses.js";
import { getOAuthApiKey, getOAuthProviderForModelProvider } from "./utils/oauth/index.js";
const apiKeys = new Map();
export function setApiKey(provider, key) {
    apiKeys.set(provider, key);
}
const envKeyByProvider = {
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
export function getApiKey(provider) {
    // Check explicit keys first
    const key = apiKeys.get(provider);
    if (key)
        return key;
    // Fall back to environment variables
    if (provider === "github-copilot") {
        return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    }
    const envVar = envKeyByProvider[provider];
    return envVar ? process.env[envVar] : undefined;
}
export function getEnvApiKey(provider) {
    if (provider === "github-copilot") {
        return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    }
    const envVar = envKeyByProvider[provider];
    return envVar ? process.env[envVar] : undefined;
}
export async function resolveApiKey(provider) {
    // Check explicit keys first
    const key = apiKeys.get(provider);
    if (key)
        return key;
    // Check OAuth credentials (auto-refresh if expired)
    const oauthProvider = getOAuthProviderForModelProvider(provider);
    if (oauthProvider) {
        const oauthKey = await getOAuthApiKey(oauthProvider);
        if (oauthKey)
            return oauthKey;
    }
    // Fall back to sync getApiKey for env vars
    return getApiKey(provider);
}
export function stream(model, context, options) {
    const apiKey = options?.apiKey || getApiKey(model.provider);
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    const providerOptions = { ...options, apiKey };
    const api = model.api;
    switch (api) {
        case "anthropic-messages":
            return streamAnthropic(model, context, providerOptions);
        case "openai-completions":
            return streamOpenAICompletions(model, context, providerOptions);
        case "openai-responses":
            return streamOpenAIResponses(model, context, providerOptions);
        case "openai-codex-responses":
            return streamOpenAICodexResponses(model, context, providerOptions);
        case "google-generative-ai":
            return streamGoogle(model, context, providerOptions);
        case "google-gemini-cli":
            return streamGoogleGeminiCli(model, context, providerOptions);
        case "zai-completions":
            // Z.ai uses OpenAI-compatible completions API
            return streamOpenAICompletions(model, context, providerOptions);
        default: {
            // This should never be reached if all Api cases are handled
            const _exhaustive = api;
            throw new Error(`Unhandled API: ${_exhaustive}`);
        }
    }
}
export async function complete(model, context, options) {
    const s = stream(model, context, options);
    return s.result();
}
export function streamSimple(model, context, options) {
    const apiKey = options?.apiKey || getApiKey(model.provider);
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    const providerOptions = mapOptionsForApi(model, options, apiKey);
    return stream(model, context, providerOptions);
}
export async function completeSimple(model, context, options) {
    const s = streamSimple(model, context, options);
    return s.result();
}
function mapOptionsForApi(model, options, apiKey) {
    const base = {
        temperature: options?.temperature,
        maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
        signal: options?.signal,
        apiKey: apiKey || options?.apiKey,
        fastMode: options?.fastMode,
    };
    // Helper to clamp xhigh to high for providers that don't support it
    const clampReasoning = (effort) => (effort === "xhigh" ? "high" : effort);
    switch (model.api) {
        case "anthropic-messages": {
            // Explicitly disable thinking when reasoning is not specified
            if (!options?.reasoning) {
                return { ...base, thinkingEnabled: false };
            }
            if (supportsAdaptiveAnthropicThinking(model.id)) {
                return {
                    ...base,
                    thinkingEnabled: true,
                    effort: mapReasoningToAnthropicEffort(options.reasoning, model.id),
                };
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
                thinkingBudgetTokens: anthropicBudgets[clampReasoning(options.reasoning)],
            };
        }
        case "openai-completions":
            return {
                ...base,
                reasoningEffort: supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning),
            };
        case "openai-responses":
            return {
                ...base,
                reasoningEffort: supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning),
            };
        case "openai-codex-responses":
            return {
                ...base,
                reasoningEffort: supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning),
            };
        case "google-generative-ai": {
            // Explicitly disable thinking when reasoning is not specified
            // This is needed because Gemini has "dynamic thinking" enabled by default
            if (!options?.reasoning) {
                return { ...base, thinking: { enabled: false } };
            }
            const googleModel = model;
            const effort = clampReasoning(options.reasoning);
            // Use budgetTokens for thinking (compatible with local @google/genai)
            return {
                ...base,
                thinking: {
                    enabled: true,
                    budgetTokens: getGoogleBudget(googleModel, effort),
                },
            };
        }
        case "google-gemini-cli": {
            if (!options?.reasoning) {
                return { ...base, thinking: { enabled: false } };
            }
            const effort = clampReasoning(options.reasoning);
            // Use budgetTokens for all models (simpler approach compatible with local @google/genai)
            const budgets = {
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
            };
        }
        case "zai-completions":
            return base;
        default: {
            // Exhaustiveness check
            const _exhaustive = model.api;
            throw new Error(`Unhandled API in mapOptionsForApi: ${_exhaustive}`);
        }
    }
}
function supportsAdaptiveAnthropicThinking(modelId) {
    return (modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6") ||
        modelId.includes("sonnet-4-6") ||
        modelId.includes("sonnet-4.6"));
}
function mapReasoningToAnthropicEffort(reasoning, modelId) {
    switch (reasoning) {
        case "minimal":
        case "low":
            return "low";
        case "medium":
            return "medium";
        case "high":
            return "high";
        case "xhigh":
            return modelId.includes("opus-4-6") ||
                modelId.includes("opus-4.6") ||
                modelId.includes("sonnet-4-6") ||
                modelId.includes("sonnet-4.6")
                ? "max"
                : "high";
    }
}
function getGoogleBudget(model, effort) {
    // See https://ai.google.dev/gemini-api/docs/thinking#set-budget
    if (model.id.includes("2.5-pro")) {
        const budgets = {
            minimal: 128,
            low: 2048,
            medium: 8192,
            high: 32768,
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
        };
        return budgets[effort];
    }
    // Unknown model - use dynamic
    return -1;
}
//# sourceMappingURL=stream.js.map