// The faux login on the server, for tests only: the faux provider among those people may sign in to (its API key is
// its script, `keyOf`). A test makes a faux login with `scriptFaux` (`test/support.ts`).

import type { ProviderAuth } from "@earendil-works/p3/v1";
import { defineFacet, LoginProviders } from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { FAUX_MODEL, FAUX_NAME, FAUX_PROVIDER } from "./contract.ts";

export default defineFacet((_host, self) => {
	// The server signs in, lists the model and authorizes requests; it answers none.
	const faux = fauxProvider({ provider: FAUX_PROVIDER, api: "faux", models: [{ id: FAUX_MODEL }] });
	self.contribute(LoginProviders, [{ ...faux.provider, name: FAUX_NAME, auth: fauxAuth() }]);
});

/** The faux provider's auth: a key asked for at sign-in, the script, resolved from the login's credential only. */
function fauxAuth(): ProviderAuth {
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
