import { googleInteractionsApi } from "../api/google-interactions.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import type { GoogleAiPlanClient } from "../auth/oauth/google-ai-plan.ts";
import { loadGoogleAiPlanOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_AI_PLAN_MODELS } from "./google-ai-plan.models.ts";

export type { GoogleAiPlanClient };

/**
 * Google AI Ultra plan provider, signing in with the app's own Google client. Not part of `builtinProviders()`:
 * Google approves each app's client separately, so an app must register its own and add this provider itself.
 */
export function googleAiPlanProvider(client: GoogleAiPlanClient): Provider<"google-interactions"> {
	return createProvider({
		id: "google-ai-plan",
		name: "Google AI Ultra plan",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: {
			oauth: lazyOAuth({
				name: "Google AI Ultra plan",
				isSubscription: true,
				loginLabel: "Sign in with Google (AI Ultra)",
				load: () => loadGoogleAiPlanOAuth(client),
			}),
		},
		models: Object.values(GOOGLE_AI_PLAN_MODELS),
		api: googleInteractionsApi(),
	});
}
