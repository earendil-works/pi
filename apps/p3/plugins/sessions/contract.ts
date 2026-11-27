// The sessions plugin's contracts every facet imports: what a session is as data (its state, where it works, its
// model, its row), what a new session starts with (`SessionDefaults`), the session kind's ticks by name, and the
// objects of the plugin's own audiences: a worker's facts and what its agent is given (`SessionFacts`, `AgentThings`),
// the waker's `SessionStart`, and `SessionWorker`. The kinds are in `kind.ts`, the admission of a session's objects on
// its worker in `follow.ts`; `/v1` re-exports what plugin authors need of the three.

import {
	arr,
	bool,
	method,
	nul,
	num,
	obj,
	oneOf,
	remote,
	Server,
	Session,
	type Static,
	str,
	union,
} from "@earendil-works/p3/v1";

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

/** Where a session works: a machine (its thing's id; the field keeps its old name) and a folder on it. */
export const Location = obj({ environment: str({ max: 200 }), folder: str({ max: 4096 }) });

/** Where a session works (see `Location`). */
export type Location = Static<typeof Location>;

/** How hard the model thinks (Durable's levels). */
export const ThinkingLevel = oneOf("off", "minimal", "low", "medium", "high", "xhigh", "max");

/**
 * A model choice: the login (its thing's id) and the model's id in its account, as `SessionModels` lists them, and
 * the thinking level (decision 118; version 2 of the columns that store it).
 */
export const ModelChoice = obj({ login: str({ max: 200 }), model: str({ max: 200 }), thinking: ThinkingLevel });

/** A model choice (see `ModelChoice`). */
export type ModelChoice = Static<typeof ModelChoice>;

/**
 * A session as its holders and its worker see it besides its thing (its name is the thing's, its parent the thing's
 * place): its id (its workspace's), where it works, when it was made, its state, when it was last touched, when it was
 * archived (`null`: it is not) and its model (`null`: the agent's default; else the model its agent is asked while
 * a login it may Use gives it, decision 118).
 */
export const SessionRow = obj({
	id: str(),
	location: Location,
	createdAt: num(),
	state: SessionState,
	lastTouch: num(),
	archivedAt: union([num(), nul()]),
	model: union([ModelChoice, nul()]),
});

/** A session as lists and its worker see it (see `SessionRow`). */
export type SessionRow = Static<typeof SessionRow>;

/**
 * What a new session starts with where this thing applies (the nearest one reaching its parent, decision 75): its
 * model, whether it is shared (everyone here Read and Send) or private (no grant for everyone, people from above
 * hidden; decision 93), and the view it opens with (item 74; `null`: the kind's).
 */
export const SessionDefaults = obj({
	model: union([ModelChoice, nul()]),
	shared: bool(),
	opensWith: union([str({ max: 200 }), nul()]),
});

/** What a new session starts with (see `SessionDefaults`). */
export type SessionDefaults = Static<typeof SessionDefaults>;

/**
 * A session's own facts for its worker, which holds it as itself: its row (`null` for a session the server does not
 * know), and `report`, which says what its agent is doing now.
 */
export const SessionFacts = remote("sessions.facts", {
	// Version 2: the row's model choice names a login (decision 118).
	version: 2,
	params: {},
	hostAddress: () => Server(),
	state: { session: union([SessionRow, nul()]) },
	methods: { report: method(obj({ state: SessionState })) },
});

/**
 * What a session's workspace gives its agent, for its worker, which holds it as itself: each thing the agent gets
 * anything for there, its kind and how far above the session it is linked (`depth`: 0 in the session, 1 its parent),
 * nearest last (the farthest first, then by thing id), live (the session's workspace is the session's id). The worker
 * holds a reference to each one whose kind has a harness part there (`HeldThings`), in this order.
 */
export const AgentThings = remote("sessions.agent-things", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { things: arr(obj({ thing: str(), kind: str(), depth: num() })) },
});

/**
 * A session's worker, for the server's waker: holding it starts the worker (after a restart, for a session whose run
 * was cut off), where the harness resumes the run once loaded.
 */
export const SessionStart = remote("sessions.start", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	state: { session: str() },
});

/** A session's worker as anyone let into the session sees it: the row it follows from the server (`null` before). */
export const SessionWorker = remote("sessions.worker", {
	// Version 2: the row's model choice names a login (decision 118).
	version: 2,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: obj({}),
	state: { session: union([SessionRow, nul()]) },
});

/** The session kind's own ticks, by name. */
export type SessionTick = "read" | "send" | "stop" | "manage";
