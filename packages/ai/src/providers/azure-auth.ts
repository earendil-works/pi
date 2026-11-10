import {
	AZURE_OPENAI_AUTH_MODE_ENV,
	AZURE_OPENAI_ENTRA_ID_MARKER,
	AZURE_OPENAI_ENTRA_ID_MODE,
} from "../api/azure-openai-auth-constants.ts";
import type { ApiKeyAuth } from "../auth/types.ts";

export const azureAuth: ApiKeyAuth = {
	name: "Azure OpenAI credentials",
	login: async (interaction) => {
		interaction.signal.throwIfAborted();
		const method = await interaction.prompt({
			type: "select",
			message: "Select Azure OpenAI authentication method:",
			options: [
				{ id: "api-key", label: "API key" },
				{ id: AZURE_OPENAI_ENTRA_ID_MODE, label: "Microsoft Entra ID" },
			],
		});
		interaction.signal.throwIfAborted();
		if (method === "api-key") {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Azure OpenAI API key" }),
			};
		}
		if (method !== AZURE_OPENAI_ENTRA_ID_MODE) {
			throw new Error(`Unknown Azure OpenAI authentication method: ${method}`);
		}
		interaction.notify({
			type: "info",
			message:
				"Sign in with Azure CLI (`az login`) or configure another supported Azure Identity credential source with permission to use Azure OpenAI.",
			links: [
				{
					label: "Azure Identity",
					url: "https://learn.microsoft.com/azure/developer/javascript/sdk/authentication/credential-chains",
				},
			],
		});
		return { type: "api_key", env: { [AZURE_OPENAI_AUTH_MODE_ENV]: AZURE_OPENAI_ENTRA_ID_MODE } };
	},
	resolve: async ({ ctx, credential, signal }) => {
		signal.throwIfAborted();
		const storedMode = credential?.env?.[AZURE_OPENAI_AUTH_MODE_ENV];
		if (storedMode === AZURE_OPENAI_ENTRA_ID_MODE) {
			return {
				auth: { apiKey: AZURE_OPENAI_ENTRA_ID_MARKER },
				env: { ...credential?.env, [AZURE_OPENAI_AUTH_MODE_ENV]: AZURE_OPENAI_ENTRA_ID_MODE },
				source: "stored credential",
			};
		}
		if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };

		const authMode = storedMode ?? (await ctx.env(AZURE_OPENAI_AUTH_MODE_ENV));
		signal.throwIfAborted();
		if (authMode === AZURE_OPENAI_ENTRA_ID_MODE) {
			return {
				auth: { apiKey: AZURE_OPENAI_ENTRA_ID_MARKER },
				env: { ...credential?.env, [AZURE_OPENAI_AUTH_MODE_ENV]: AZURE_OPENAI_ENTRA_ID_MODE },
				source: AZURE_OPENAI_AUTH_MODE_ENV,
			};
		}
		if (authMode && authMode !== "api-key") {
			throw new Error(`Unsupported ${AZURE_OPENAI_AUTH_MODE_ENV}: ${authMode}`);
		}
		const key = await ctx.env("AZURE_OPENAI_API_KEY");
		signal.throwIfAborted();
		return key ? { auth: { apiKey: key }, source: "AZURE_OPENAI_API_KEY" } : undefined;
	},
};
