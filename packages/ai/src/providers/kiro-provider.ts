import { lazyOAuth } from "../auth/helpers.ts";
import { loadKiroOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { KIRO_MODELS } from "./kiro.catalog.ts";
import { fetchKiroModelsForCredential, kiroApi } from "./kiro.ts";

export function kiroProvider(): Provider<"kiro-api"> {
	return createProvider({
		id: "kiro",
		name: "Kiro",
		auth: {
			oauth: lazyOAuth({
				name: "Kiro (AWS Builder ID / IAM Identity Center)",
				isSubscription: true,
				load: loadKiroOAuth,
			}),
		},
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		models: KIRO_MODELS,
		fetchModels: async (context) => {
			const credential = context.credential?.type === "oauth" ? context.credential : undefined;
			if (!credential?.access) return [];
			return fetchKiroModelsForCredential(
				{
					access: credential.access,
					region: typeof credential.region === "string" ? credential.region : undefined,
					profileArn: typeof credential.profileArn === "string" ? credential.profileArn : undefined,
				},
				context.signal,
			);
		},
		api: kiroApi,
	});
}
