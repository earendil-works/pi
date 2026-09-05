import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadMetaOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { META_MODELS } from "./meta.models.ts";

export function metaProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "meta",
		name: "Meta",
		baseUrl: "https://api.meta.ai/v1",
		auth: {
			apiKey: envApiKeyAuth("Meta Model API key", ["META_API_KEY"]),
			oauth: lazyOAuth({
				name: "Meta (Muse subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Meta",
				load: loadMetaOAuth,
			}),
		},
		models: Object.values(META_MODELS),
		api: openAIResponsesApi(),
	});
}
