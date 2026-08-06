import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { ApiKeyAuth, ApiKeyCredential } from "../auth/types.ts";
import type { Provider } from "../models.ts";
import type { Model, OpenAICompletionsCompat } from "../types.ts";
import { OLLAMA_CLOUD_MODELS } from "./ollama-cloud.models.ts";

const DEFAULT_BASE_URL = "https://ollama.com";
const DEFAULT_MODEL_ID = "glm-5.2";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const FALLBACK_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

interface ModelsResponse {
	data?: unknown;
}

export interface OllamaCloudProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "");
}

function apiKey(credential: ApiKeyCredential | undefined): string {
	if (!credential?.key) throw new Error("Ollama Cloud API key is missing");
	return credential.key;
}

function parseModelIds(value: ModelsResponse): string[] {
	if (!Array.isArray(value.data)) throw new Error("Ollama Cloud model response is missing its data array");
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of value.data) {
		if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") continue;
		const id = entry.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function model(id: string, baseUrl: string): Model<"openai-completions"> {
	const catalogModel = (OLLAMA_CLOUD_MODELS as Record<string, Model<"openai-completions">>)[id];
	if (catalogModel) return { ...catalogModel, baseUrl: `${baseUrl}/v1` };
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		compat: FALLBACK_COMPAT,
	};
}

async function requestModels(fetchImpl: typeof fetch, baseUrl: string, key: string, signal?: AbortSignal) {
	const response = await fetchImpl(`${baseUrl}/v1/models`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
		signal,
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error("Ollama Cloud rejected the API key");
	}
	if (!response.ok) throw new Error(`Ollama Cloud model request failed: HTTP ${response.status}`);
	return parseModelIds((await response.json()) as ModelsResponse);
}

async function loadModels(
	fetchImpl: typeof fetch,
	baseUrl: string,
	key: string,
	signal?: AbortSignal,
): Promise<Model<"openai-completions">[]> {
	const ids = await requestModels(fetchImpl, baseUrl, key, signal);
	return ids.map((id) => model(id, baseUrl));
}

/** Ollama Cloud provider with API-key login and a dynamically refreshed model catalog. */
export function ollamaCloudProvider(options: OllamaCloudProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
	const fetchImpl = options.fetch ?? fetch;
	const streams = openAICompletionsApi();
	let models: readonly Model<"openai-completions">[] = [model(DEFAULT_MODEL_ID, baseUrl)];
	let catalogLoaded = false;
	const standardAuth = envApiKeyAuth("Ollama Cloud API key", ["OLLAMA_API_KEY"]);
	const auth: ApiKeyAuth = {
		...standardAuth,
		login: async (interaction) => {
			const credential = await standardAuth.login!(interaction);
			interaction.notify({ type: "progress", message: "Checking Ollama Cloud API key..." });
			const ids = await requestModels(fetchImpl, baseUrl, apiKey(credential), interaction.signal);
			interaction.signal.throwIfAborted();
			models = ids.map((id) => model(id, baseUrl));
			catalogLoaded = true;
			return credential;
		},
	};

	return {
		id: "ollama-cloud",
		name: "Ollama Cloud",
		baseUrl: `${baseUrl}/v1`,
		auth: { apiKey: auth },
		getModels: () => models,
		refreshModels: async (context) => {
			if (context.stored && !catalogLoaded) {
				const restored = context.stored.models.filter(
					(entry): entry is Model<"openai-completions"> =>
						entry.provider === "ollama-cloud" && entry.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
							catalogLoaded = true;
						},
					}))
				) {
					return;
				}
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const refreshed = await loadModels(
				fetchImpl,
				baseUrl,
				apiKey(context.credential?.type === "api_key" ? context.credential : undefined),
				context.signal,
			);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
					catalogLoaded = true;
				},
			});
		},
		stream: (selectedModel, context, streamOptions) => streams.stream(selectedModel, context, streamOptions),
		streamSimple: (selectedModel, context, streamOptions) =>
			streams.streamSimple(selectedModel, context, streamOptions),
	};
}
