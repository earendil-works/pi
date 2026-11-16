// The sessions plugin's contracts: a session as lists show it, the owner's sessions on the server, a session's facts
// for its own worker, and the session's worker as the owner sees it (`SessionWorker`). Every facet of the plugin
// imports this file.

import { arr, lit, method, nul, num, obj, opt, remote, Server, Session, type Static, str, union } from "@p3/app/v1";

/** Who made a session: the owner, or a person (by id). */
export const Creator = union([obj({ kind: lit("owner") }), obj({ kind: lit("person"), id: str() })]);

/** Who made a session (see `Creator`). */
export type Creator = Static<typeof Creator>;

/** The longest title a session takes. */
const TITLE = { max: 200 };

/** The fields of `SessionInfo`, which a `SessionRow` has too. */
const INFO = { title: str(TITLE), app: str(), creator: Creator, createdAt: num(), archivedAt: union([num(), nul()]) };

/**
 * What is known of a session besides its id: its title (empty until named: each view shows its own "New session" in the
 * viewer's language), app, creator, when it was made, and when it was archived (or `null`). No id inside: the session's
 * address is the key of its facts, and a copy under another address rewrites keys, never JSON (design §10, data
 * belonging to a host).
 */
export const SessionInfo = obj(INFO);

/** What is known of a session besides its id (see `SessionInfo`). */
export type SessionInfo = Static<typeof SessionInfo>;

/** A session as lists show it: its id and its info. */
export const SessionRow = obj({ id: str(), ...INFO });

/** A session as lists show it (see `SessionRow`). */
export type SessionRow = Static<typeof SessionRow>;

/** A session's facts: its info, or `null` for a session the server does not know. */
export const Facts = obj({ session: union([SessionInfo, nul()]) });

/** A session's facts (see `Facts`). */
export type Facts = Static<typeof Facts>;

/** The owner's sessions: the newest 200, and what the owner does with them. */
export const Sessions = remote("sessions.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		owner: {
			state: { list: arr(SessionRow) },
			methods: {
				/** Makes a session; answers its id. */
				create: method(obj({ title: opt(str(TITLE)) }), str()),
				rename: method(obj({ id: str(), title: str(TITLE) })),
				archive: method(obj({ id: str() })),
				restore: method(obj({ id: str() })),
			},
		},
	},
});

/** A session's facts for its own worker, which holds it as itself: its principal names the session (design §4). */
export const SessionFacts = remote("sessions.facts", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { worker: { state: { facts: Facts } } },
});

/**
 * A session's worker as the owner sees it: the facts it follows from the server. This slice's proof that a worker runs
 * per session and follows its facts live.
 */
export const SessionWorker = remote("sessions.worker", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { facts: Facts } } },
});
