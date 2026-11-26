// The providers plugin's contract for server facets only: the store of the logins' credentials (`LoginStore`; this
// plugin's own server code only: it checks no caller). Credentials pass only between this plugin's objects on the
// server; no remote contract carries one, and no method answers one.

import { arr, local, method, nul, obj, oneOf, queries, type Static, str, union, unknown } from "@earendil-works/p3/v1";
import { RequestAuth, SignInMethod } from "./contract.ts";

/**
 * A login as its store has it, without its credential: its provider, how it signs in, whether it works
 * (`signInAgain`: its provider refused it or its refresh), and the ids of the models its account has (`null`: every
 * model of the provider).
 */
export const LoginRow = obj({
	thing: str(),
	provider: str(),
	method: SignInMethod,
	status: oneOf("signedIn", "signInAgain"),
	models: union([arr(str()), nul()]),
});

/** A login as its store has it (see `LoginRow`). */
export type LoginRow = Static<typeof LoginRow>;

/** The logins' credentials (pi-ai's `Credential`, typed `unknown` here: an OAuth one carries its provider's fields). */
export const LoginStore = local("providers.store", {
	version: 1,
	params: {},
	members: {
		logins: queries(LoginRow, { one: obj({ thing: str() }) }),
		/** Sets login `thing`'s credential (of `provider`): it is signed in, with the models its account has. */
		save: method(obj({ thing: str(), provider: str(), credential: unknown() })),
		/** Removes login `thing` (the login was deleted). */
		remove: method(obj({ thing: str() })),
		/**
		 * The request auth of login `thing`, its OAuth token refreshed first when it expired, one at a time per login (a
		 * save meanwhile wins over the refresh's result). A login whose provider refused it is refused at once until it
		 * is saved again.
		 */
		authorize: method(obj({ thing: str() }), RequestAuth),
		/** This Pi's device id for providers that sign in a device (made once, the same ever after). */
		device: method(obj({}), str()),
	},
});
