import { antigravityApi } from "../api/antigravity.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTIGRAVITY_MODELS } from "./antigravity.models.ts";

export function antigravityProvider(): Provider<"antigravity"> {
	return createProvider({
		id: "antigravity",
		name: "Google Antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		auth: {
			oauth: lazyOAuth({
				name: "Google Antigravity",
				isSubscription: true,
				loginLabel: "Sign in with Google Antigravity",
				load: loadAntigravityOAuth,
			}),
		},
		models: Object.values(ANTIGRAVITY_MODELS),
		api: antigravityApi(),
	});
}
