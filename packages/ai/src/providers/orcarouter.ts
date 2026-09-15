/**
 * OrcaRouter provider.
 *
 * OrcaRouter is an OpenAI-compatible AI gateway: the relay lives at
 * `https://api.orcarouter.ai/v1` and speaks the OpenAI wire format, with
 * native Anthropic and Gemini surfaces for the vendors whose models are routed
 * there. Authentication lives on a different origin (`https://www.orcarouter.ai`)
 * and is never derived from the inference origin.
 *
 * Two explicit credential choices share this one provider definition:
 * - "OrcaRouter API key": paste an existing `sk-orca-…` key;
 * - "Sign in with OrcaRouter": OAuth 2.0 + PKCE issues the same kind of key.
 * Both end up as a single stored credential, so inference, the model catalog,
 * and every AI entry point stay authentication-agnostic.
 *
 * The model list is dynamic: chat models come from the workspace-scoped
 * `GET /v1/models?capability=chat`, and the verified seed in
 * `../orcarouter/catalog.ts` keeps the provider usable when discovery fails.
 */

import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOrcaRouterOAuth } from "../auth/oauth/load.ts";
import type { Credential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { filterOrcaRouterCatalog } from "../orcarouter/capabilities.ts";
import {
	fetchOrcaRouterCatalog,
	ORCAROUTER_DEFAULT_API_BASE_URL,
	ORCAROUTER_FALLBACK_MODELS,
	toOrcaRouterModels,
} from "../orcarouter/catalog.ts";
import type { Api, Model } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export const ORCAROUTER_PROVIDER_ID = "orcarouter";

/** pi API implementations this provider can route to. */
type OrcaRouterProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/**
 * Resolve the inference origin. Explicit `ORCA_API_BASE_URL` wins, then the
 * shared self-hosted `ORCA_BASE_URL`, then the public default. The `/v1` suffix
 * is added only when the caller supplied a bare origin.
 */
export function resolveOrcaRouterApiBaseUrl(): string {
	const explicit = getProviderEnvValue("ORCA_API_BASE_URL") ?? getProviderEnvValue("ORCA_BASE_URL");
	if (!explicit) return ORCAROUTER_DEFAULT_API_BASE_URL;
	const trimmed = explicit.replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Extract a usable bearer credential from whichever auth method produced it. */
export function credentialApiKey(credential: Credential | undefined): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "oauth") return credential.access || undefined;
	return credential.key || undefined;
}

export function orcaRouterProvider(): Provider<OrcaRouterProviderApi> {
	const baseUrl = resolveOrcaRouterApiBaseUrl();
	const toModels = (catalog: Parameters<typeof toOrcaRouterModels>[0]): Model<OrcaRouterProviderApi>[] =>
		toOrcaRouterModels(catalog, { providerId: ORCAROUTER_PROVIDER_ID, baseUrl }) as Model<OrcaRouterProviderApi>[];

	/**
	 * The provider's live model list. It starts as the verified seed so a fresh
	 * installation is usable before any network access. The provider owns this
	 * state directly rather than layering a dynamic overlay on a baseline, so a
	 * successful live discovery *replaces* the seed instead of merging with it.
	 */
	let models: readonly Model<OrcaRouterProviderApi>[] = toModels(ORCAROUTER_FALLBACK_MODELS);

	const restore = (stored: Readonly<{ models: readonly Model<Api>[] }>): readonly Model<OrcaRouterProviderApi>[] =>
		stored.models.filter((model) => model.provider === ORCAROUTER_PROVIDER_ID) as Model<OrcaRouterProviderApi>[];

	// createProvider supplies the api dispatch (including deferred responses);
	// the model list and refresh policy are owned here.
	const base = createProvider<OrcaRouterProviderApi>({
		id: ORCAROUTER_PROVIDER_ID,
		name: "OrcaRouter",
		baseUrl,
		auth: {
			apiKey: envApiKeyAuth("OrcaRouter API key", ["ORCAROUTER_API_KEY"]),
			oauth: lazyOAuth({
				name: "OrcaRouter OAuth",
				loginLabel: "Sign in with OrcaRouter",
				load: loadOrcaRouterOAuth,
			}),
		},
		models: [],
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
			"anthropic-messages": anthropicMessagesApi(),
			"google-generative-ai": googleGenerativeAIApi(),
		},
	});

	return {
		...base,
		getModels: () => models,
		refreshModels: async (context) => {
			if (context.stored?.models?.length) {
				const restored = restore(context.stored);
				if (restored.length > 0) {
					await context.publish({
						update: () => {
							models = restored;
						},
					});
				}
			}
			if (!context.allowNetwork || context.signal.aborted) return;

			const catalog = await fetchOrcaRouterCatalog({
				baseUrl,
				apiKey: credentialApiKey(context.credential),
				capability: "chat",
				signal: context.signal,
			});
			// Live discovery is authoritative. An empty live list is still an
			// authoritative answer for this workspace, so it replaces the seed too.
			const live = toModels(filterOrcaRouterCatalog(catalog, "text"));
			await context.publish({
				persist: { models: live, checkedAt: Date.now() },
				update: () => {
					models = live;
				},
			});
		},
	};
}

/** Exported for callers that need the provider's pi-API surface typing. */
export type { Api as OrcaRouterApi };
