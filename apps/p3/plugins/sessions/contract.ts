// The sessions plugin's contracts, one per audience, and the two admissions every session object uses. A session is
// one agent in one folder of one environment, with its members (persons and groups, who read or write) and its things
// (each with options). The owner (a person whose row says so) manages sessions (`Sessions`), apps manage theirs in
// server code (`SessionsStore`, `contract.server.ts`); other persons only work in the sessions they are members of.
// Every facet of the plugin imports this file, and `/v1` re-exports it for third-party plugins.

import {
	type Admission,
	type AdmitSelf,
	allow,
	arr,
	bool,
	callerKey,
	deny,
	grantable,
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
 * it was last touched, when it was archived (`null`: it is not), and whom it follows (`null`: nobody): a session
 * that follows a person or a group also has, live, every thing that party has "in all my sessions" (`everywhere`;
 * following the owner includes the Pi's), while that party writes in the session.
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
	follows: union([Party, nul()]),
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
export function defineThing<const O extends JsonValue>(
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

/**
 * How a session has a thing: linked by a person (the owner too), the app (its server code) or the session's agent;
 * or `followed`: not linked, the session has it from whom it follows.
 */
export const Bringer = union([
	obj({ kind: lit("person"), id: str() }),
	obj({ kind: lit("app") }),
	obj({ kind: lit("agent") }),
	obj({ kind: lit("followed") }),
]);

/** Who linked a thing (see `Bringer`). */
export type Bringer = Static<typeof Bringer>;

/** A thing's name ("Plan", "Sketches"), the same in every session: at most 100 characters; empty shows its kind's title. */
export const ThingName = str({ max: 100 });

/**
 * Whom a thing belongs to: a person, a group, the Pi, or nobody (content of the sessions that use it, gone with the
 * last of them). Ownership is the sessions plugin's, never a kind's.
 */
export const ThingOwner = union([
	obj({ kind: lit("person"), id: str() }),
	obj({ kind: lit("group"), id: str() }),
	obj({ kind: lit("pi") }),
	obj({ kind: lit("none") }),
]);

/** Whom a thing belongs to (see `ThingOwner`). */
export type ThingOwner = Static<typeof ThingOwner>;

/** Whom a thing may be given (`keep`): a person, a group, or the Pi; never back to nobody. */
export const ThingKeeper = union([
	obj({ kind: lit("person"), id: str() }),
	obj({ kind: lit("group"), id: str() }),
	obj({ kind: lit("pi") }),
]);

/** Whom a thing may be given (see `ThingKeeper`). */
export type ThingKeeper = Static<typeof ThingKeeper>;

/**
 * A thing: a record of its kind with one id (its kind's plugin keys its content by it), its name, its owner, when
 * made, and `everywhere` ("in all my sessions", its owner's choice): every session that follows its owner has it.
 */
export const Thing = obj({
	id: str(),
	kind: str(),
	name: ThingName,
	owner: ThingOwner,
	createdAt: num(),
	everywhere: bool(),
});

/** A thing with its kind's title (the kind's name while no plugin serves it), as lists of things show it. */
export const TitledThing = obj({
	id: str(),
	kind: str(),
	name: ThingName,
	owner: ThingOwner,
	createdAt: num(),
	everywhere: bool(),
	title: str(),
});

/** A thing (see `Thing`). */
export type Thing = Static<typeof Thing>;

/**
 * A thing as a session uses it (a link): the session, the thing's id, kind, name and owner, and who linked it. Its
 * options are per party (`SessionsStore.options`).
 */
export const SessionThing = obj({
	session: str(),
	thing: str(),
	kind: str(),
	name: ThingName,
	owner: ThingOwner,
	by: Bringer,
});

/** A thing as a session uses it (see `SessionThing`). */
export type SessionThing = Static<typeof SessionThing>;

/**
 * A thing a session gets as it is made: a new one (its kind, name, owner (none: the session's content), the input its
 * kind's `create` takes, and its default options), or an existing one by id (with its default options here).
 */
export const ThingUse = union([
	obj({
		use: lit("new"),
		kind: str(),
		name: opt(ThingName),
		owner: opt(ThingOwner),
		input: opt(unknown()),
		options: opt(unknown()),
	}),
	obj({ use: lit("existing"), thing: str(), options: opt(unknown()) }),
]);

/** A thing a session gets as it is made (see `ThingUse`). */
export type ThingUse = Static<typeof ThingUse>;

/** A new thing of `kind` for a session, its options typed by the kind (none: the kind's initial; owner: nobody). */
export function thingOf<O extends JsonValue>(
	kind: ThingKind<O>,
	given: {
		readonly name?: string;
		readonly owner?: ThingOwner;
		readonly input?: JsonValue;
		readonly options?: O;
	} = {},
): ThingUse {
	return { use: "new", kind: kind.name, ...given };
}

/** An existing thing `thing` for a session, with its default options there (none: its kind's initial). */
export function usingThing(thing: string, options?: JsonValue): ThingUse {
	return { use: "existing", thing, ...(options === undefined ? {} : { options }) };
}

/** Whose options for a thing: the session's default (`everyone`), the agent's, or one member's. */
export const OptionsFor = union([obj({ kind: lit("everyone") }), obj({ kind: lit("agent") }), Party]);

/** Whose options for a thing (see `OptionsFor`). */
export type OptionsFor = Static<typeof OptionsFor>;

/**
 * What the owner does with sessions: makes them (with their things), and manages their title, archive and members.
 * Things are managed in a session through `SessionThings` (the owner writes every session) and in `MyThings`.
 */
export const Sessions = remote("sessions.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	// The owner's only (`admitOwner`, the people plugin's; its value `OwnerAdmission`, none).
	admission: obj({}),
	methods: {
		/** Makes a session with its members and things, in one commit; answers its id. */
		create: method(
			obj({
				app: str(),
				title: opt(Title),
				location: Location,
				members: opt(arr(Member)),
				/** New things for the session (its content unless owned), and existing ones. */
				things: opt(arr(ThingUse)),
				/** Whom it follows; left out: the owner who makes it; `null`: nobody. */
				follows: opt(union([Party, nul()])),
			}),
			str(),
		),
		/**
		 * Makes the session follow `follows` (`null`: nobody). With `keep` (the default), the things it had from
		 * whom it followed until now are linked to it, so stopping to follow takes nothing away until removed.
		 */
		follow: method(obj({ session: str(), follows: union([Party, nul()]), keep: opt(bool()) })),
		rename: method(obj({ session: str(), title: Title })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		/** Adds a member, or changes its access. */
		addMember: method(obj({ session: str(), member: Member })),
		removeMember: method(obj({ session: str(), party: Party })),
	},
});

/**
 * One screen's list of an app's sessions, active (the last touched first) or archived (the last archived first):
 * `view` is the screen's own id, so a fresh id is a fresh list. The owner sees every session of the app, a person the
 * ones they are a member of. `list` holds the rows loaded so far and whether rows may follow; `more` loads the next
 * page. Holding it starts no worker. Its admission says which (`every`: the owner's, read live from their row).
 */
export const SessionsList = remote("sessions.list", {
	version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() },
	hostAddress: () => Server(),
	admission: obj({ every: bool() }),
	state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) },
	methods: { more: method() },
});

/**
 * What the sessions plugin answers about a caller (`callerKey`) in a session: `none`, `read` or `write`. The owner
 * (a person whose row says so) writes every session, an archived one too; a person as their memberships say (directly or through a group; `write` wins), none in an
 * archived session; the server's waker writes a session that is not archived; a worker its own session. Read live by
 * the route (before a worker starts) and by `admitSession`. Asked by the server about anyone, by a worker about its
 * own session, and by anyone else about themselves only (an admission's `get` asks as the object's caller).
 */
export const SessionAccess = remote("sessions.access", {
	version: 1,
	params: { session: str(), caller: str() },
	hostAddress: () => Server(),
	state: { access: oneOf("none", "read", "write") },
});

/** The admission value of every session object: how the caller works in the session. */
export const SessionAdmission = obj({ access: Access });

/**
 * The admission of a session object (params with `session`): denied without access, else the caller's access, a
 * writer granted `writes` (its contract's grantable members a writer gets). The one place besides the base that
 * reads a principal, so no plugin has to.
 */
export function admitSession<const G extends string = never>(writes: readonly G[] = []) {
	return (
		params: { readonly session: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<{ access: Access; granted: G[] }>> => {
		const answer = self.get(SessionAccess, { session: params.session, caller: callerKey(principal) });
		return self.derive([answer.access], ([access]) =>
			access === "none"
				? deny("no access to this session")
				: allow({ access, granted: access === "write" ? [...writes] : [] }),
		);
	};
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
	state: {
		answer: union([
			obj({ access: lit("none") }),
			obj({ access: Access, kind: str(), version: num(), options: unknown() }),
		]),
	},
});

/**
 * The admission value of a thing's object, typed by its kind (`admission: thingAdmission(Kind)`): the caller's
 * access and the options that apply to them. The thing is the params' `thing`: its id, its content's key.
 */
export function thingAdmission<O extends JsonValue>(kind: ThingKind<O>) {
	return obj({ access: Access, options: kind.options });
}

/**
 * The admission of a thing's object (params with `session` and `thing`) of `kind`: denied without access, for a
 * thing of another kind, and for options written at another version (never the defaults instead); else the caller's
 * access and options, and what `grants` gives them of the object's grantable members (none without it).
 */
export function admitThing<O extends JsonValue, const G extends string = never>(
	kind: ThingKind<O>,
	grants?: (admitted: { readonly access: Access; readonly options: O }) => readonly G[],
) {
	return (
		params: { readonly session: string; readonly thing: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<{ access: Access; options: O; granted: G[] }>> => {
		const answer = self.get(ThingAccess, { ...params, caller: callerKey(principal) });
		return self.derive([answer.answer], ([found]) => {
			if (found.access === "none") return deny("no access to this thing");
			if (found.kind !== kind.name) return deny(`not a thing of ${kind.name}`);
			if (found.version !== kind.version) return deny(`its options are of version ${found.version}`);
			// The options were checked against the kind's schema when they were written, at this version.
			const admitted = { access: found.access, options: found.options as O };
			return allow({ ...admitted, granted: [...(grants?.(admitted) ?? [])] });
		});
	};
}

/** Whom a caller may make a thing for, or give one (`none` only to make): with a name to show. */
export const ThingOwnerChoice = obj({ owner: ThingOwner, name: str() });

/**
 * A session's things as a writer of it manages them (every writer, the owner too): `kinds`, the kinds of content
 * (`creation: "content"`), the only ones made inside a session; `owners`, whom the caller may give a thing (`keep`):
 * themselves, their groups, the Pi for the owner. `create` makes content (owned by nobody) and links it here; `add`
 * links an owned thing the caller manages; `remove`, `keep`, `rename`, `delete` and `setOptions` act on a thing this
 * session has that the caller manages: the owner any; a person their own and their groups'; the Pi's only the owner;
 * nobody's any writer of a session that uses it. A thing the session has from whom it follows cannot be removed here
 * (stop following, `Sessions.follow`); its options can be set. A reader gets nothing.
 */
export const SessionThings = remote("sessions.things", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	admission: SessionAdmission,
	// Every member is a writer's (`SESSION_THINGS_WRITES`).
	state: {
		kinds: grantable(arr(obj({ kind: str(), title: str() }))),
		owners: grantable(arr(ThingOwnerChoice)),
	},
	methods: {
		/** Makes content of `kind` (owned by nobody) and links it here; answers its id. */
		create: grantable(method(obj({ kind: str(), name: opt(ThingName), options: opt(unknown()) }), str())),
		/** Links an owned thing the caller manages (theirs, their group's, the Pi's for the owner) here. */
		add: grantable(method(obj({ thing: str(), options: opt(unknown()) }))),
		/** Unlinks a thing; one nobody owns is deleted with its last link. */
		remove: grantable(method(obj({ thing: str() }))),
		/** Gives a thing an owner (from nobody, or away); it stays linked. */
		keep: grantable(method(obj({ thing: str(), owner: ThingKeeper }))),
		rename: grantable(method(obj({ thing: str(), name: ThingName }))),
		/** Deletes a thing everywhere, with its content. */
		delete: grantable(method(obj({ thing: str() }))),
		/** Sets whose options for a thing here; `null` removes a member's or the agent's (they get the default again). */
		setOptions: grantable(method(obj({ thing: str(), for: OptionsFor, options: unknown() }))),
	},
});

/** What a writer of a session is granted of `SessionThings`: all of it. */
export const SESSION_THINGS_WRITES = [
	"kinds",
	"owners",
	"create",
	"add",
	"remove",
	"keep",
	"rename",
	"delete",
	"setOptions",
] as const;

/**
 * One screen's list of the things a person manages outside sessions: their own, their groups', and for the owner the
 * Pi's, by owner then name, those whose name starts with `prefix`; `more` loads the next page. `kinds`, the kinds a
 * person makes (`creation: "person"`: a login, an inbox, an MCP server), and `owners`, whom the caller may make them
 * for (themselves, their groups, the Pi for the owner). `create` makes one (never through the agent: it works for
 * everyone who writes in its session), "in all my sessions" unless `everywhere` is false; `setEverywhere`,
 * `rename`, `keep` (give away) and `delete` act on one of them. Who uses a thing: `ThingUses`.
 */
export const MyThings = remote("sessions.my-things", {
	version: 1,
	params: { view: str(), prefix: ThingName },
	hostAddress: () => Server(),
	state: {
		list: obj({ rows: arr(TitledThing), moreAfter: bool() }),
		kinds: arr(obj({ kind: str(), title: str() })),
		owners: arr(ThingOwnerChoice),
	},
	methods: {
		more: method(),
		/** Makes a thing of `kind` for `owner`, with the `input` its kind's creation view collected; answers its id. */
		create: method(
			obj({
				kind: str(),
				name: opt(ThingName),
				owner: ThingKeeper,
				input: opt(unknown()),
				everywhere: opt(bool()),
			}),
			str(),
		),
		/** Whether every session that follows the thing's owner has it ("in all my sessions"). */
		setEverywhere: method(obj({ thing: str(), everywhere: bool() })),
		rename: method(obj({ thing: str(), name: ThingName })),
		keep: method(obj({ thing: str(), owner: ThingKeeper })),
		delete: method(obj({ thing: str() })),
	},
});

/**
 * One screen's list of the sessions a thing is in (each with who linked it there), for whoever manages the thing
 * (admitted live: the owner any; a person their own and their groups'); `more` loads the next page.
 */
export const ThingUses = remote("sessions.thing-uses", {
	version: 1,
	params: { thing: str(), view: str() },
	hostAddress: () => Server(),
	// Nothing but the decision (`admitManager`).
	admission: obj({}),
	state: { list: obj({ rows: arr(obj({ session: str(), by: Bringer })), moreAfter: bool() }) },
	methods: { more: method() },
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
	state: {
		session: SessionRow,
		access: Access,
		/** The name of whom it follows now (a person's, a group's; `""` for nobody). */
		followsName: str(),
		/**
		 * Each thing with its name, its kind's title (the kind's name while no plugin serves it), its owner and
		 * their name now (`ownerName`: a person's, a group's, `""` for the Pi and nobody), who linked it and
		 * their name now (`byName`; `""` for the app and the agent), its default options here and its
		 * `overrides`: the options set for the agent and for members, in the order of whom they are for.
		 * Options are as the kind reads them now: `null` when it cannot (no plugin, another version).
		 */
		things: arr(
			obj({
				thing: str(),
				kind: str(),
				name: ThingName,
				owner: ThingOwner,
				ownerName: str(),
				by: Bringer,
				byName: str(),
				options: unknown(),
				overrides: arr(obj({ for: OptionsFor, options: unknown() })),
				title: str(),
			}),
		),
		/** Each member with its name (a person's, a group's). */
		members: arr(obj({ kind: oneOf("person", "group"), id: str(), access: Access, name: str() })),
	},
});

/**
 * A session's own facts for its worker, which holds it as itself: its row (`null` for a session the server does not
 * know), and `report`, which says what its agent is doing now. What the agent gets is the things plugin's (the things
 * the worker holds as the agent).
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
 * anything for there and its kind, by thing id, live (the session's workspace is the session's id). The worker holds a
 * reference to each one whose kind has a harness part there (`HeldThings`).
 */
export const AgentThings = remote("sessions.agent-things", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { things: arr(obj({ thing: str(), kind: str() })) },
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

/** A session's worker as its members see it: the row it follows from the server (`null` before it arrived). */
export const SessionWorker = remote("sessions.worker", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: SessionAdmission,
	state: { session: union([SessionRow, nul()]) },
});
