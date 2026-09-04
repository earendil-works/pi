/**
 * OrcaRouter remote catalog + provider.
 *
 * OrcaRouter is an OpenAI-compatible AI gateway (models and agents) fronting
 * many vendors. Its chat model catalog is fetched live from
 * `GET {baseUrl}/models?capability=chat` (Bearer auth when an API key is
 * configured), so this provider keeps an empty static baseline and relies on
 * pi-ai's dynamic model overlay (createProvider `fetchModels`) to populate
 * chat-capable models. No hand-written model ids exist anywhere in this
 * provider — when the catalog is unreachable the provider has no models and
 * the UI shows the refresh error.
 */

import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import {
	ORCAROUTER_BASE_URL,
	ORCAROUTER_CHAT_CAPABILITY,
	ORCAROUTER_PROVIDER_ID,
	type OrcaRouterCatalogEntry,
	orcaRouterTextChatModels,
	parseOrcaRouterCatalog,
} from "../orcarouter/capabilities.ts";
import type { Model } from "../types.ts";

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

/** Map a catalog entry to a full pi runtime Model. */
function toPiModel(init: {
	id: string;
	provider: "orcarouter";
	api: "openai-completions" | "anthropic-messages";
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): Model<"openai-completions" | "anthropic-messages"> {
	const { input, ...rest } = init;
	return {
		...rest,
		input,
	} as Model<"openai-completions" | "anthropic-messages">;
}

export interface FetchOrcaRouterCatalogOptions {
	/** Server-side capability filter applied to GET /models, e.g. "chat". */
	capability?: string;
	signal?: AbortSignal;
}

/**
 * Fetch the live OrcaRouter catalog. The request carries the configured API
 * key (if any) as a Bearer token so the returned list reflects what the
 * workspace can actually call. `capability` is passed through as the
 * `?capability=` query parameter (the server authoritative filter).
 */
export async function fetchOrcaRouterCatalog(
	baseUrl: string,
	apiKey: string | undefined,
	options: FetchOrcaRouterCatalogOptions = {},
): Promise<OrcaRouterCatalogEntry[]> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/models`);
	if (options.capability) url.searchParams.set("capability", options.capability);
	const response = await fetch(url, { headers, signal: options.signal });
	if (!response.ok) {
		throw new Error(
			`Could not load OrcaRouter models from ${url}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}
	const catalog = parseOrcaRouterCatalog(await response.json());
	return catalog.data;
}

/** Fetch the server-filtered chat catalog entries (`?capability=chat`). */
export async function fetchOrcaRouterChatCatalog(
	baseUrl: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<OrcaRouterCatalogEntry[]> {
	return fetchOrcaRouterCatalog(baseUrl, apiKey, { capability: ORCAROUTER_CHAT_CAPABILITY, signal });
}

/**
 * Fetch live chat-capable pi models. The server `?capability=chat` list is the
 * authoritative source; `orcaRouterTextChatModels` is applied again as a
 * second-layer guard so an entry can never slip in through a non-text
 * endpoint type.
 */
export async function fetchOrcaRouterChatModels(
	baseUrl: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<Model<"openai-completions" | "anthropic-messages">[]> {
	const entries = await fetchOrcaRouterChatCatalog(baseUrl, apiKey, signal);
	return orcaRouterTextChatModels(entries).map(toPiModel);
}

/** OrcaRouter provider factory: first-class built-in provider. */
export function orcarouterProvider(): Provider<"openai-completions" | "anthropic-messages"> {
	return createProvider({
		id: ORCAROUTER_PROVIDER_ID,
		name: "OrcaRouter",
		baseUrl: ORCAROUTER_BASE_URL,
		auth: { apiKey: envApiKeyAuth("OrcaRouter API key", ["ORCAROUTER_API_KEY"]) },
		models: [],
		fetchModels: async (context: RefreshModelsContext) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			return fetchOrcaRouterChatModels(ORCAROUTER_BASE_URL, apiKey, context.signal);
		},
		api: {
			"openai-completions": openAICompletionsApi(),
			"anthropic-messages": anthropicMessagesApi(),
		},
	});
}
