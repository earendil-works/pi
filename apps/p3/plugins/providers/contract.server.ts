// The providers plugin's contracts for server facets only: the store of the logins' credentials (`LoginStore`) and a
// person's sign-ins with the credentials of finished ones (`SignIns`); this plugin's own server code only: they check
// no caller. Credentials pass only between this plugin's objects on the server; no remote contract carries one, and no
// method answers one.

import {
	arr,
	int,
	local,
	method,
	nul,
	obj,
	oneOf,
	opt,
	queries,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import { Source } from "../things/contract.ts";
import { Attempt, RequestAuth, SignInMethod } from "./contract.ts";

/**
 * A login as its store has it, without its credential: its provider, how it signs in, whether it works
 * (`signInAgain`: its provider refused it or its last refresh failed, a while ago or less), and the ids of the models
 * its account has (`null`: every model of the provider).
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

/**
 * What a refresh changes of a login: its credential (pi-ai's), the models its account has and its version (a rotation),
 * when it failed, and which server process holds the login for a refresh (`holder` `""`: none).
 */
export const LoginChange = obj({
	credential: opt(unknown()),
	models: opt(union([arr(str()), nul()])),
	version: opt(str()),
	failedAt: opt(int()),
	holder: opt(str()),
});

/** What a refresh changes of a login (see `LoginChange`). */
export type LoginChange = Static<typeof LoginChange>;

/** The logins' credentials (pi-ai's `Credential`, typed `unknown` here: an OAuth one carries its provider's fields). */
export const LoginStore = local("providers.store", {
	version: 1,
	params: {},
	members: {
		logins: queries(LoginRow, { one: obj({ thing: str() }) }),
		/** Stores new login `thing`'s credential (of `provider`); `invalid` if it has one already. */
		create: method(obj({ thing: str(), provider: str(), credential: unknown() })),
		/** Replaces login `thing`'s credential; `invalid` unless it has one, of the same `provider`. */
		replace: method(obj({ thing: str(), provider: str(), credential: unknown() })),
		/** Removes login `thing` (the login was deleted). */
		remove: method(obj({ thing: str() })),
		/**
		 * The request auth of login `thing`, its OAuth token refreshed first when it expired: one refresh at a time per
		 * login, across the store's objects too (a reload), each written over the credential it read only, kept also
		 * when its caller or the store's object went away meanwhile. A login whose refresh failed is refused at once for
		 * a while, a request waiting for that refresh too; then one request tries again, and a success clears it.
		 */
		authorize: method(obj({ thing: str() }), RequestAuth),
		/** This Pi's device id for providers that sign in a device (made once, the same ever after). */
		device: method(obj({}), str()),
		/**
		 * Writes `change` to login `thing` if its credential is still of `version`: what a refresh that outlived the
		 * store's previous object (a reload that stopped waiting for it) hands its successor.
		 */
		settle: method(obj({ thing: str(), version: str(), change: LoginChange })),
	},
});

/**
 * One person's sign-in (`owner`: their `callerKey`; the server's for its own logins) and the credentials of finished
 * ones, waiting for a login.
 */
export const SignIns = local("providers.sign-ins", {
	version: 1,
	params: { owner: str() },
	members: {
		attempt: union([Attempt, nul()]),
		start: method(obj({ provider: str(), method: SignInMethod }), str()),
		answer: method(obj({ prompt: str(), value: str() })),
		cancel: method(obj({ attempt: str() })),
		/** Holds `credential` (pi-ai's) of `provider` as a finished sign-in, for a login server code makes; its id. */
		hold: method(obj({ provider: str(), credential: unknown() }), str()),
		/** Gives the finished sign-in `attempt` to login `thing` (`invalid` if none waits: used, dropped or expired). */
		adopt: method(obj({ attempt: str(), thing: str() })),
		/**
		 * The login named `name` that `by` made in `workspace`, made now with `credential` of `provider` if there is
		 * none; one at a time for the owner, so two at once make one.
		 */
		ensure: method(obj({ name: str(), workspace: str(), by: Source, provider: str(), credential: unknown() }), str()),
	},
});
