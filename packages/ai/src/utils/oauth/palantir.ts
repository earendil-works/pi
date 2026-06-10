import type { Api, Model } from "../../types.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const palantirOAuthProvider: OAuthProviderInterface = {
	id: "palantir",
	name: "Palantir Foundry",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const baseUrl = await callbacks.onPrompt({
			message: "Enter your Palantir Base URL (e.g. https://[INSTANCE].palantirfoundry.com):",
			placeholder: "https://",
		});

		if (!baseUrl) {
			throw new Error("Base URL is required");
		}

		const apiKey = await callbacks.onPrompt({
			message: "Enter your Palantir API token:",
		});

		if (!apiKey) {
			throw new Error("API token is required");
		}

		return {
			access: apiKey,
			refresh: "",
			expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10, // expire in 10 years
			baseUrl,
		};
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return credentials;
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		if (typeof credentials.baseUrl === "string") {
			return models.map((model) => {
				if (model.provider === "palantir") {
					return {
						...model,
						baseUrl: model.baseUrl
							.replace("[PALANTIR_BASE_URL]", credentials.baseUrl as string)
							.replace(/\/$/, ""),
					};
				}
				return model;
			});
		}
		return models;
	},
};
