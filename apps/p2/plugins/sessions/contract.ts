import { arr, bool, int, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import type { Ctx } from "@p2/app/v1";
import {
	evolve,
	keyedRegistry,
	literal,
	local,
	ModelRefSchema,
	method,
	param,
	propertiesOf,
	record,
	remote,
	SessionLockSchema,
	serverHost,
	sessionHost,
	ThinkingLevelSchema,
} from "@p2/app/v1";

export {
	isThinkingLevel,
	ModelRefSchema,
	THINKING_LEVELS,
	type ThinkingLevel,
	ThinkingLevelSchema,
} from "@p2/app/v1";

/** A session row's fields before `/tree` (`Sessions` v3, `Catalog` v2). */
const SESSION_FIELDS = {
	id: str(),
	env: opt(union([str(), nul()])),
	cwd: str(),
	title: str(),
	createdAt: num(),
	updatedAt: num(),
	archivedAt: union([num(), nul()]),
	pinned: bool(),
	model: ModelRefSchema,
	thinkingLevel: str(),
};
const SessionSchemaV3 = obj(SESSION_FIELDS);

/** `Sessions` v4 and `Catalog` v3: branch labels were always text. */
const BranchSchemaV4 = obj({ conversation: int({ minimum: 1 }), label: str() });
const SessionSchemaV4 = obj({ ...SESSION_FIELDS, main: int({ minimum: 1 }), branches: arr(BranchSchemaV4) });

/**
 * A `/tree` branch as the sidebar lists it: its conversation and its stored label (`MainDoc`); null shows the session
 * title (conversation 1 until it is renamed).
 */
export const BranchSchema = obj({ conversation: int({ minimum: 1 }), label: union([str(), nul()]) });
export type Branch = Static<typeof BranchSchema>;

export const SessionSchema = obj({
	...SESSION_FIELDS,
	/** The current main conversation: 1, or the `/tree` branch the session continues in (`docs/tree.md`). */
	main: int({ minimum: 1 }),
	/** The top-level conversations, newest first; empty until the worker reported them. */
	branches: arr(BranchSchema),
});
export type Session = Static<typeof SessionSchema>;

/** Cleanup completed before an archive call returns (e.g. session-owned port forwards). */
export const SessionArchived = keyedRegistry<(session: string, ctx: Ctx) => Promise<void>>("p2.session-archived");

/**
 * What a copy of a session takes over from its source (`/clone`, `/fork`; e.g. its project), called once the copy's row
 * exists and before its copying starts.
 */
export const SessionCopied =
	keyedRegistry<(source: string, copy: string, ctx: Ctx) => Promise<void>>("p2.session-copied");

/** Pi Mobile's MAX_SESSION_TITLE. */
export const MAX_TITLE = 120;
const Id = obj({ id: str() });
const Title = str({ minLength: 1, maxLength: MAX_TITLE });

export const CreateSchema = obj({
	env: opt(union([str({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" }), nul()])),
	createDirectory: opt(bool()),
	cwd: str({ minLength: 1 }),
	title: opt(str()),
	model: opt(ModelRefSchema),
	thinkingLevel: opt(ThinkingLevelSchema),
});

/** A session ID: a UUID, chosen by the server or by the client (so a page can navigate before the answer). */
export const SessionIdSchema = str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });

/** `Sessions.create` from version 6: `id`, the new session's ID chosen by the caller (default a new one). */
export const CreateArgsSchema = obj({ ...propertiesOf(CreateSchema), id: opt(SessionIdSchema) });

/** A lifecycle operation: what runs as a job after its method answered. */
export const OperationKindSchema = union([literal("relocate"), literal("clone"), literal("fork"), literal("archive")]);

/**
 * A lifecycle operation of a session in progress or failed (`Sessions.operations`): `session` the session it acts on,
 * `target` the new session a clone or fork makes (its row exists from the start; its worker starts once the copy is
 * done). `copying`: a clone's or fork's files are being copied (the target's worker waits). A failed one stays until
 * it is dismissed, with why it failed; what it changed was rolled back (a failed copy's row is archived).
 */
export const OperationSchema = union([
	obj({
		phase: literal("running"),
		id: str(),
		kind: OperationKindSchema,
		session: str(),
		target: union([str(), nul()]),
		copying: bool(),
	}),
	obj({
		phase: literal("failed"),
		id: str(),
		kind: OperationKindSchema,
		session: str(),
		target: union([str(), nul()]),
		error: str(),
	}),
]);
export type Operation = Static<typeof OperationSchema>;

/**
 * Every session's catalog row by its id (server, host-internal): built once per catalog write, so each worker's view
 * of its own row (`Sessions`, worker variant) is a lookup, not a scan of the rows.
 */
export const SessionIndex = local("p2.session-index", {
	version: 1,
	params: {},
	members: { byId: record(SessionSchema) },
});

/**
 * Archived sessions whose worker may start anyway, without resuming Durable work: rebuilding their search index
 * (server, host-internal; the search plugin's `rebuildIndex`, as Pi Mobile's).
 */
export const ArchivedStarts = local("p2.archived-starts", {
	version: 1,
	params: {},
	members: {
		allowed: arr(str()),
		allow: method(obj({ session: str() })),
		end: method(obj({ session: str() })),
	},
});

const CatalogCreate = obj({
	/** A chosen ID (the caller's, a clone's or a fork's); default a new one. */
	id: opt(SessionIdSchema),
	env: opt(union([str(), nul()])),
	cwd: str(),
	title: str(),
	/** The title was given, not the placeholder: automatic titles never replace it. */
	titleEdited: opt(bool()),
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
});
const UPDATE_FIELDS = {
	id: str(),
	cwd: opt(str()),
	env: opt(union([str(), nul()])),
	title: opt(str()),
	pinned: opt(bool()),
	archived: opt(bool()),
	model: opt(ModelRefSchema),
	thinkingLevel: opt(ThinkingLevelSchema),
};

/** The catalog before `/tree`, the base of its history (2: thinking levels are an enum). */
const CatalogV2 = local("p2.catalog", {
	version: 2,
	params: {},
	members: {
		sessions: arr(SessionSchemaV3),
		get: method(Id, SessionSchemaV3),
		create: method(CatalogCreate, SessionSchemaV3),
		/** Applies indexed activity without replacing an explicit title or moving time backwards. */
		activity: method(obj({ id: str(), timestamp: num(), firstUserText: opt(str()) })),
		update: method(obj(UPDATE_FIELDS), SessionSchemaV3),
	},
});

/** 3: `main` and `branches`. */
const CatalogV3 = evolve(CatalogV2, (e) =>
	e
		.state("sessions", arr(SessionSchemaV4))
		.result("get", SessionSchemaV4)
		.result("create", SessionSchemaV4)
		.method(
			"update",
			obj({ ...UPDATE_FIELDS, main: opt(int({ minimum: 1 })), branches: opt(arr(BranchSchemaV4)) }),
			SessionSchemaV4,
		),
);

/**
 * The session catalog (server, the server store's table keyed by each session's address): every session, archived ones included. Host-internal. 4: a branch's label may
 * be null (the session title). The provider still serves 2 and 3 (its `accepts`).
 */
export const Catalog = evolve(CatalogV3, (e) =>
	e
		.state("sessions", arr(SessionSchema))
		.result("get", SessionSchema)
		.result("create", SessionSchema)
		.method(
			"update",
			obj({ ...UPDATE_FIELDS, main: opt(int({ minimum: 1 })), branches: opt(arr(BranchSchema)) }),
			SessionSchema,
		),
);

/**
 * Sessions as a principal sees them, before `/tree`: the base of the history (2: thinking levels are an enum;
 * configureSelf takes either field alone. 3: `clone` and `fork` (owner)).
 */
const SessionsV3 = remote("p2.sessions", {
	version: 3,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				sessions: arr(SessionSchemaV3),
				/** Working directory suggested for a new session: the most recently active one, or the home directory. */
				defaultCwd: str(),
				defaultEnv: union([str(), nul()]),
			},
			methods: {
				create: method(CreateSchema, SessionSchemaV3),
				relocate: method(
					obj({
						id: str(),
						cwd: str({ minLength: 1 }),
						env: union([str(), nul()]),
					}),
				),
				rename: method(obj({ id: str(), title: Title })),
				pin: method(obj({ id: str(), pinned: bool() })),
				archive: method(Id),
				restore: method(Id),
				/**
				 * A copy of the session as it is now (pi's `/clone`): its store with every conversation, and its artifacts,
				 * downloads and uploads, under a new ID. Refused while the session's worker has work running.
				 */
				clone: method(Id, SessionSchemaV3),
				/**
				 * A new session holding the active context of `conversation` before the entry `before` (pi's `/fork` from a
				 * user message: that message is not part of it). The main conversation or one of its `/tree` branches.
				 */
				fork: method(
					obj({
						id: str(),
						conversation: int({ minimum: 1 }),
						before: int({ minimum: 1 }),
					}),
					SessionSchemaV3,
				),
			},
		},
		/** A guest sees its one session while it is not archived. */
		guest: {
			state: { sessions: arr(SessionSchemaV3) },
		},
		worker: {
			state: { session: union([SessionSchemaV3, nul()]) },
			methods: {
				renameSelf: method(obj({ title: Title }), obj({ previous: str() })),
				/** The root conversation's configuration changed (either field alone): the catalog entry follows. */
				configureSelf: method(obj({ model: opt(ModelRefSchema), thinkingLevel: opt(ThinkingLevelSchema) })),
			},
		},
	},
});

/** 4: rows carry `main` and `branches`; the worker's `treeSelf`. */
const SessionsV4 = evolve(SessionsV3, (e) =>
	e
		.state("owner", "sessions", arr(SessionSchemaV4))
		.state("guest", "sessions", arr(SessionSchemaV4))
		.state("worker", "session", union([SessionSchemaV4, nul()]))
		.result("create", SessionSchemaV4)
		.result("clone", SessionSchemaV4)
		.result("fork", SessionSchemaV4)
		.addMethod("worker", "treeSelf", obj({ main: int({ minimum: 1 }), branches: arr(BranchSchemaV4) }), nul()),
);

/** 5: a branch's label may be null (the session title). */
const SessionsV5 = evolve(SessionsV4, (e) =>
	e
		.state("owner", "sessions", arr(SessionSchema))
		.state("guest", "sessions", arr(SessionSchema))
		.state("worker", "session", union([SessionSchema, nul()]))
		.result("create", SessionSchema)
		.result("clone", SessionSchema)
		.result("fork", SessionSchema)
		.args("treeSelf", obj({ main: int({ minimum: 1 }), branches: arr(BranchSchema) })),
);

/**
 * Sessions as a principal sees them. The owner lists and manages all; a guest sees its own session; a worker sees
 * and renames only its own session (its principal names it). The provider still serves 3, 4 and 5 (its `accepts`):
 * pages and TUIs loaded before a deploy keep working.
 *
 * 6, client-chosen IDs and lifecycle operations as jobs: `create` takes the new session's `id`, `clone` and `fork` the
 * copy's (`copy`), so a page navigates at once. `clone`, `fork`, `relocate` and `archive` answer once their effect is
 * visible (the copy's row, the archived row) or started (a move), and their long part runs as a job, shown in
 * `operations` (running, then gone or failed with its error) until `dismissOperation`. A `relocate` the worker
 * refuses (busy) is a failed operation.
 *
 * The worker's `treeSelf`: the session's main conversation or its branches changed (a `/tree` switch or fork, a branch
 * renamed), or the worker started; the catalog entry follows, so clients open the main one and list the branches.
 */
export const Sessions = evolve(SessionsV5, (e) =>
	e
		.args("create", CreateArgsSchema)
		.args("clone", obj({ id: str(), copy: opt(SessionIdSchema) }))
		.args(
			"fork",
			obj({
				id: str(),
				conversation: int({ minimum: 1 }),
				before: int({ minimum: 1 }),
				copy: opt(SessionIdSchema),
			}),
		)
		.addState("owner", "operations", arr(OperationSchema))
		.addMethod("owner", "dismissOperation", obj({ operation: str() }), nul()),
);

const Location = obj({ id: str(), cwd: str({ minLength: 1 }), env: union([str(), nul()]) });

/**
 * The sessions' creation and lifecycle operations (server, host-internal; a host-lifetime object, so its job runs
 * persist): each lifecycle method answers once its visible effect committed and runs the rest as a job (`operations`). `move` is the agent's
 * relocation (`SessionMoves`): it waits for the job and answers why a busy worker refused (nothing recorded).
 */
export const SessionOperations = local("p2.session-operations", {
	version: 1,
	params: {},
	members: {
		operations: arr(OperationSchema),
		/**
		 * A new session's row (`Sessions.create` for the owner, the conversations tool's `create`): the location checked
		 * (`~` expanded, a directory, `createDirectory` makes it), the default model unless one is given. A chosen ID
		 * already in the catalog is a retry of the same request: its row is the answer.
		 */
		create: method(CreateArgsSchema, SessionSchema),
		move: method(Location, obj({ refused: union([str(), nul()]) })),
		relocate: method(Location),
		clone: method(obj({ id: str(), copy: SessionIdSchema }), SessionSchema),
		fork: method(
			obj({ id: str(), conversation: int({ minimum: 1 }), before: int({ minimum: 1 }), copy: SessionIdSchema }),
			SessionSchema,
		),
		archive: method(obj({ id: str() })),
		restore: method(obj({ id: str() })),
		dismiss: method(obj({ operation: str() })),
	},
});

/**
 * Moving a session to another location (server, host-internal): `Sessions.relocate` for the owner, and the locations
 * plugin's `location_move` once the main agent's turn has ended. Validates the destination (throws when it is not a
 * directory or its environment is not configured), then moves the catalog entry and the running worker in place.
 * `refused` is why a busy worker could not be fenced (nothing moved; try again once it is idle), else null.
 */
export const SessionMoves = local("p2.session-moves", {
	version: 1,
	params: {},
	members: {
		relocate: method(
			obj({
				id: str(),
				cwd: str({ minLength: 1 }),
				env: union([str(), nul()]),
			}),
			obj({ refused: union([str(), nul()]) }),
		),
	},
});

/**
 * Moving history between session workers for `Sessions.fork` (the server only): the active context before an entry as
 * entry drafts, the session's files copied into the fork's directory, and seeding a new session's main conversation
 * with them before anyone sends to it.
 */
export const SessionTransfer = remote("p2.session-transfer", {
	// 3: `copyFiles`.
	version: 3,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				/** Durable `EntryDraft`s: kind, data, the model messages with context edits applied, `head: "self"` first. */
				history: method(
					obj({ conversation: int({ minimum: 1 }), before: int({ minimum: 1 }) }),
					obj({ entries: arr(unknown()) }),
				),
				/** Appends `entries` to the main conversation in one commit; refused when it has history already. */
				seed: method(obj({ entries: arr(unknown()) })),
				/**
				 * Copies this session's files (the kit's `Files`: index and blobs) into the directory of the new session
				 * `to`, which must not exist yet (its worker waits while a fork copies).
				 */
				copyFiles: method(obj({ to: str() })),
			},
		},
	},
});

const LockOrNone = union([SessionLockSchema, nul()]);

/** Every session's lock (server, host-internal, persisted): set by the owner, followed by MCP placement and workers. */
export const SessionLocks = local("p2.session-locks", {
	version: 1,
	params: {},
	members: {
		locks: record(SessionLockSchema),
		set: method(obj({ session: str(), lock: LockOrNone })),
	},
});

/**
 * A session's lock as the owner and the session's worker see it: the owner reads and sets every session's; a worker
 * reads its own session's (its principal names it).
 */
export const SessionLock = remote("p2.session-lock", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { locks: record(SessionLockSchema) },
			methods: { set: method(obj({ session: str(), lock: LockOrNone })) },
		},
		worker: { state: { lock: LockOrNone } },
	},
});

/**
 * How long a sidebar rollup keeps showing a session that nothing else keeps in view (pinned, open, working, unread,
 * failed): one day, three days, a week, or as long as it is not archived.
 */
export const SidebarWindowSchema = union([literal("1d"), literal("3d"), literal("1w"), literal("forever")]);
export type SidebarWindow = Static<typeof SidebarWindowSchema>;

/** A rollup's key (plugins/sessions/sidebar/model.ts): `recent`, `projects`, `folders`, `archive`. */
const SidebarKey = str({ minLength: 1, maxLength: 1000 });

const SIDEBAR_SETTINGS_STATE = {
	/** Rollup keys in the order the owner put them; rollups not named follow in their default order. */
	order: arr(str()),
	/** Each rollup's window by key; a rollup not named has the default. */
	windows: record(SidebarWindowSchema),
	/** Whether a rollup shows only its heading, by key; one not named shows its sessions. */
	collapsed: record(bool()),
};
const SIDEBAR_SETTINGS_METHODS = {
	setOrder: method(obj({ order: arr(SidebarKey, { maxItems: 100 }) })),
	setWindow: method(obj({ key: SidebarKey, window: SidebarWindowSchema })),
	setCollapsed: method(obj({ key: SidebarKey, collapsed: bool() })),
};

/**
 * The owner's sidebar settings (server, host-internal, persisted in the server's store: a person's view, not the
 * session catalog): the rollups' order and windows, and which rollups are collapsed.
 */
export const SidebarSettingsStore = local("p2.sidebar-settings-store", {
	version: 1,
	params: {},
	members: { ...SIDEBAR_SETTINGS_STATE, ...SIDEBAR_SETTINGS_METHODS },
});

/** The owner's sidebar settings, and the methods that change them. */
export const SidebarSettings = remote("p2.sidebar-settings", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: { owner: { state: SIDEBAR_SETTINGS_STATE, methods: SIDEBAR_SETTINGS_METHODS } },
});
