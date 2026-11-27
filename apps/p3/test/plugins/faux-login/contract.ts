// The faux login's contract, for tests only: the faux provider (`faux`, one model `faux-model`) people sign in to with
// an API key that is its script (a test's script travels as a login's credential, so every answer proves the
// request auth came from the login's object on the server), and the requests it received on a session's worker
// (`FauxRequests`), so a test asserts what the model got; `FauxScript` scripts a workspace's faux login over a link.

import {
	arr,
	bool,
	lit,
	method,
	OwnerAdmission,
	obj,
	remote,
	Server,
	Session,
	type Static,
	str,
	union,
} from "@earendil-works/p3/v1";

/** The faux provider's id. */
export const FAUX_PROVIDER = "faux";

/** The faux provider's name. */
export const FAUX_NAME = "Faux";

/** The faux provider's one model. */
export const FAUX_MODEL = "faux-model";

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

/** The API key of a faux login answering from `script`. */
export function keyOf(script: readonly Step[]): string {
	return JSON.stringify(script);
}

/** A request the faux provider received: its provider, the last message's text, the tools offered, whether matched. */
export const FauxRequest = obj({ provider: str(), last: str(), tools: arr(str()), matched: bool() });

/** A request the faux provider received (see `FauxRequest`). */
export type FauxRequest = Static<typeof FauxRequest>;

/**
 * The requests the faux provider of a session's worker received, oldest first (in memory: a new worker starts empty).
 * Test-only and unadmitted: who reaches the session's worker at all is the route's to decide.
 */
export const FauxRequests = remote("faux.requests", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	state: { requests: arr(FauxRequest) },
});

/**
 * The faux login of a workspace scripted over a link (a launched server's owner client, the bench): what `scriptFaux`
 * does in a test's process, for the owner. Test-only.
 */
export const FauxScript = remote("faux.script", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	admission: OwnerAdmission,
	methods: { script: method(obj({ workspace: str(), script: arr(Step) }), str()) },
});
