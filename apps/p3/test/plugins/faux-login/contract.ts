// The faux login's contract, for tests only: a kind of thing (`faux.login`) whose provider answers from a script in its
// options, and the requests it received on a session's worker (`FauxRequests`), so a test asserts what the model got.

import {
	arr,
	bool,
	defineThing,
	lit,
	obj,
	remote,
	Session,
	SessionAdmission,
	type Static,
	str,
	union,
} from "@earendil-works/p3/v1";

/** One part of a scripted answer: text, or a tool call (its arguments as JSON text). */
export const Reply = union([
	obj({ kind: lit("text"), text: str() }),
	obj({ kind: lit("tool"), name: str(), args: str() }),
]);

/**
 * A scripted answer: given to the first request whose last message (the user's text, or a tool result's) contains
 * `when`.
 */
export const Step = obj({ when: str(), reply: arr(Reply) });

/** A scripted answer (see `Step`). */
export type Step = Static<typeof Step>;

/**
 * A faux login: its provider's id (its one model is `<provider>-model`), its script, and whether it also gives the
 * tool `faux_session` (the session's title, read from the server through the agent's `call`).
 */
export const FauxLogin = defineThing("faux.login", {
	version: 1,
	options: obj({ provider: str(), script: arr(Step), tool: bool() }),
	initial: { provider: "faux", script: [], tool: false },
});

/** A request the faux provider received: its provider, the last message's text, the tools offered, whether matched. */
export const FauxRequest = obj({ provider: str(), last: str(), tools: arr(str()), matched: bool() });

/** A request the faux provider received (see `FauxRequest`). */
export type FauxRequest = Static<typeof FauxRequest>;

/** The requests the faux logins of a session's worker received, oldest first (in memory: a new worker starts empty). */
export const FauxRequests = remote("faux.requests", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: SessionAdmission,
	variants: { log: { state: { requests: arr(FauxRequest) } } },
});
