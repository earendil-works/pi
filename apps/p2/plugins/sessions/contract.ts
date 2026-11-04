import { arr, bool, int, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import type { Ctx } from "@p2/app/v1";
import {
	keyedRegistry,
	local,
	ModelRefSchema,
	method,
	param,
	remote,
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
export const SessionSchema = obj({
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
});
export type Session = Static<typeof SessionSchema>;

/** Cleanup completed before an archive call returns (e.g. session-owned port forwards). */
export const SessionArchived = keyedRegistry<(session: string, ctx: Ctx) => Promise<void>>("p2.session-archived");

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

/** The session catalog (server, SQLite): every session, archived ones included. Host-internal. */
export const Catalog = local("p2.catalog", {
	/** 2: thinking levels are an enum. */
	version: 2,
	params: {},
	members: {
		sessions: arr(SessionSchema),
		get: method(Id, SessionSchema),
		create: method(
			obj({
				/** A chosen ID (a clone's or fork's, whose files exist before its entry); default a new one. */
				id: opt(str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" })),
				env: opt(union([str(), nul()])),
				cwd: str(),
				title: str(),
				/** The title was given, not the placeholder: automatic titles never replace it. */
				titleEdited: opt(bool()),
				model: ModelRefSchema,
				thinkingLevel: ThinkingLevelSchema,
			}),
			SessionSchema,
		),
		/** Applies indexed activity without replacing an explicit title or moving time backwards. */
		activity: method(obj({ id: str(), timestamp: num(), firstUserText: opt(str()) })),
		update: method(
			obj({
				id: str(),
				cwd: opt(str()),
				env: opt(union([str(), nul()])),
				title: opt(str()),
				pinned: opt(bool()),
				archived: opt(bool()),
				model: opt(ModelRefSchema),
				thinkingLevel: opt(ThinkingLevelSchema),
			}),
			SessionSchema,
		),
	},
});

/**
 * Sessions as a principal sees them. The owner lists and manages all; a guest sees its own session; a worker sees
 * and renames only its own session (its principal names it).
 */
export const Sessions = remote("p2.sessions", {
	/**
	 * 2: thinking levels are an enum; configureSelf takes either field alone.
	 * 3: `clone` and `fork` (owner).
	 */
	version: 3,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				sessions: arr(SessionSchema),
				/** Working directory suggested for a new session: the most recently active one, or the home directory. */
				defaultCwd: str(),
				defaultEnv: union([str(), nul()]),
			},
			methods: {
				create: method(CreateSchema, SessionSchema),
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
				clone: method(Id, SessionSchema),
				/**
				 * A new session holding the active context of `conversation` before the entry `before` (pi's `/fork` from a
				 * user message: that message is not part of it). Only the main conversation (1) for now.
				 */
				fork: method(
					obj({
						id: str(),
						conversation: int({ minimum: 1 }),
						before: int({ minimum: 1 }),
					}),
					SessionSchema,
				),
			},
		},
		/** A guest sees its one session while it is not archived. */
		guest: {
			state: { sessions: arr(SessionSchema) },
		},
		worker: {
			state: { session: union([SessionSchema, nul()]) },
			methods: {
				renameSelf: method(obj({ title: Title }), obj({ previous: str() })),
				/** The root conversation's configuration changed (either field alone): the catalog entry follows. */
				configureSelf: method(obj({ model: opt(ModelRefSchema), thinkingLevel: opt(ThinkingLevelSchema) })),
			},
		},
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
 * entry drafts, and seeding a new session's main conversation with them before anyone sends to it.
 */
export const SessionTransfer = remote("p2.session-transfer", {
	version: 2,
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
			},
		},
	},
});
