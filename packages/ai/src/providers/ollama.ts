import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

/**
 * Ollama provider - local OpenAI-compatible inference server.
 *
 * A purely dynamic provider: the model catalog is discovered from the running
 * Ollama server (`GET /api/tags`) instead of a generated static directory, so
 * adding it requires no `generate:models` run and no network access at build
 * time. Ollama is keyless, so auth always resolves as configured.
 *
 * Requires a running server, e.g. `ollama serve`, and at least one pulled
 * model. Point at a remote instance with `OLLAMA_HOST` or the provider base
 * URL override (`pi config set providers.ollama.baseUrl`).
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

interface OllamaTag {
	name: string;
}

interface OllamaTagsResponse {
	models?: OllamaTag[];
}

function normalizeOllamaBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "");
}

async function fetchOllamaTags(baseUrl: string, signal: AbortSignal): Promise<OllamaTag[]> {
	const response = await fetch(`${baseUrl}/api/tags`, { signal });
	if (!response.ok) {
		throw new Error(`Ollama /api/tags failed: HTTP ${response.status}`);
	}
	const data = (await response.json()) as OllamaTagsResponse;
	return data.models ?? [];
}

function modelFromTag(tag: OllamaTag, baseUrl: string): Model<"openai-completions"> {
	const rawId = tag.name;
	const id = rawId.includes(":") ? rawId : `${rawId}:latest`;
	const name = rawId.includes(":") ? rawId : rawId;
	return {
		id,
		name,
		api: "openai-completions",
		provider: "ollama",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
	};
}

export interface OllamaProviderOptions {
	/** Override the default server URL. Defaults to http://127.0.0.1:11434. */
	baseUrl?: string;
}

export function ollamaProvider(options: OllamaProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeOllamaBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
	return createProvider({
		id: "ollama",
		name: "Ollama (local)",
		baseUrl,
		auth: {
			apiKey: {
				name: "Ollama (keyless local server)",
				resolve: async () => ({ auth: {} }),
			},
		},
		models: [],
		api: openAICompletionsApi(),
		fetchModels: async (context) => {
			const tags = await fetchOllamaTags(baseUrl, context.signal);
			if (context.signal.aborted) return [];
			return tags.map((tag) => modelFromTag(tag, baseUrl));
		},
	});
}
