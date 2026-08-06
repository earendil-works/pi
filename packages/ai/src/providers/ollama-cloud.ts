import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { ApiKeyAuth, ApiKeyCredential } from "../auth/types.ts";
import type { Provider } from "../models.ts";
import type { Model, OpenAICompletionsCompat, ThinkingLevelMap } from "../types.ts";

const DEFAULT_BASE_URL = "https://ollama.com";
const DEFAULT_MODEL_ID = "glm-5.2:cloud";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "low",
	xhigh: "max",
	max: "max",
} satisfies ThinkingLevelMap;

const COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

interface ModelsResponse {
	data?: unknown;
}

interface ShowResponse {
	capabilities?: unknown;
	model_info?: unknown;
}

interface ModelDetails {
	contextWindow?: number;
	input?: Model<"openai-completions">["input"];
	reasoning?: boolean;
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

function contextWindow(modelInfo: unknown): number | undefined {
	if (!modelInfo || typeof modelInfo !== "object" || Array.isArray(modelInfo)) return undefined;
	for (const [name, value] of Object.entries(modelInfo)) {
		if (name.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

function parseDetails(value: ShowResponse): ModelDetails {
	const capabilities = Array.isArray(value.capabilities)
		? value.capabilities.filter((item): item is string => typeof item === "string")
		: [];
	return {
		contextWindow: contextWindow(value.model_info),
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		reasoning: capabilities.includes("thinking"),
	};
}

function model(id: string, baseUrl: string, details: ModelDetails = {}): Model<"openai-completions"> {
	const context = details.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const reasoning = details.reasoning ?? id === DEFAULT_MODEL_ID;
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: `${baseUrl}/v1`,
		reasoning,
		...(reasoning ? { thinkingLevelMap: THINKING_LEVEL_MAP } : {}),
		input: details.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: context,
		maxTokens: Math.min(DEFAULT_MAX_TOKENS, context),
		compat: COMPAT,
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

async function requestDetails(
	fetchImpl: typeof fetch,
	baseUrl: string,
	key: string,
	id: string,
	signal?: AbortSignal,
): Promise<ModelDetails> {
	try {
		const response = await fetchImpl(`${baseUrl}/api/show`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: id }),
			signal,
		});
		if (!response.ok) return {};
		return parseDetails((await response.json()) as ShowResponse);
	} catch (error) {
		if (signal?.aborted) throw error;
		return {};
	}
}

async function loadModels(
	fetchImpl: typeof fetch,
	baseUrl: string,
	key: string,
	signal?: AbortSignal,
): Promise<Model<"openai-completions">[]> {
	const ids = await requestModels(fetchImpl, baseUrl, key, signal);
	const details = await Promise.all(ids.map((id) => requestDetails(fetchImpl, baseUrl, key, id, signal)));
	return ids.map((id, index) => model(id, baseUrl, details[index]));
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
