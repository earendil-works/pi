import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadXaiOAuth } from "../utils/oauth/load.ts";
import { XAI_OAUTH_MODELS } from "./xai-oauth.models.ts";

export function xaiOAuthProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "xai-oauth",
		name: "xAI Grok OAuth (SuperGrok)",
		baseUrl: "https://api.x.ai/v1",
		auth: {
			oauth: lazyOAuth({ name: "xAI Grok OAuth (SuperGrok)", load: loadXaiOAuth }),
		},
		models: Object.values(XAI_OAUTH_MODELS),
		api: openAICompletionsApi(),
	});
}
