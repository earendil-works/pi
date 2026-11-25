// The sessions plugin's contracts, one per audience: what the owner does with sessions (`Sessions`), one screen's list
// of them (`SessionsList`), a session's row for its own worker (`SessionFacts`), and the session's worker as the owner
// sees it (`SessionWorker`). Every facet of the plugin imports this file.

import {
	arr,
	bool,
	lit,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	remote,
	Server,
	Session,
	type Static,
	str,
	union,
} from "@earendil-works/p3/v1";

/** Who made a session: the owner, or a person (by id). */
export const Creator = union([obj({ kind: lit("owner") }), obj({ kind: lit("person"), id: str() })]);

/** Who made a session (see `Creator`). */
export type Creator = Static<typeof Creator>;

/**
 * What a session's agent is doing:
 * - `working`: a run is in progress (its worker keeps itself alive; after a restart the waker starts it again);
 * - `waiting`: the run waits for a person;
 * - `settled`: nothing to do (a new session too);
 * - `failed`: the last run ended with an error.
 * Its worker reports each change (`SessionFacts.report`).
 */
export const SessionState = oneOf("working", "waiting", "settled", "failed");

/** What a session's agent is doing (see `SessionState`). */
export type SessionState = Static<typeof SessionState>;

/** A session's title: at most 200 characters. */
export const Title = str({ max: 200 });

/** The app every session belongs to until apps exist (slice 5): then `create` takes it. */
export const CODING = "coding";

/**
 * A session as lists and its worker see it: its id, title (empty until named: each view shows its own "New session" in
 * the viewer's language), app, creator, when it was made, its state, when it was last touched, and when it was
 * archived (`null`: it is not).
 */
export const SessionRow = obj({
	id: str(),
	title: Title,
	app: str(),
	creator: Creator,
	createdAt: num(),
	state: SessionState,
	lastTouch: num(),
	archivedAt: union([num(), nul()]),
});

/** A session as lists and its worker see it (see `SessionRow`). */
export type SessionRow = Static<typeof SessionRow>;

/** What the owner does with sessions. */
export const Sessions = remote("sessions.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		owner: {
			methods: {
				/** Makes a session; answers its id. */
				create: method(obj({ title: opt(Title) }), str()),
				rename: method(obj({ id: str(), title: Title })),
				archive: method(obj({ id: str() })),
				restore: method(obj({ id: str() })),
			},
		},
	},
});

/**
 * One screen's list of an app's sessions, active (the last touched first) or archived (the last archived first):
 * `view` is the screen's own id, so a fresh id is a fresh list. `list` holds the rows loaded so far and whether rows
 * may follow; `more` loads the next page.
 */
export const SessionsList = remote("sessions.list", {
	version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() },
	hostAddress: () => Server(),
	variants: {
		owner: {
			state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) },
			methods: { more: method() },
		},
	},
});

/**
 * A session's row for its own worker, which holds it as itself: its principal names the session (design §4). `null`
 * for a session the server does not know. `report` says what its agent is doing now (`SessionState`).
 */
export const SessionFacts = remote("sessions.facts", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { session: union([SessionRow, nul()]) },
			methods: { report: method(obj({ state: SessionState })) },
		},
	},
});

/**
 * A session's worker, for the server's waker: holding it starts the worker (after a restart, for a session whose run
 * was cut off), where the harness resumes the run once loaded.
 */
export const SessionStart = remote("sessions.start", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { server: { state: { session: str() } } },
});

/** A session's worker as the owner sees it: the row it follows from the server. */
export const SessionWorker = remote("sessions.worker", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { session: union([SessionRow, nul()]) } } },
});
