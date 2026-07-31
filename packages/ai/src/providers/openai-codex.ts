import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

function externalCodexAuth(): ApiKeyAuth {
	return {
		name: "externally managed Codex access token",
		login: async (interaction) => ({
			type: "api_key",
			key: await interaction.prompt({ type: "secret", message: "Enter externally managed Codex access token" }),
		}),
		resolve: async ({ ctx, credential }) => {
			const apiKey = credential?.key ?? (await ctx.env("OPENAI_CODEX_ACCESS_TOKEN"));
			if (!apiKey) return undefined;
			const accountId = credential?.env?.OPENAI_CODEX_ACCOUNT_ID ?? (await ctx.env("OPENAI_CODEX_ACCOUNT_ID"));
			return {
				auth: {
					apiKey,
					...(accountId ? { headers: { "chatgpt-account-id": accountId } } : {}),
				},
				env: credential?.env,
				source: credential?.key ? "stored credential" : "OPENAI_CODEX_ACCESS_TOKEN",
			};
		},
	};
}

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			apiKey: externalCodexAuth(),
			oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }),
		},
		models: Object.values(OPENAI_CODEX_MODELS),
		api: openAICodexResponsesApi(),
	});
}
