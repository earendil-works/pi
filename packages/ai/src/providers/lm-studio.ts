import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import type { ApiKeyAuth, ApiKeyCredential, ModelAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, OpenAIResponsesCompat } from "../types.ts";

/** Default LM Studio server base URL. Models loaded via /api/v1/models, API calls via /v1. */
export const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234";

/** Fallback API key for keyless local servers; also stored on empty login input. */
export const LM_STUDIO_NO_KEY = "nokey";

/** Optional environment variable for LM Studio API keys (auth proxies only). */
export const LM_STUDIO_API_KEY_ENV = "LM_STUDIO_API_KEY";

/** Environment variable and stored-credential env key for the server base URL. */
export const LM_STUDIO_BASE_URL_ENV = "LM_STUDIO_BASE_URL";

/** Trim user input, strip trailing slashes, and strip a trailing /v1 segment so the
 *  stored value is the bare server URL (e.g. "http://localhost:1234"). */
function normalizeBaseUrl(url: string): string {
	return url
		.trim()
		.replace(/\/v1(?:\/.*)?$/, "")
		.replace(/\/+$/, "");
}

/** Construct the OpenAI-compatible API base URL from a server URL (may include /v1). */
function apiBaseUrl(serverUrl: string): string {
	return `${normalizeBaseUrl(serverUrl)}/v1`;
}

/** Request auth for a keyed or keyless local server, deriving the /v1 API base URL from the server URL. */
function apiKeyAuthResult(apiKey: string, serverUrl: string | undefined): ModelAuth {
	return serverUrl ? { apiKey, baseUrl: apiBaseUrl(serverUrl) } : { apiKey };
}

export interface LMStudioProviderOptions {
	/** Provider id. Default: "lm-studio". */
	id?: string;
	/** Display name. Default: "LM Studio". */
	name?: string;
	/** Server base URL (no /v1 suffix). Default: `http://localhost:1234`. */
	baseUrl?: string;
}

/** Default context window when the server does not report one per model. */
const DEFAULT_CONTEXT_WINDOW = 8192;
/** Default max output tokens when the server does not report one per model. */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Conservative OpenAI Responses compatibility for llama.cpp-family local
 * servers: use the `system` role, skip the OpenAI `session_id` affinity
 * header, and omit `prompt_cache_retention: "24h"` and tool `strict`
 * fields that LM Studio does not implement.
 */
export const LM_STUDIO_COMPAT: OpenAIResponsesCompat = {
	supportsDeveloperRole: false,
	sessionAffinityFormat: "openai-nosession",
	supportsLongCacheRetention: false,
	supportsStrictMode: false,
};

/** Optional Authorization header for local servers behind an auth proxy. */
function authHeaders(key: string | undefined): { Authorization: string } | undefined {
	return key ? { Authorization: `Bearer ${key}` } : undefined;
}

/**
 * LM Studio is a keyless local server. Login accepts an optional API key
 * (stores "nokey" when left empty) and an optional server base URL; both are
 * stored in the credential. Resolution falls back to "nokey" so the provider
 * is usable without any configuration, and prefers the stored URL over the
 * `LM_STUDIO_BASE_URL` environment variable and the default localhost port.
 */
const lmStudioApiKeyAuth: ApiKeyAuth = {
	name: "LM Studio API key (optional)",
	login: async (interaction) => {
		interaction.signal.throwIfAborted();
		const key = await interaction.prompt({
			type: "text",
			message: "LM Studio API key (optional; leave empty for keyless local server)",
			placeholder: LM_STUDIO_NO_KEY,
		});
		interaction.signal.throwIfAborted();
		const baseUrl = await interaction.prompt({
			type: "text",
			message:
				"LM Studio server URL (optional; base URL, e.g. http://localhost:1234 or http://host.docker.internal:1234)",
			placeholder: DEFAULT_LM_STUDIO_BASE_URL,
		});
		interaction.signal.throwIfAborted();
		const credential: ApiKeyCredential = {
			type: "api_key",
			key: key.trim() === "" ? LM_STUDIO_NO_KEY : key.trim(),
		};
		const trimmedUrl = normalizeBaseUrl(baseUrl);
		if (trimmedUrl !== "") {
			credential.env = { LM_STUDIO_BASE_URL: trimmedUrl };
		}
		return credential;
	},
	resolve: async ({ ctx, credential, signal }) => {
		signal.throwIfAborted();
		const storedUrl = credential?.env?.LM_STUDIO_BASE_URL;
		if (credential?.key) {
			return {
				auth: apiKeyAuthResult(credential.key, storedUrl),
				env: credential.env,
				source: "stored credential",
			};
		}
		const envKey = await ctx.env(LM_STUDIO_API_KEY_ENV);
		signal.throwIfAborted();
		if (envKey) {
			const envUrl = await ctx.env(LM_STUDIO_BASE_URL_ENV);
			signal.throwIfAborted();
			return {
				auth: apiKeyAuthResult(envKey, envUrl),
				source: LM_STUDIO_API_KEY_ENV,
			};
		}
		// Keyless local server: usable out of the box with a placeholder key.
		const envUrl = storedUrl ?? (await ctx.env(LM_STUDIO_BASE_URL_ENV));
		signal.throwIfAborted();
		return {
			auth: apiKeyAuthResult(LM_STUDIO_NO_KEY, envUrl),
			source: "keyless local server",
		};
	},
};

type LMStudioNativeReasoningType = "off" | "on" | "low" | "medium" | "high";

interface LMStudioNativeReasoning {
	default: LMStudioNativeReasoningType;
}

/** Return true when the model's reasoning capability is enabled (default is not "off"). */
function isReasoningEnabled(reasoning: LMStudioNativeReasoning | undefined): boolean {
	return reasoning != null && reasoning.default !== "off";
}

// source: https://lmstudio.ai/docs/developer/rest/list
interface LMStudioNativeModel {
	type?: unknown;
	key?: string;
	display_name?: string;
	max_context_length?: number;
	capabilities?: {
		vision?: unknown;
		reasoning?: LMStudioNativeReasoning;
	};
}

interface LMStudioOpenAIEntry {
	id?: unknown;
}

/**
 * Extract the origin from a server base URL.
 * Used to construct the native /api/v1/models endpoint.
 */
function serverOrigin(serverUrl: string): string {
	try {
		const parsed = new URL(serverUrl);
		return parsed.origin;
	} catch {
		return serverUrl;
	}
}

/**
 * LM Studio provider with a dynamic model catalog fetched from the local
 * server. Prefers the native `/api/v1/models` endpoint which reports
 * `max_context_length` per model, falling back to the OpenAI-compatible
 * `/v1/models` endpoint for older LM Studio versions. Requests are routed
 * through the `/v1/responses` endpoint. Models are cached in the models
 * store so they stay listed across restarts.
 */
export function lmStudioProvider(options: LMStudioProviderOptions = {}): Provider<"openai-responses"> {
	const id = options.id ?? "lm-studio";
	const name = options.name ?? "LM Studio";
	const serverUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LM_STUDIO_BASE_URL);

	return createProvider({
		id,
		name,
		baseUrl: apiBaseUrl(serverUrl),
		auth: { apiKey: lmStudioApiKeyAuth },
		models: [],
		api: openAIResponsesApi(),
		fetchModels: async (context) => {
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const credentialUrl =
				context.credential?.type === "api_key" ? context.credential.env?.LM_STUDIO_BASE_URL : undefined;
			// Normalize to the bare server URL (no /v1) for endpoint construction.
			const serverBase = normalizeBaseUrl(credentialUrl ?? serverUrl);
			const origin = serverOrigin(serverBase);
			const apiUrl = apiBaseUrl(serverBase);

			// Shared model shape for both catalog endpoints.
			const toModel = (entry: {
				id: string;
				displayName: string;
				reasoning: boolean;
				vision: boolean;
				contextWindow: number;
			}): Model<"openai-responses"> => ({
				id: entry.id,
				name: `LM Studio ${entry.displayName}`,
				api: "openai-responses",
				provider: id,
				baseUrl: apiUrl,
				reasoning: entry.reasoning,
				input: entry.vision ? ["text", "image"] : ["text"],
				contextWindow: entry.contextWindow,
				maxTokens: DEFAULT_MAX_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: LM_STUDIO_COMPAT,
			});

			// Try the native LM Studio API first, which reports max_context_length per model.
			let entries: LMStudioNativeModel[] = [];
			try {
				const nativeResponse = await fetch(`${origin}/api/v1/models`, {
					signal: context.signal,
					headers: authHeaders(key),
				});
				if (nativeResponse.ok) {
					const nativePayload = (await nativeResponse.json()) as { models?: LMStudioNativeModel[] };
					if (Array.isArray(nativePayload?.models)) {
						entries = nativePayload.models;
					}
				}
			} catch {
				// Fall through to OpenAI-compatible endpoint below.
			}

			const models: Model<"openai-responses">[] = [];

			if (entries.length > 0) {
				// Native endpoint: use key, max_context_length, and capabilities.
				for (const entry of entries) {
					if (entry.type !== "llm") continue;
					if (typeof entry.key !== "string" || entry.key.trim() === "") continue;
					models.push(
						toModel({
							id: entry.key,
							displayName:
								typeof entry.display_name === "string" && entry.display_name.trim() !== ""
									? entry.display_name
									: entry.key,
							reasoning: isReasoningEnabled(entry.capabilities?.reasoning),
							vision: entry.capabilities?.vision === true,
							contextWindow:
								typeof entry.max_context_length === "number" && entry.max_context_length > 0
									? entry.max_context_length
									: DEFAULT_CONTEXT_WINDOW,
						}),
					);
				}
			} else {
				// Fallback: OpenAI-compatible /v1/models endpoint (older LM Studio).
				const response = await fetch(`${apiUrl}/models`, {
					signal: context.signal,
					headers: authHeaders(key),
				});
				if (!response.ok) {
					throw new Error(`LM Studio model list request failed with status ${response.status}`);
				}
				const payload = (await response.json()) as { data?: LMStudioOpenAIEntry[] };
				const openaiEntries = Array.isArray(payload?.data) ? payload.data : [];
				for (const entry of openaiEntries) {
					if (typeof entry.id !== "string" || entry.id.trim() === "") continue;
					models.push(
						toModel({
							id: entry.id,
							displayName: entry.id,
							reasoning: false,
							vision: false,
							contextWindow: DEFAULT_CONTEXT_WINDOW,
						}),
					);
				}
			}

			return models;
		},
	});
}
