// The sessions plugin's contracts every facet imports: what a session is as data (its state, where it works and where
// each conversation moved to, its model, its row), what a new session starts with (`SessionDefaults`), the session
// kind's ticks by name, and the objects of the plugin's own audiences: a worker's facts and what its agent is given
// (`SessionFacts`, `AgentThings`), the waker's `SessionStart`, and `SessionWorker`. The kinds are in `kind.ts`, the
// admission of a session's objects on its worker in `follow.ts`; `/v1` re-exports what plugin authors need of the
// three.

import {
	arr,
	bool,
	map,
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

/** Where a conversation works (decision 24): a machine (its thing's id) and a folder on it. */
export const Location = obj({ machine: str({ max: 200 }), folder: str({ max: 4096 }) });

/** Where a conversation works (see `Location`). */
export type Location = Static<typeof Location>;

/** The session kind's name (`kind.ts`): a session is a workspace of this kind, its answer the one on itself. */
export const SESSION_KIND = "sessions.session";

/** Durable's conversation id as text (as `SessionHarness.submit` takes it): its one spelling, so a move is found by it. */
export const ConversationKey = str({ max: 20, pattern: "^[1-9][0-9]*$" });

/**
 * A conversation's move (what `moveLocation` takes): its id and where it works from now on; `null` undoes its move, so
 * it works where its owner conversation works again (a subagent's: its caller's; a top-level one: the session's).
 */
export const ConversationLocation = obj({ conversation: ConversationKey, location: union([Location, nul()]) });

/** A conversation's move (see `ConversationLocation`). */
export type ConversationLocation = Static<typeof ConversationLocation>;

/**
 * What a session's Manage shows besides its row, and its worker reads (decision 24): where each moved conversation
 * works, by conversation id. A conversation not moved works where its owner conversation works (a subagent's: its
 * caller's), and a top-level one at the session's `location`.
 */
export const SessionDetail = obj({ locations: map(Location) });

/** What a session's Manage shows (see `SessionDetail`). */
export type SessionDetail = Static<typeof SessionDetail>;

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
 * place): its id (its workspace's), where it works (its conversations unless moved, `SessionDetail`; `null`: nowhere,
 * its maker was let in on no machine where it was made, R41, until a conversation is moved), when it was made, its
 * state, when it was last touched, when it was archived (`null`: it is not) and its model (`null`: the agent's
 * default; else the model its agent is asked while a login it may Use gives it, decision 118).
 */
export const SessionRow = obj({
	id: str(),
	location: union([Location, nul()]),
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
 * hidden; decision 93), the view it opens with (item 74; `null`: the kind's) and where it works (`null`: this device
 * in a folder of its own; a folder `""`: that folder, the machine only what the new-session step offers first). A make
 * without a location starts there when its maker may use the machine (R41), else as with none.
 */
export const SessionDefaults = obj({
	model: union([ModelChoice, nul()]),
	shared: bool(),
	opensWith: union([str({ max: 200 }), nul()]),
	location: union([Location, nul()]),
});

/** What a new session starts with (see `SessionDefaults`). */
export type SessionDefaults = Static<typeof SessionDefaults>;

/**
 * What a new session made in `workspace` starts with now (the nearest defaults there, as a make reads them), live, for
 * a caller present there: what the new-session step pre-fills.
 */
export const SessionDefaultsHere = remote("sessions.defaults-here", {
	version: 1,
	params: { workspace: str() },
	hostAddress: () => Server(),
	admission: obj({}),
	state: { defaults: SessionDefaults },
});

/**
 * A session's own facts for its worker, which holds it as itself: its row (`null` for a session the server does not
 * know), its moved conversations (`detail`), `report`, which says what its agent is doing now, and `moveLocation`,
 * its agent's move of one conversation (refused unless the agents have Work there on that machine). Whether the
 * conversation exists is not checked here, the server cannot see it: the harness checks it for its agent's tool, and
 * the worker is trusted plugin code (decision 111).
 */
export const SessionFacts = remote("sessions.facts", {
	// Version 2: the row's model choice names a login (decision 118). Version 3: its moved conversations (`detail`,
	// `moveLocation`) and a location that may be none (decision 24, R41).
	version: 3,
	params: {},
	hostAddress: () => Server(),
	state: { session: union([SessionRow, nul()]), detail: SessionDetail },
	methods: { report: method(obj({ state: SessionState })), moveLocation: method(ConversationLocation) },
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
	// Version 2: the row's model choice names a login (decision 118). Version 3: a location that may be none (R41).
	version: 3,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: obj({}),
	state: { session: union([SessionRow, nul()]) },
});

/** The session kind's own ticks, by name. */
export type SessionTick = "read" | "send" | "stop" | "manage";
