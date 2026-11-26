// The providers plugin's contract for server facets only: the store of the logins' credentials and of finished
// sign-ins (`LoginStore`; this plugin's own server code only: it checks no caller). Credentials pass only between this
// plugin's objects on the server; no remote contract carries one.

import { local, method, obj, oneOf, queries, type Static, str, unknown } from "@earendil-works/p3/v1";
import { AuthResult, Method } from "./contract.ts";

/**
 * A login as its store has it, without its credential: its provider, how it signs in, and whether it is signed in
 * (`signInAgain`: signed out, or its provider refused the last refresh).
 */
export const LoginRow = obj({
	thing: str(),
	provider: str(),
	method: Method,
	status: oneOf("signedIn", "signInAgain"),
});

/** A login as its store has it (see `LoginRow`). */
export type LoginRow = Static<typeof LoginRow>;

/** A finished sign-in's credential, given to the login it makes or signs in again: its provider and method too. */
export const Claimed = obj({ provider: str(), method: Method, credential: unknown() });

/**
 * The logins' credentials and the finished sign-ins (the credential is pi-ai's `Credential`, typed `unknown` here: an
 * OAuth credential carries fields of its provider's own; only this plugin's server code writes and reads it).
 */
export const LoginStore = local("providers.store", {
	version: 1,
	params: {},
	members: {
		logins: queries(LoginRow, { one: obj({ thing: str() }) }),
		/**
		 * Keeps a finished sign-in of `owner` (the `callerKey` of who signed in: a person, or the server for its own
		 * logins) for a while; answers its id (what a create step hands over).
		 */
		keep: method(obj({ owner: str(), provider: str(), method: Method, credential: unknown() }), str()),
		/** Takes `owner`'s finished sign-in `signIn` (`invalid` if it is not theirs, used or expired). */
		claim: method(obj({ owner: str(), signIn: str() }), Claimed),
		/** Drops `owner`'s finished sign-in `signIn`, if it is still kept. */
		drop: method(obj({ owner: str(), signIn: str() })),
		/** Sets login `thing`'s credential (a new login, or signed in again): it is signed in. */
		save: method(obj({ thing: str(), provider: str(), method: Method, credential: unknown() })),
		/** This Pi's device id for providers that sign in a device (made once, the same ever after). */
		device: method(obj({}), str()),
		/** Removes login `thing` (the login was deleted). */
		remove: method(obj({ thing: str() })),
		/**
		 * The request auth of login `thing`, its OAuth token refreshed first when it expired (one refresh at a time per
		 * login); a refused refresh marks it `signInAgain` and rejects.
		 */
		authorize: method(obj({ thing: str() }), AuthResult),
	},
});
