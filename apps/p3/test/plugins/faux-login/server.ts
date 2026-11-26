// The faux login on the server, for tests only: the faux provider among those people may sign in to (its API key is
// its script, `keyOf`). A test makes a faux login with `scriptFaux` (`test/support.ts`).

import { defineFacet, LoginProviders } from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { fauxAuth } from "./auth.ts";
import { FAUX_MODEL, FAUX_NAME, FAUX_PROVIDER } from "./contract.ts";

export default defineFacet((_host, self) => {
	// The server signs in, lists the model and authorizes requests; it answers none.
	const faux = fauxProvider({ provider: FAUX_PROVIDER, api: "faux", models: [{ id: FAUX_MODEL }] });
	self.contribute(LoginProviders, [{ ...faux.provider, name: FAUX_NAME, auth: fauxAuth() }]);
});
