import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENROUTER_CLASSIFIER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from "./openrouter.models.ts";

export function openrouterProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	const baseUrl = "https://openrouter.ai/api/v1";
	// Model IDs from the last successful /models/user call, tagged with the key that fetched them.
	let verified: { key: string; ids: ReadonlySet<string> } | undefined;
	const provider = createProvider<"anthropic-messages" | "openai-completions">({
		id: "openrouter",
		name: "OpenRouter",
		baseUrl,
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
		filterModels: (models, credential) => {
			const key = credential?.type === "oauth" ? credential.access : credential?.key;
			const current = verified;
			if (!current || key !== current.key) return models;
			// Routing suffixes share permissions with their catalog entry; catalog variants such as :free do not.
			return models.filter(
				(model) =>
					current.ids.has(model.id) ||
					current.ids.has(model.id.replace(/:(?:nitro|floor|exacto|online)(?=:|$)/g, "")),
			);
		},
	});
	provider.refreshModels = async function (context) {
		const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
		if (!context.allowNetwork || !key) return;
		const url = (this.baseUrl ?? baseUrl).replace(/\/+$/, "");
		const result = await fetch(`${url}/models/user`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
		});
		if (!result.ok) throw new Error(`OpenRouter model discovery failed: HTTP ${result.status}`);
		const body: unknown = await result.json();
		if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
			throw new Error("Invalid OpenRouter models response");
		}
		const ids = new Set<string>();
		for (const model of body.data) {
			if (typeof model === "object" && model !== null && "id" in model && typeof model.id === "string") {
				ids.add(model.id);
			}
		}
		await context.publish({
			update: () => {
				verified = { key, ids };
			},
		});
	};
	return provider;
}
