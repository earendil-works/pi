import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";

/**
 * Centralized proxy decision logic.
 *
 * Determines whether to use a CORS proxy for LLM API requests based on:
 * - Provider name
 * - API key pattern (for providers where it matters)
 */

/**
 * Check if a provider/API key combination requires a CORS proxy.
 *
 * @param provider - Provider name (e.g., "anthropic", "openai", "zai")
 * @param apiKey - API key for the provider
 * @returns true if proxy is required, false otherwise
 */
export function shouldUseProxyForProvider(provider: string, apiKey: string): boolean {
	switch (provider.toLowerCase()) {
		case "zai":
			// Z-AI always requires proxy
			return true;

		case "anthropic":
			// Anthropic OAuth tokens (sk-ant-oat-*) require proxy
			// Regular API keys (sk-ant-api-*) do NOT require proxy
			return apiKey.startsWith("sk-ant-oat") || apiKey.startsWith("{");

		case "openai-codex":
			// Codex uses chatgpt.com/backend-api which has no CORS
			return true;

		// These providers work without proxy
		case "openai":
		case "google":
		case "groq":
		case "openrouter":
		case "cerebras":
		case "xai":
		case "ollama":
		case "lmstudio":
		case "github-copilot":
			return false;

		// Unknown providers - assume no proxy needed
		// This allows new providers to work by default
		default:
			return false;
	}
}

/**
 * Apply CORS proxy to a model's baseUrl if needed.
 *
 * @param model - The model to potentially proxy
 * @param apiKey - API key for the provider
 * @param proxyUrl - CORS proxy URL (e.g., "https://proxy.mariozechner.at/proxy")
 * @returns Model with modified baseUrl if proxy is needed, otherwise original model
 */
export function applyProxyIfNeeded<T extends Api>(model: Model<T>, apiKey: string, proxyUrl?: string): Model<T> {
	// If no proxy URL configured, return original model
	if (!proxyUrl) {
		return model;
	}

	// If model has no baseUrl, can't proxy it
	if (!model.baseUrl) {
		return model;
	}

	// Check if this provider/key needs proxy
	if (!shouldUseProxyForProvider(model.provider, apiKey)) {
		return model;
	}

	// Apply proxy to baseUrl
	return {
		...model,
		baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
	};
}

/**
 * Check if an error is likely a CORS error.
 *
 * CORS errors in browsers typically manifest as:
 * - TypeError with message "Failed to fetch"
 * - NetworkError
 *
 * @param error - The error to check
 * @returns true if error is likely a CORS error
 */
export function isCorsError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	// Check for common CORS error patterns
	const message = error.message.toLowerCase();

	// "Failed to fetch" is the standard CORS error in most browsers
	if (error.name === "TypeError" && message.includes("failed to fetch")) {
		return true;
	}

	// Some browsers report "NetworkError"
	if (error.name === "NetworkError") {
		return true;
	}

	// CORS-specific messages
	if (message.includes("cors") || message.includes("cross-origin")) {
		return true;
	}

	return false;
}

/**
 * Create a streamFn that applies CORS proxy when needed.
 * Reads proxy settings from storage on each call.
 *
 * @param getProxyUrl - Async function to get current proxy URL (or undefined if disabled)
 * @returns A streamFn compatible with Agent's streamFn option
 */
export function createStreamFn(getProxyUrl: () => Promise<string | undefined>) {
	return async (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		const apiKey = options?.apiKey;
		const proxyUrl = await getProxyUrl();

		if (!apiKey || !proxyUrl) {
			return streamSimple(model, context, options);
		}

		const proxiedModel = applyProxyIfNeeded(model, apiKey, proxyUrl);
		return streamSimple(proxiedModel, context, options);
	};
}
