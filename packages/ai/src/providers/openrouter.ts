import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { AnyModel } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import { OPENROUTER_CLASSIFIER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from "./openrouter.models.ts";
import { type OpenRouterModel, openRouterCost } from "./openrouter-api.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_USER_MODELS_TIMEOUT_MS = 15_000;

/**
 * Restrict an OpenRouter catalog to the chat models the key may use, with the key's limits and
 * prices from `GET /models/user`. Image and classifier models are returned unchanged. A missing
 * limit keeps the catalog value. The request uses the provider's configured base URL, so regional
 * endpoints such as `https://us.openrouter.ai/api/v1` apply their region's filtering. When the
 * endpoint rejects the key (401/403) or does not exist (404), for example with a proxy configured
 * in models.json, the catalog is returned unchanged.
 */
export async function personalizeOpenRouterCatalog(
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
): Promise<readonly AnyModel[]> {
	const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
	if (!key) return catalog;
	const response = await fetch(`${(context.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/models/user`, {
		headers: { accept: "application/json", authorization: `Bearer ${key}` },
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(OPENROUTER_USER_MODELS_TIMEOUT_MS)]),
	});
	if (response.status === 401 || response.status === 403 || response.status === 404) return catalog;
	if (!response.ok) throw new Error(`OpenRouter model list request failed: ${response.status}`);
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
		throw new Error("Invalid OpenRouter model list response");
	}
	const allowed = new Map<string, OpenRouterModel>();
	for (const entry of body.data as unknown[]) {
		if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string") {
			allowed.set(entry.id, entry as OpenRouterModel);
		}
	}
	return catalog.flatMap((model): AnyModel[] => {
		if (!isModelType(model, "chat")) return [model];
		const entry = allowed.get(model.id);
		if (!entry) return [];
		return [
			{
				...model,
				// `||`: OpenRouter reports a missing limit as absent, null or 0, like the generator's fallback.
				contextWindow: entry.top_provider?.context_length || entry.context_length || model.contextWindow,
				maxTokens: entry.top_provider?.max_completion_tokens || model.maxTokens,
				cost: entry.pricing ? openRouterCost(entry.pricing) : model.cost,
			},
		];
	});
}

export function openrouterProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider<"anthropic-messages" | "openai-completions">({
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: OPENROUTER_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenRouter OAuth",
				loginLabel: "Sign in with OpenRouter",
				load: loadOpenRouterOAuth,
			}),
		},
		models: [
			...Object.values(OPENROUTER_MODELS),
			...Object.values(OPENROUTER_IMAGE_MODELS),
			...Object.values(OPENROUTER_CLASSIFIER_MODELS),
		],
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
		images: { "openrouter-images": openrouterImagesApi() },
		// OpenRouter serves TypeSafe's System One protocol at /api/v1/systemone.
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
