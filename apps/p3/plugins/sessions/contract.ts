// The sessions plugin's contracts, one per audience, and the two admissions every session object uses. A session is
// one agent in one folder of one environment, with its members (persons and groups, who read or write) and its things
// (each with options). The owner manages sessions (`Sessions`), apps manage theirs in server code (`SessionsStore`,
// `contract.server.ts`); persons only work in the sessions they are members of. Every facet of the plugin imports this
// file, and `/v1` re-exports it for third-party plugins.

import {
	type Admission,
	type AdmitSelf,
	allow,
	arr,
	bool,
	callerKey,
	deny,
	type JsonValue,
	lit,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	type P3Principal,
	remote,
	type Schema,
	Server,
	Session,
	type Static,
	str,
	union,
	unknown,
	type Watchable,
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

/** A session's title: at most 200 characters; empty until named (each view shows its own "New session"). */
export const Title = str({ max: 200 });

/** Where a session works: an environment (the environments plugin's id) and a folder on it. */
export const Location = obj({ environment: str({ max: 200 }), folder: str({ max: 4096 }) });

/** Where a session works (see `Location`). */
export type Location = Static<typeof Location>;

/** How a member works in a session: reads (sees it), or writes (also sends and changes what its things allow). */
export const Access = oneOf("read", "write");

/** How a member works in a session (see `Access`). */
export type Access = Static<typeof Access>;

/** A person or a group (the people plugin's ids): who a member is, and whose options. */
export const Party = obj({ kind: oneOf("person", "group"), id: str() });

/** A person or a group (see `Party`). */
export type Party = Static<typeof Party>;

/** A session's member: a person or a group, and how it works there. */
export const Member = obj({ kind: oneOf("person", "group"), id: str(), access: Access });

/** A session's member (see `Member`). */
export type Member = Static<typeof Member>;

/**
 * A session as lists, pages and its worker see it: its id, app, title, location, when it was made, its state, when
 * it was last touched, and when it was archived (`null`: it is not).
 */
export const SessionRow = obj({
	id: str(),
	app: str(),
	title: Title,
	location: Location,
	createdAt: num(),
	state: SessionState,
	lastTouch: num(),
	archivedAt: union([num(), nul()]),
});

/** A session as lists and its worker see it (see `SessionRow`). */
export type SessionRow = Static<typeof SessionRow>;

/**
 * A kind of thing: its name (the thing's plugin's, `<plugin>.<kind>`), its options' schema and version, and the
 * options a thing gets when it is added without any. Defined once in the kind's plugin's contract file.
 */
export type ThingKind<O extends JsonValue> = {
	readonly name: string;
	readonly version: number;
	readonly options: Schema<O>;
	readonly initial: O;
	/**
	 * Options stored at an older version `from`, as this version's (run by the sessions plugin where it answers);
	 * `undefined`, or no `migrate`, gives the thing nothing until its options are set again.
	 */
	readonly migrate?: (options: JsonValue, from: number) => O | undefined;
};

/** Defines a kind of thing (see `ThingKind`). */
export function defineThingKind<const O extends JsonValue>(
	name: string,
	definition: {
		readonly version: number;
		readonly options: Schema<O>;
		readonly initial: O;
		readonly migrate?: (options: JsonValue, from: number) => O | undefined;
	},
): ThingKind<O> {
	return { name, ...definition };
}

/** The options of a thing of `Kind`. */
export type OptionsOf<Kind> = Kind extends ThingKind<infer O> ? O : never;

/** Who brought a thing into a session: the owner, a person (their own record, such as their mail), or the app. */
export const Bringer = union([
	obj({ kind: lit("owner") }),
	obj({ kind: lit("person"), id: str() }),
	obj({ kind: lit("app") }),
]);

/** Who brought a thing (see `Bringer`). */
export type Bringer = Static<typeof Bringer>;

/**
 * A thing as a session has it: its id in the session, its kind, the record of its kind's plugin it stands for (`""`
 * for a kind without records, such as the coding tools), who brought it, and the session's default options for it.
 */
export const SessionThing = obj({ thing: str(), kind: str(), ref: str(), by: Bringer, options: unknown() });

/** A thing as a session has it (see `SessionThing`). */
export type SessionThing = {
	readonly thing: string;
	readonly kind: string;
	readonly ref: string;
	readonly by: Bringer;
	readonly options: JsonValue;
};

/** A thing to add to a session: its kind, its record (none: `""`) and its default options (none: the kind's initial). */
export const NewThing = obj({ kind: str(), ref: opt(str()), options: opt(unknown()) });

/** A thing to add to a session (see `NewThing`). */
export type NewThing = { readonly kind: string; readonly ref?: string; readonly options?: JsonValue };

/** A thing of `kind` to add, its options typed by the kind (none: the kind's initial). */
export function thingOf<O extends JsonValue>(kind: ThingKind<O>, options?: O, ref?: string): NewThing {
	return { kind: kind.name, ...(options === undefined ? {} : { options }), ...(ref === undefined ? {} : { ref }) };
}

/** Whose options for a thing: the session's default (`everyone`), the agent's, or one member's. */
export const OptionsFor = union([obj({ kind: lit("everyone") }), obj({ kind: lit("agent") }), Party]);

/** Whose options for a thing (see `OptionsFor`). */
export type OptionsFor = Static<typeof OptionsFor>;

/** What the owner does with sessions: makes them, and manages their title, archive, members and things. */
export const Sessions = remote("sessions.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		owner: {
			methods: {
				/** Makes a session with its members and things, in one commit; answers its id. */
				create: method(
					obj({
						app: str(),
						title: opt(Title),
						location: Location,
						members: opt(arr(Member)),
						things: opt(arr(NewThing)),
					}),
					str(),
				),
				rename: method(obj({ session: str(), title: Title })),
				archive: method(obj({ session: str() })),
				restore: method(obj({ session: str() })),
				/** Adds a member, or changes its access. */
				addMember: method(obj({ session: str(), member: Member })),
				removeMember: method(obj({ session: str(), party: Party })),
				/** Adds a thing; answers its id in the session. */
				addThing: method(obj({ session: str(), thing: NewThing }), str()),
				/** Removes a thing from the session (nothing else: its record stays its plugin's). */
				removeThing: method(obj({ session: str(), thing: str() })),
				/** Sets whose options for a thing; `null` removes a member's or the agent's (they get the default again). */
				setOptions: method(obj({ session: str(), thing: str(), for: OptionsFor, options: unknown() })),
			},
		},
	},
});

/**
 * The kinds of things the owner may add to a session (`ThingKinds`, by title): each kind's name and title. A kind
 * whose things stand for records (a login) is added through its own plugin's view; this list adds with `{ kind }`.
 */
export const ThingKindCatalog = remote("sessions.thing-kinds", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { owner: { state: { kinds: arr(obj({ kind: str(), title: str() })) } } },
});

/**
 * One screen's list of an app's sessions, active (the last touched first) or archived (the last archived first):
 * `view` is the screen's own id, so a fresh id is a fresh list. The owner sees every session of the app, a person the
 * ones they are a member of. `list` holds the rows loaded so far and whether rows may follow; `more` loads the next
 * page. Holding it starts no worker.
 */
export const SessionsList = remote("sessions.list", {
	version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() },
	hostAddress: () => Server(),
	variants: {
		sessions: {
			state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) },
			methods: { more: method() },
		},
	},
});

/**
 * What the sessions plugin answers about a caller (`callerKey`) in a session: `none`, `read` or `write`. The owner
 * writes every session; a person as their memberships say (directly or through a group; `write` wins), none in an
 * archived session; the server's waker writes a session that is not archived; a worker its own session. Read live by
 * the route (before a worker starts) and by `admitSession`. Asked by the server about anyone, by a worker about its
 * own session, and by anyone else about themselves only (an admission's `get` asks as the object's caller).
 */
export const SessionAccess = remote("sessions.access", {
	version: 1,
	params: { session: str(), caller: str() },
	hostAddress: () => Server(),
	variants: { answer: { state: { access: oneOf("none", "read", "write") } } },
});

/** The admission value of every session object: how the caller works in the session. */
export const SessionAdmission = obj({ access: Access });

/**
 * The admission of a session object (params with `session`): denied without access, else the caller's access. The
 * one place besides the base that reads a principal, so no plugin has to.
 */
export function admitSession(
	params: { readonly session: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<{ access: Access }>> {
	const answer = self.get(SessionAccess, { session: params.session, caller: callerKey(principal) });
	return self.derive([answer.access], ([access]) =>
		access === "none" ? deny("no access to this session") : allow({ access }),
	);
}

/**
 * What the sessions plugin answers about a caller and one thing of a session: the caller's access to the session, and
 * the options that apply to them (their own, else their first group's in member order, else the session's default),
 * with the version they were written at. `none` too for a thing the session does not have.
 */
export const ThingAccess = remote("sessions.thing-access", {
	version: 1,
	params: { session: str(), thing: str(), caller: str() },
	hostAddress: () => Server(),
	variants: {
		answer: {
			state: {
				answer: union([
					obj({ access: lit("none") }),
					obj({ access: Access, kind: str(), ref: str(), version: num(), options: unknown() }),
				]),
			},
		},
	},
});

/**
 * The admission value of a thing's object, typed by its kind (`admission: thingAdmission(Kind)`): the caller's
 * access, the thing's record (`ref`, never taken from the page) and the options that apply to them.
 */
export function thingAdmission<O extends JsonValue>(kind: ThingKind<O>) {
	return obj({ access: Access, ref: str(), options: kind.options });
}

/**
 * The admission of a thing's object (params with `session` and `thing`) of `kind`: denied without access, for a
 * thing of another kind, and for options written at another version (never the defaults instead); else the caller's
 * access and options.
 */
export function admitThing<O extends JsonValue>(kind: ThingKind<O>) {
	return (
		params: { readonly session: string; readonly thing: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<{ access: Access; ref: string; options: O }>> => {
		const answer = self.get(ThingAccess, { ...params, caller: callerKey(principal) });
		return self.derive([answer.answer], ([found]) => {
			if (found.access === "none") return deny("no access to this thing");
			if (found.kind !== kind.name) return deny(`not a thing of ${kind.name}`);
			if (found.version !== kind.version) return deny(`its options are of version ${found.version}`);
			// The options were checked against the kind's schema when they were written, at this version.
			return allow({ access: found.access, ref: found.ref, options: found.options as O });
		});
	};
}

/** A record of a kind a caller may bring into a session: its id in the kind's plugin and its title. */
export const ThingRecord = obj({ ref: str(), title: str() });

/** A record a caller may bring (see `ThingRecord`). */
export type ThingRecord = Static<typeof ThingRecord>;

/**
 * What a writer of a session brings into it of their own (their mail, their calendar): every writer, the owner too.
 * `kinds` lists the kinds whose plugin offers the caller records, with them; `bring` adds one of those records as a
 * thing (its kind's initial options unless given), which everyone in the session then uses, through its views and
 * through the agent; `withdraw` and `setOptions` act on things the caller brought (the owner: on any). A thing of a
 * kind without records (the coding tools) only the owner and the app add.
 */
export const BringThings = remote("sessions.bring", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	admission: SessionAdmission,
	variants: {
		reader: {},
		writer: {
			methods: {
				kinds: method(obj({}), arr(obj({ kind: str(), title: str(), records: arr(ThingRecord) }))),
				bring: method(obj({ kind: str(), ref: str(), options: opt(unknown()) }), str()),
				withdraw: method(obj({ thing: str() })),
				setOptions: method(obj({ thing: str(), for: OptionsFor, options: unknown() })),
			},
		},
	},
});

/**
 * One session as a page sees it, without starting its worker: its row, its things and its members, and the caller's
 * access. The things and members are read whole (no cap).
 */
export const SessionInfo = remote("sessions.info", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	admission: SessionAdmission,
	variants: {
		info: {
			state: {
				session: SessionRow,
				access: Access,
				/**
				 * Each thing with its kind's title (the kind's name while no plugin serves it), its default options and
				 * its `overrides`: the options set for the agent and for members, in the order of whom they are for.
				 * Options are as the kind reads them now: `null` when it cannot (no plugin, another version).
				 */
				things: arr(
					obj({
						thing: str(),
						kind: str(),
						ref: str(),
						by: Bringer,
						options: unknown(),
						overrides: arr(obj({ for: OptionsFor, options: unknown() })),
						title: str(),
					}),
				),
				/** Each member with its name (a person's, a group's). */
				members: arr(obj({ kind: oneOf("person", "group"), id: str(), access: Access, name: str() })),
			},
		},
	},
});

/**
 * A session's own facts for its worker, which holds it as itself: its row (`null` for a session the server does not
 * know), its things with the options the agent gets (a thing whose options are not of its kind's current version
 * shows with `options: null`; the harness gives it nothing), and `report`, which says what its agent is doing now.
 */
export const SessionFacts = remote("sessions.facts", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: {
				session: union([SessionRow, nul()]),
				things: arr(obj({ thing: str(), kind: str(), ref: str(), version: num(), options: unknown() })),
			},
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

/** A session's worker as its members see it: the row it follows from the server (`null` before it arrived). */
export const SessionWorker = remote("sessions.worker", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: SessionAdmission,
	variants: { view: { state: { session: union([SessionRow, nul()]) } } },
});
