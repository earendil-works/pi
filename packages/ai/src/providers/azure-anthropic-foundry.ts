import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AZURE_ANTHROPIC_FOUNDRY_MODELS } from "./azure-anthropic-foundry.models.ts";

/**
 * Azure AI Foundry hosts Anthropic Claude via `/anthropic/` on
 * `https://<resource>.services.ai.azure.com/`. baseUrl is resolved per
 * request from `ANTHROPIC_FOUNDRY_BASE_URL` or `ANTHROPIC_FOUNDRY_RESOURCE`.
 * The Anthropic SDK sends `x-api-key`; Azure gateways expect `api-key`, so we
 * mirror the key into an additional `api-key` header.
 */
function foundryBaseUrl(baseUrl: string | undefined, resource: string | undefined): string | undefined {
	if (baseUrl) return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	if (resource) return `https://${resource}.services.ai.azure.com/anthropic/`;
	return undefined;
}

const azureFoundryApiKeyAuth: ApiKeyAuth = {
	name: "Azure AI Foundry API key",
	login: async (callbacks) => {
		const key = await callbacks.prompt({
			type: "secret",
			message: "Enter Azure Foundry API key (ANTHROPIC_FOUNDRY_API_KEY)",
		});
		return { type: "api_key", key };
	},
	resolve: async ({ ctx, credential }) => {
		const apiKey = credential?.key ?? (await ctx.env("ANTHROPIC_FOUNDRY_API_KEY"));
		if (!apiKey) return undefined;

		const baseUrl = credential?.env?.ANTHROPIC_FOUNDRY_BASE_URL ?? (await ctx.env("ANTHROPIC_FOUNDRY_BASE_URL"));
		const resource = credential?.env?.ANTHROPIC_FOUNDRY_RESOURCE ?? (await ctx.env("ANTHROPIC_FOUNDRY_RESOURCE"));
		const resolved = foundryBaseUrl(baseUrl, resource);
		if (!resolved) {
			throw new Error(
				"Azure Foundry requires an endpoint. Set ANTHROPIC_FOUNDRY_RESOURCE or ANTHROPIC_FOUNDRY_BASE_URL.",
			);
		}

		return {
			auth: {
				apiKey,
				baseUrl: resolved,
				headers: { "api-key": apiKey },
			},
			source: credential?.key ? "stored credential" : "ANTHROPIC_FOUNDRY_API_KEY",
		};
	},
};

export function azureAnthropicFoundryProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "azure-anthropic-foundry",
		name: "Azure AI Foundry (Anthropic)",
		auth: { apiKey: azureFoundryApiKeyAuth },
		models: Object.values(AZURE_ANTHROPIC_FOUNDRY_MODELS),
		api: anthropicMessagesApi(),
	});
}
