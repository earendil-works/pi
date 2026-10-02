import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
import type { Credential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENROUTER_CLASSIFIER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from "./openrouter.models.ts";

const credentialKey = (credential: Credential | undefined) =>
	credential?.type === "oauth" ? credential.access : credential?.key;

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
	});
	provider.refreshModels = async function (context) {
		const key = credentialKey(context.credential);
		if (!context.allowNetwork || !key) return;
		const auth = await context.resolveAuth?.();
		const headers = new Headers();
		for (const [name, value] of Object.entries(this.headers ?? {})) {
			if (value !== null) headers.set(name, value);
		}
		headers.set("Authorization", `Bearer ${auth?.apiKey ?? key}`);
		// Configured headers (models.json, extensions) apply last, as they do for model requests.
		for (const [name, value] of Object.entries(auth?.headers ?? {})) {
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
		const url = (auth?.baseUrl ?? this.baseUrl ?? baseUrl).replace(/\/+$/, "");
		const result = await fetch(`${url}/models/user`, {
			headers,
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
	// Show the full catalog until discovery succeeds for the stored credential.
	// This filter cannot read environment or configuration keys and reuses the last verified list.
	// Changes to those keys take effect on the next refresh.
	provider.filterModels = (models, credential) => {
		const key = credentialKey(credential);
		const current = verified;
		if (!current || (key !== undefined && key !== current.key)) return models;
		return models.filter((model) => current.ids.has(model.id));
	};
	return provider;
}
