/**
 * NVIDIA InferenceHub provider.
 *
 * InferenceHub (https://inference-backend.nvidia.com) is NVIDIA's internal
 * LiteLLM-based gateway that fronts Claude, GPT, Gemini, DeepSeek, Llama, and
 * NVIDIA-hosted models under one auth. This extension registers it as a pi
 * provider named `nvidia-inference-hub`.
 *
 * Setup:
 *   export NVIDIA_INFERENCEHUB_API_KEY=<inference key>       # required, for LLM calls
 *   export NVIDIA_INFERENCEHUB_METADATA_KEY=<hub metadata key>  # optional, populates the model list
 *
 * Both keys come from the InferenceHub Portal's key-management page. Without
 * the metadata key the provider registers with no models; users can still
 * point `--model` at a known label manually.
 *
 * Reasoning is disabled for every model: LiteLLM's translation of pi's
 * `thinking` params rejects newer upstream models (Claude Sonnet 5 requires
 * `thinking.type: "adaptive"`, which pi does not emit).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const METADATA_BASE = "https://inference-backend.nvidia.com/api/v1";

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

function classifyEndpoint(url: string): { baseUrl: string; api: "openai-completions" | "openai-responses" } | null {
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

async function fetchTextGenModels(metadataKey: string): Promise<SlimModel[]> {
	const all: SlimModel[] = [];
	let page = 1;

	while (true) {
		const url = `${METADATA_BASE}/models/slim?category=Text%20Generation&page=${page}&page_size=100`;
		const response = await fetch(url, {
			headers: { "X-API-Key": metadataKey },
			signal: AbortSignal.timeout(15_000),
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

export default async function (pi: ExtensionAPI) {
	const metadataKey = process.env.NVIDIA_INFERENCEHUB_METADATA_KEY;
	const inferenceKey = process.env.NVIDIA_INFERENCEHUB_API_KEY;

	if (!inferenceKey) return;

	let rawModels: SlimModel[] = [];
	if (metadataKey) {
		try {
			rawModels = await fetchTextGenModels(metadataKey);
		} catch {
			// Network failure — register provider with no models
		}
	}

	const models = rawModels
		.filter((m) => m.supports_chat && m.litellm_proxy_url)
		.map((m) => {
			const classified = classifyEndpoint(m.litellm_proxy_url!);
			if (!classified) return null;
			return {
				id: m.label,
				name: m.name,
				api: classified.api,
				baseUrl: classified.baseUrl,
				reasoning: false,
				input: (m.supports_vlm ? ["text", "image"] : ["text"]) as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.context_length_tokens ?? 128000,
				maxTokens: 4096,
				compat: {
					supportsDeveloperRole: false,
					maxTokensField: "max_tokens" as const,
					supportsStrictMode: false,
					supportsStore: false,
				},
			};
		})
		.filter((m): m is NonNullable<typeof m> => m !== null);

	pi.registerProvider("nvidia-inference-hub", {
		name: "NVIDIA InferenceHub",
		apiKey: inferenceKey,
		authHeader: true,
		api: "openai-completions",
		models,
	});
}
