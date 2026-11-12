import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { NEON_AI_GATEWAY_MODELS } from "./neon-ai-gateway.models.ts";
import { neonAIGatewayStreams } from "./neon-ai-gateway-stream.ts";

type NeonAIGatewayApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

function neonAIGatewayAuth(): ApiKeyAuth {
	return {
		name: "Neon AI Gateway token",
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter Neon AI Gateway token" });
			const baseUrl = await interaction.prompt({ type: "text", message: "Enter Neon AI Gateway base URL" });
			return { type: "api_key", key, env: { NEON_AI_GATEWAY_BASE_URL: baseUrl } };
		},
		resolve: async ({ ctx, credential, signal }) => {
			// Per-field merge: a credential carrying only the token still picks up the
			// branch host from the environment.
			const key = credential?.key ?? (await ctx.env("NEON_AI_GATEWAY_TOKEN"));
			signal.throwIfAborted();
			const baseUrl = credential?.env?.NEON_AI_GATEWAY_BASE_URL ?? (await ctx.env("NEON_AI_GATEWAY_BASE_URL"));
			signal.throwIfAborted();
			if (!key || !baseUrl) return undefined;
			return {
				// The Gemini endpoint accepts only bearer auth, while the Google SDK sends
				// `x-goog-api-key`; the other endpoints accept either.
				auth: { apiKey: key, headers: { Authorization: `Bearer ${key}` } },
				env: { NEON_AI_GATEWAY_BASE_URL: baseUrl },
				source: credential?.key ? "stored credential" : "NEON_AI_GATEWAY_TOKEN",
			};
		},
	};
}

export function neonAIGatewayProvider(): Provider<NeonAIGatewayApi> {
	return createProvider<NeonAIGatewayApi>({
		id: "neon-ai-gateway",
		name: "Neon AI Gateway",
		auth: { apiKey: neonAIGatewayAuth() },
		models: Object.values(NEON_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": neonAIGatewayStreams(anthropicMessagesApi()),
			"google-generative-ai": neonAIGatewayStreams(googleGenerativeAIApi()),
			"openai-completions": neonAIGatewayStreams(openAICompletionsApi()),
			"openai-responses": neonAIGatewayStreams(openAIResponsesApi()),
		},
	});
}
