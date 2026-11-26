// The faux provider's sign-in, for tests only, on the server and on a session's worker: an API key, which is the
// script the provider answers from (`keyOf`).

import type { ProviderAuth } from "@earendil-works/pi-ai";

/** The faux provider's auth: a key asked for at sign-in, and resolved from the login's credential only. */
export function fauxAuth(): ProviderAuth {
	return {
		apiKey: {
			name: "Faux script",
			login: async (interaction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "The faux script (JSON)" }),
			}),
			resolve: async ({ credential }) =>
				credential?.key === undefined ? undefined : { auth: { apiKey: credential.key }, source: "faux script" },
		},
	};
}
