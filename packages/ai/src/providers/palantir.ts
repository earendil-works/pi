import type { Api, Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";

// Import the official delegator streams
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.ts";
import { streamGoogle, streamSimpleGoogle } from "./google.ts";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.ts";

export interface PalantirOptions extends StreamOptions {
	/** Optional specific Palantir API key (overrides process.env.PALANTIR_API_KEY) */
	palantirApiKey?: string;
	/** Optional specific Palantir base URL (overrides process.env.PALANTIR_BASE_URL) */
	palantirBaseUrl?: string;
}

// Monkey-patch global fetch to bypass Google GenAI SDK's aggressive client-side model string validation.
// The SDK unconditionally crashes if the model ID contains ".." which Palantir requires (ri.language-model-service...).
if (!(globalThis as any).__palantirFetchPatched) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input: any | URL, init?: any) => {
		let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/api/v2/llm/proxy/google/v1/models/gemini-dummy")) {
			const headers = new Headers(init?.headers);
			// Also extract headers from a Request object if input is one
			if (typeof input !== "string" && !(input instanceof URL)) {
				input.headers.forEach((value: string, key: string) => {
					headers.append(key, value);
				});
			}
			const realModel = headers.get("x-palantir-real-model");
			if (realModel) {
				headers.delete("x-palantir-real-model");
				url = url.replace(/\/models\/gemini-dummy[^:]*:/, `/models/${realModel}:`);

				const newInit = { ...init, headers };
				if (typeof input !== "string" && !(input instanceof URL)) {
					newInit.method = newInit.method || input.method;
					newInit.body = newInit.body || input.body;
					newInit.signal = newInit.signal || input.signal;
					newInit.credentials = newInit.credentials || input.credentials;
					newInit.cache = newInit.cache || input.cache;
					newInit.redirect = newInit.redirect || input.redirect;
					newInit.referrer = newInit.referrer || input.referrer;
					newInit.referrerPolicy = newInit.referrerPolicy || input.referrerPolicy;
					newInit.integrity = newInit.integrity || input.integrity;
					newInit.keepalive = newInit.keepalive ?? input.keepalive;
				}
				return originalFetch(url, newInit);
			}
		}
		return originalFetch(input, init);
	};
	(globalThis as any).__palantirFetchPatched = true;
}

export const PALANTIR_BASE_URL_PLACEHOLDER = "[PALANTIR_BASE_URL]";

export function resolvePalantirBaseUrl(model: Model<Api>, customBaseUrl?: string): string {
	let baseUrl = model.baseUrl;
	const envBaseUrl = customBaseUrl || (typeof process !== "undefined" ? process.env.PALANTIR_BASE_URL : undefined);

	if (envBaseUrl) {
		baseUrl = baseUrl.replace(PALANTIR_BASE_URL_PLACEHOLDER, envBaseUrl.replace(/\/$/, ""));
	}
	return baseUrl;
}

export function resolvePalantirApiKey(customApiKey?: string): string | undefined {
	return customApiKey || (typeof process !== "undefined" ? process.env.PALANTIR_API_KEY : undefined);
}

function getUpstreamApi(modelId: string): "openai-completions" | "anthropic-messages" | "google-generative-ai" | "xai" {
	const id = modelId.toLowerCase();
	if (id.includes("anthropic") || id.includes("claude")) return "anthropic-messages";
	if (id.includes("google") || id.includes("gemini")) return "google-generative-ai";
	if (id.includes("xai") || id.includes("grok")) return "xai";
	// Default to OpenAI/Reasoning/Generic proxy format
	return "openai-completions";
}

function constructUpstreamModel(model: Model<"palantir-proxy">, options?: PalantirOptions): Model<Api> {
	const upstreamApi = getUpstreamApi(model.id);
	const baseUrl = resolvePalantirBaseUrl(model, options?.palantirBaseUrl);

	const upstreamModel = {
		...model,
		api: upstreamApi,
		baseUrl,
	} as Model<Api>;

	return upstreamModel;
}

export const streamPalantir: StreamFunction<"palantir-proxy", PalantirOptions> = (
	model: Model<"palantir-proxy">,
	context: Context,
	options?: PalantirOptions,
): AssistantMessageEventStream => {
	const apiKey = resolvePalantirApiKey(options?.palantirApiKey || options?.apiKey);
	if (!apiKey) {
		throw new Error(`No API key provided for Palantir Proxy. Set PALANTIR_API_KEY environment variable.`);
	}

	const upstreamModel = constructUpstreamModel(model, options);

	const proxyOptions = {
		...options,
		apiKey, // Passing it here fulfills the underlying provider's requirement
		headers: {
			...options?.headers,
			// Palantir proxy requires Bearer token format for authorization
			Authorization: `Bearer ${apiKey}`,
		},
	};

	// We don't have a direct xAI provider built-in. Assuming it routes through OpenAI completions/responses
	// per user requirement: "xAI (Grok): [BASE_URL]/api/v2/llm/proxy/xai/v1/chat/completions" (uses standard openai schema)
	switch (upstreamModel.api) {
		case "anthropic-messages":
			return streamAnthropic(upstreamModel as Model<"anthropic-messages">, context, proxyOptions);
		case "google-generative-ai": {
			const dummyModel = { ...upstreamModel, id: "gemini-dummy" } as Model<"google-generative-ai">;
			const modifiedProxyOptions = {
				...proxyOptions,
				headers: {
					...proxyOptions?.headers,
					"x-palantir-real-model": upstreamModel.id,
					// The Google SDK passes dummy-key to avoid validation, but we need the real Auth header
					Authorization: `Bearer ${apiKey}`,
				},
				// We pass a dummy key so the SDK doesn't complain, our Authorization header will override
				apiKey: "dummy-key",
			};
			return streamGoogle(dummyModel, context, modifiedProxyOptions);
		}
		default: {
			// If upstreamApi is "xai", we still use the openai completions stream since the payload format is the same
			// We just cast the upstream model back to "openai-completions" for the typescript signature
			const finalModel = { ...upstreamModel, api: "openai-completions" } as Model<"openai-completions">;
			return streamOpenAICompletions(finalModel, context, proxyOptions);
		}
	}
};

export const streamSimplePalantir: StreamFunction<"palantir-proxy", SimpleStreamOptions> = (
	model: Model<"palantir-proxy">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const palantirOptions = options as PalantirOptions;
	const apiKey = resolvePalantirApiKey(palantirOptions?.palantirApiKey || palantirOptions?.apiKey);

	if (!apiKey) {
		throw new Error(`No API key provided for Palantir Proxy. Set PALANTIR_API_KEY environment variable.`);
	}

	const upstreamModel = constructUpstreamModel(model, palantirOptions);

	const proxyOptions = {
		...options,
		apiKey,
		headers: {
			...options?.headers,
			Authorization: `Bearer ${apiKey}`,
		},
	};

	switch (upstreamModel.api) {
		case "anthropic-messages":
			return streamSimpleAnthropic(upstreamModel as Model<"anthropic-messages">, context, proxyOptions);
		case "google-generative-ai": {
			const dummyModel = { ...upstreamModel, id: "gemini-dummy" } as Model<"google-generative-ai">;
			const modifiedProxyOptions = {
				...proxyOptions,
				headers: {
					...proxyOptions?.headers,
					"x-palantir-real-model": upstreamModel.id,
					Authorization: `Bearer ${apiKey}`,
				},
				apiKey: "dummy-key",
			};
			return streamSimpleGoogle(dummyModel, context, modifiedProxyOptions);
		}
		default: {
			const finalModel = { ...upstreamModel, api: "openai-completions" } as Model<"openai-completions">;
			return streamSimpleOpenAICompletions(finalModel, context, proxyOptions);
		}
	}
};
