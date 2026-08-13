import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

const PROVIDER_ID = "nvidia-inference-hub";
const METADATA_BASE = "https://inference-backend.nvidia.com/api/v1";

/**
 * NVIDIA InferenceHub — internal LiteLLM-based gateway that fronts Claude,
 * GPT, Gemini, DeepSeek, Llama, and NVIDIA-hosted models under one auth.
 *
 * Two keys, both from the InferenceHub Portal's key-management page:
 *   NVIDIA_INFERENCEHUB_API_KEY       — Bearer token for LLM calls (required)
 *   NVIDIA_INFERENCEHUB_METADATA_KEY  — X-API-Key for catalog fetches (optional)
 *
 * Without the metadata key the provider registers with an empty catalog and
 * users may still point --model at a known label manually. Reasoning is
 * disabled on every model: LiteLLM's translation of pi's `thinking` params
 * is rejected by newer upstream models (e.g. Claude Sonnet 5 requires
 * `thinking.type: "adaptive"`, which pi does not emit).
 */

interface SlimModel {
	id: string;
	label: string;
	name: string;
	litellm_proxy_url?: string | null;
	supports_reasoning?: boolean | null;
	supports_chat?: boolean | null;
	supports_vlm?: boolean | null;
	supports_tool_use?: boolean | null;
	context_length_tokens?: number | null;
	category?: string | null;
}

type HubApi = "openai-completions" | "openai-responses";

function classifyEndpoint(url: string): { baseUrl: string; api: HubApi } | null {
	if (url.endsWith("/chat/completions")) {
		return {
			baseUrl: url.replace(/\/chat\/completions\/?$/, ""),
			api: "openai-completions",
		};
	}
	if (url.endsWith("/responses")) {
		return {
			baseUrl: url.replace(/\/responses\/?$/, ""),
			api: "openai-responses",
		};
	}
	return null;
}

async function fetchSlimModels(metadataKey: string, signal: AbortSignal): Promise<SlimModel[]> {
	const all: SlimModel[] = [];
	let page = 1;
	while (true) {
		const url = `${METADATA_BASE}/models/slim?category=Text%20Generation&page=${page}&page_size=100`;
		const response = await fetch(url, {
			headers: { "X-API-Key": metadataKey },
			signal,
		});
		if (!response.ok) break;
		const data = (await response.json()) as {
			models: SlimModel[];
			total_pages: number;
		};
		all.push(...data.models);
		if (page >= data.total_pages) break;
		page++;
	}
	return all;
}

function toModel(m: SlimModel): Model<HubApi> | null {
	if (!m.supports_chat || !m.litellm_proxy_url) return null;
	const classified = classifyEndpoint(m.litellm_proxy_url);
	if (!classified) return null;

	const contextWindow = m.context_length_tokens ?? 128000;
	const input: ("text" | "image")[] = m.supports_vlm ? ["text", "image"] : ["text"];

	if (classified.api === "openai-completions") {
		const completions: Model<"openai-completions"> = {
			id: m.label,
			name: m.name,
			api: "openai-completions",
			provider: PROVIDER_ID,
			baseUrl: classified.baseUrl,
			reasoning: false,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: 4096,
			compat: {
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsStore: false,
			},
		};
		return completions;
	}

	const responses: Model<"openai-responses"> = {
		id: m.label,
		name: m.name,
		api: "openai-responses",
		provider: PROVIDER_ID,
		baseUrl: classified.baseUrl,
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
		compat: {
			supportsDeveloperRole: false,
			supportsStrictMode: false,
		},
	};
	return responses;
}

export function nvidiaInferenceHubProvider(): Provider<HubApi> {
	return createProvider<HubApi>({
		id: PROVIDER_ID,
		name: "NVIDIA InferenceHub",
		auth: {
			apiKey: envApiKeyAuth("NVIDIA InferenceHub API key", ["NVIDIA_INFERENCEHUB_API_KEY"]),
		},
		models: [],
		fetchModels: async (context) => {
			const metadataKey = process.env.NVIDIA_INFERENCEHUB_METADATA_KEY;
			if (!metadataKey) return [];
			const raw = await fetchSlimModels(metadataKey, context.signal);
			return raw.map(toModel).filter((m): m is Model<HubApi> => m !== null);
		},
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
