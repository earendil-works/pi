import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadCursorOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { CURSOR_MODELS } from "./cursor.models.ts";

export function cursorProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cursor",
		name: "Cursor Pro",
		baseUrl: "https://api2.cursor.sh",
		auth: {
			oauth: lazyOAuth({
				name: "Cursor Pro",
				isSubscription: true,
				loginLabel: "Sign in with Cursor Pro",
				load: loadCursorOAuth,
			}),
		},
		models: Object.values(CURSOR_MODELS),
		api: openAICompletionsApi(),
	});
}
