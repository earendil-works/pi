import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VERCEL_AI_GATEWAY_MODELS } from "./vercel-ai-gateway.models.ts";

export function vercelAIGatewayProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		baseUrl: "https://ai-gateway.vercel.sh",
		auth: { apiKey: envApiKeyAuth("Vercel AI Gateway API key", ["AI_GATEWAY_API_KEY"]) },
		models: Object.values(VERCEL_AI_GATEWAY_MODELS),
		api: anthropicMessagesApi(),
	});
}
