// The faux inbox's contract, for tests only: a kind of thing a person makes in My things (`faux.inbox`, creation
// `person`) through its creation view, which hands over a sign-in id; and the store that kept that sign-in
// (`FauxInboxStore`), which a test reads through the server's host to see the input arrive.

import { defineThing, local, method, nul, obj, str, union } from "@earendil-works/p3/v1";

/** A faux inbox; one option: whether the agent may read it (nothing reads it: options only so a kind has some). */
export const FauxInboxKind = defineThing("faux.inbox", {
	version: 1,
	options: obj({ read: str() }),
	initial: { read: "all" },
});

/** What the inbox's creation view hands over: a sign-in id (a real kind's would name a pending sign-in). */
export const FauxSignIn = obj({ signIn: str({ min: 1, max: 100 }) });

/** The sign-in each faux inbox was made with, by its thing's id; server code only. */
export const FauxInboxStore = local("faux.inbox.store", {
	version: 1,
	params: {},
	members: {
		/** The sign-in inbox `thing` was made with (`null`: none, or it was deleted). */
		signInOf: method(obj({ thing: str() }), union([str(), nul()])),
		/** Keeps inbox `thing`'s sign-in. */
		keep: method(obj({ thing: str(), signIn: str() })),
		/** Drops inbox `thing`'s sign-in (the thing is gone). */
		drop: method(obj({ thing: str() })),
	},
});
