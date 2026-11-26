// The sessions plugin's contracts: a session is a session workspace (decision 13), a leaf in the tree made with
// `Workspace.make` of `SessionKind` in its parent; who may read, send, stop and manage it are its ticks there. Its row
// (title, location, state, model) is the kind's state; the session defaults thing (`SessionDefaultsKind`) says what a
// new session starts with; the worker's objects (`SessionWorker`, the transcript) admit by the caller's answer on the
// session workspace (`followSession`). Every facet of the plugin imports this file, and `/v1` re-exports it.

import {
	type Admission,
	type AdmitSelf,
	allow,
	arr,
	bool,
	callerKey,
	deny,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	type P3Principal,
	remote,
	Server,
	Session,
	type Static,
	str,
	union,
	type Watchable,
} from "@earendil-works/p3/v1";
import { MAKE_ANY, MyAnswer } from "../things/contract.ts";
import { defineThing, defineWorkspace } from "../things/kind.ts";
import { messages } from "./messages.ts";

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

/** A session's title: at most 200 characters; empty until named (each view shows its own "New session"). */
export const Title = str({ max: 200 });

/** Where a session works: a machine (its thing's id; the field keeps its old name) and a folder on it. */
export const Location = obj({ environment: str({ max: 200 }), folder: str({ max: 4096 }) });

/** Where a session works (see `Location`). */
export type Location = Static<typeof Location>;

/** How hard the model thinks (Durable's levels). */
export const ThinkingLevel = oneOf("off", "minimal", "low", "medium", "high", "xhigh", "max");

/** A model choice: the provider, the model's id there and the thinking level. */
export const ModelChoice = obj({ provider: str({ max: 200 }), model: str({ max: 200 }), thinking: ThinkingLevel });

/** A model choice (see `ModelChoice`). */
export type ModelChoice = Static<typeof ModelChoice>;

/**
 * A session as lists, pages and its worker see it: its id (its workspace's), the workspace above it, its title (its
 * thing's name), location, when it was made, its state, when it was last touched, when it was archived (`null`: it is
 * not) and its model (`null`: the agent's default).
 */
export const SessionRow = obj({
	id: str(),
	parent: str(),
	title: Title,
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
 * A session workspace (decision 13): a leaf (things and people, never workspaces), made with `Workspace.make` in its
 * parent (`@make:sessions.session`; the maker gets every tick, items 88, 90). Its own ticks (decision 76: the
 * transcript is no thing, the session's ticks are its rights): Read, Send and Stop are flags the worker's objects
 * follow (`followSession`); Manage gives the changes of the session itself (R20). Its row is for everyone let in.
 * The agents get `MAKE_ANY` (R6: the makers ceiling leaves them the content kinds); a share's guests read (100). The
 * `everyone` default is the session defaults thing's (`shared`, decision 93): the create hook answers it.
 */
export const SessionKind = defineWorkspace("sessions.session", {
	version: 1,
	leaf: true,
	makers: "anyone",
	state: { row: SessionRow },
	methods: {
		rename: method(obj({ title: Title })),
		archive: method(),
		restore: method(),
		/** Sets the session's model (`null`: the agent's default). */
		setModel: method(obj({ model: union([ModelChoice, nul()]) })),
	},
	ticks: {
		read: { label: messages.message("tickRead") },
		send: { label: messages.message("tickSend"), for: "people" },
		stop: { label: messages.message("tickStop"), for: "people" },
		manage: {
			label: messages.message("tickManage"),
			for: "people",
			gives: ["rename", "archive", "restore", "setModel"],
		},
	},
	defaultGrants: { agents: [MAKE_ANY], everyone: ["read", "send"], guests: ["read"] },
	create: { input: obj({ location: opt(Location) }) },
});

/** One session held as itself (`{ workspace: id, thing: id }`): `SessionKind`'s contract. */
export const SessionObject = SessionKind.contract;

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
 * Session defaults as a thing (09: model, shared or private, opens with): the nearest one a new session sees applies
 * (`stacking: "nearest"`); people make them, Configure sets them; everyone here sees them (they open them with no
 * ticks); the agents' Use is a flag. The plugin seeds one in Pi.
 */
export const SessionDefaultsKind = defineThing("sessions.defaults", {
	version: 1,
	workspaces: "many",
	makers: "people",
	stacking: "nearest",
	state: { defaults: SessionDefaults },
	ticks: { use: { label: messages.message("tickUseDefaults"), for: "agents" } },
	defaultGrants: { agents: ["use"], everyone: [] },
	settings: ["defaults"],
});

/**
 * A session's own facts for its worker, which holds it as itself: its row (`null` for a session the server does not
 * know), and `report`, which says what its agent is doing now.
 */
export const SessionFacts = remote("sessions.facts", {
	version: 1,
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
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: obj({}),
	state: { session: union([SessionRow, nul()]) },
});

/** The session kind's own ticks, by name. */
export type SessionTick = "read" | "send" | "stop" | "manage";

/**
 * The admission of a session's object on its worker (params with `session`): the caller's answer on the session
 * workspace (`MyAnswer`, live; asked as the worker, about the caller); nothing given denies; else the caller is
 * granted the object's members `gives` names for each of the session's ticks they have (none without it).
 */
export function followSession<const G extends string = never>(
	gives: { readonly [T in SessionTick]?: readonly G[] } = {},
) {
	return (
		params: { readonly session: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<{ granted: G[] }>> => {
		const { session } = params;
		const mine = self.get(MyAnswer, { workspace: session, thing: session, caller: callerKey(principal) });
		return self.derive([mine.answer], ([answer]) =>
			// The answer's other ticks (the workspace's: Link, Configure) give nothing of a worker's object.
			answer === null
				? NOT_IN_SESSION
				: allow({ granted: answer.ticks.flatMap((tick) => gives[tick as SessionTick] ?? []) }),
		);
	};
}

/** The denial of a caller the session gives nothing: one value, so an unchanged denial is the same decision. */
const NOT_IN_SESSION = deny("sessions: nothing given in this session", messages.message("notInSession"));
