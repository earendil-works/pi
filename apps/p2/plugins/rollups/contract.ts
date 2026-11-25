// Rollups made from code: a saved script over every session that returns a sidebar section (a flat list of sessions,
// groups of sessions, or only a link to its list), refreshed automatically, on an interval or by hand. The sidebar
// applies the rollup's window to what the script returned, as it does for the built-in rollups.
import { arr, bool, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, remote, serverHost } from "@p2/app/v1";

/**
 * A session a rollup collected: its ID, or its ID with `at`, the time its window compares and its list sorts by
 * (default the session's last activity), and `keep`, shown whatever its time (as a pinned session).
 */
export const MemberSchema = union([
	str({ minLength: 1, maxLength: 200 }),
	obj({ id: str({ minLength: 1, maxLength: 200 }), at: opt(num()), keep: opt(bool()) }),
]);
export type Member = Static<typeof MemberSchema>;

const Members = arr(MemberSchema, { maxItems: 5000 });

/** Where a group's "+" starts a session: in a folder (env null: this device), or in a project by its name. */
export const RollupTargetSchema = union([
	obj({ kind: literal("folder"), env: union([str(), nul()]), cwd: str({ minLength: 1 }) }),
	obj({ kind: literal("project"), project: str({ minLength: 1 }) }),
]);
export type RollupTarget = Static<typeof RollupTargetSchema>;

/** A group a rollup returned; `keep`: shown even without a session in its window. */
export const RollupGroupSchema = obj({
	key: str({ minLength: 1, maxLength: 200 }),
	name: str({ minLength: 1, maxLength: 120 }),
	title: opt(str({ maxLength: 500 })),
	keep: opt(bool()),
	target: opt(RollupTargetSchema),
	members: Members,
});
export type RollupGroup = Static<typeof RollupGroupSchema>;

/** What a rollup's script returns: a flat list of sessions, groups of sessions, or sessions shown only in its list. */
export const RollupOutputSchema = union([
	obj({ layout: literal("sessions"), members: Members }),
	obj({ layout: literal("groups"), groups: arr(RollupGroupSchema, { maxItems: 500 }) }),
	obj({ layout: literal("link"), members: Members }),
]);
export type RollupOutput = Static<typeof RollupOutputSchema>;

/**
 * A rollup's window: one the owner may change in its options (the sidebar's windows, `SidebarWindowSchema`; spelled out
 * because another plugin's contract copied into the Familiar's worker may import only the API), or `none`: every
 * session it returned shows.
 */
export const RollupWindowSchema = union([
	literal("1d"),
	literal("3d"),
	literal("1w"),
	literal("forever"),
	literal("none"),
]);
export type RollupWindow = Static<typeof RollupWindowSchema>;

/**
 * When a rollup's script runs again: `auto` when what it read of the sessions changed (no tools), `every` so many
 * minutes when that changed, `manual` only by hand. Every one can be refreshed by hand as well.
 */
export const RefreshSchema = union([
	obj({ kind: literal("auto") }),
	obj({ kind: literal("every"), minutes: int({ minimum: 1, maximum: 1440 }) }),
	obj({ kind: literal("manual") }),
]);
export type Refresh = Static<typeof RefreshSchema>;

/** A rollup key: lowercase, digits and dashes; its sidebar key is `rollup:<key>`. */
export const RollupKeySchema = str({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" });

/** A rollup as saved: its key, its name in the sidebar, its window, when it refreshes, and its script. */
export const RollupDefinitionSchema = obj({
	key: RollupKeySchema,
	name: str({ minLength: 1, maxLength: 60 }),
	window: RollupWindowSchema,
	refresh: RefreshSchema,
	code: str({ minLength: 1, maxLength: 100_000 }),
});
export type RollupDefinition = Static<typeof RollupDefinitionSchema>;

/**
 * A saved rollup and its last result: `output` (null before its first good run; a failed run keeps the last good one),
 * `checkedAt` (when the output was last confirmed current: a run, or a check that found what it read unchanged),
 * `error` (why the last run failed), `reads` (what the last run read: `sessions.cwd`, `projects`, `now`; a failed run
 * counts as having read every session field and the projects) and `fingerprint` (of those values then).
 */
export const RollupEntrySchema = obj({
	definition: RollupDefinitionSchema,
	output: union([RollupOutputSchema, nul()]),
	checkedAt: union([num(), nul()]),
	error: union([str(), nul()]),
	reads: arr(str()),
	fingerprint: union([str(), nul()]),
});
export type RollupEntry = Static<typeof RollupEntrySchema>;

/** A trial run of a script against the sessions now: its output and what it read, or why it failed. */
export const PreviewSchema = union([
	obj({ ok: literal(true), output: RollupOutputSchema, reads: arr(str()) }),
	obj({ ok: literal(false), error: str() }),
]);
export type Preview = Static<typeof PreviewSchema>;

/** A session as a rollup's script sees it (`sessions`): the catalog row with its project, worker state and unread. */
export const RollupSessionSchema = obj({
	id: str(),
	title: str(),
	env: union([str(), nul()]),
	cwd: str(),
	createdAt: num(),
	updatedAt: num(),
	archivedAt: union([num(), nul()]),
	pinned: bool(),
	/** `provider/modelId`. */
	model: str(),
	project: union([str(), nul()]),
	state: union([literal("stopped"), literal("idle"), literal("working")]),
	error: union([str(), nul()]),
	unread: bool(),
});
export type RollupSession = Static<typeof RollupSessionSchema>;

const Key = obj({ key: RollupKeySchema });
const ROLLUP_METHODS = {
	/** Saves a rollup (a new one, or one of the same key replaced) and runs it once. */
	save: method(RollupDefinitionSchema, RollupEntrySchema),
	remove: method(Key),
	/** Runs a rollup now, whether or not what it read changed. */
	refresh: method(Key, RollupEntrySchema),
	/** Runs a script against the sessions now without saving it. */
	preview: method(obj({ code: str({ minLength: 1, maxLength: 100_000 }) }), PreviewSchema),
};

/** The saved rollups (server, host-internal, persisted in the server's store) and running them. */
export const RollupStore = local("p2.rollup-store", {
	version: 1,
	params: {},
	members: { rollups: arr(RollupEntrySchema), ...ROLLUP_METHODS },
});

/** The Familiar's tool for rollups (worker.ts), named in its tool lists. */
export const ROLLUPS_TOOL = "sidebar_rollups";

/** The rollups for the owner's sidebar, and for the Familiar's `sidebar_rollups` tool (its worker only). */
export const SidebarRollups = remote("p2.sidebar-rollups", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: { state: { rollups: arr(RollupEntrySchema) }, methods: ROLLUP_METHODS },
		familiar: { methods: { list: method(undefined, arr(RollupEntrySchema)), ...ROLLUP_METHODS } },
	},
});
