// The things plugin's contracts for server facets only: the store (`ThingsStore`: every table's rows as named
// queries, and every write; trusted server code, it checks no caller), `Gives` (what a workspace gives one caller,
// what every thing's admission derives from), the registry the store hands its access index to admissions through
// (`AccessHandles`), the kinds' hooks (`ThingHooks`), and a kind's seeded thing (`OneThing`).

import {
	arr,
	bool,
	type Context,
	type Ctx,
	defineRegistry,
	type FollowObserver,
	int,
	local,
	map,
	method,
	nul,
	num,
	obj,
	opt,
	type P3Principal,
	queries,
	type Static,
	str,
	type TableItem,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import type { Attachment, Probe, ProbeAttachment } from "./access.ts";
import { type Caller, Item, ManagedBy, Party, Source } from "./contract.ts";
import type { DefaultGrants } from "./kind.ts";
import type { Answer as Answered } from "./rules.ts";
import { DefaultsChoice } from "./workspace.ts";

/** A thing: its id, kind, name, its own default view (`""`: none, item 74), who made it and when. */
export const ThingRow = obj({
	thing: str(),
	kind: str(),
	name: str(),
	view: str(),
	madeBy: Source,
	madeAt: num(),
});

/**
 * A workspace: its id, its kind and name (its thing's), the workspace above (`""`: none), its two defaults, and its
 * path from the root (itself last), also as text (`pathText`: each id followed by `/`), for prefix reads of a subtree.
 */
export const WorkspaceRow = obj({
	workspace: str(),
	kind: str(),
	name: str(),
	parent: str(),
	showsThings: bool(),
	showsPeople: bool(),
	path: arr(str()),
	pathText: str(),
});

/** A workspace (see `WorkspaceRow`). */
export type WorkspaceRow = Static<typeof WorkspaceRow>;

/** A thing linked into a workspace, with its kind. */
export const LinkRow = obj({ workspace: str(), thing: str(), of: str() });

/** A party put into a workspace, and who put it there. */
export const WorkspaceMemberRow = obj({ workspace: str(), party: Party, source: Source });

/** A thing or party from above, shown or hidden in a workspace by hand. */
export const SwitchRow = obj({ workspace: str(), item: Item, shown: bool() });

/**
 * One row of a grant (item 112): one source's tick on a thing for a party, written in a workspace, given or withheld,
 * with the thing's kind and the kind's ticks version it was written at. `tick` is a tick of the kind or `OPEN`.
 */
export const GrantRow = obj({
	workspace: str(),
	thing: str(),
	kind: str(),
	ticksVersion: num(),
	party: Party,
	source: Source,
	tick: str(),
	gives: bool(),
});

/**
 * One row of a grant as a source writes it: `gives` the tick (where the thing is linked), withholds it (`false`: there
 * and below, by every route for a person), or, left out, removes the source's row.
 */
export const GrantInput = obj({
	workspace: str(),
	thing: str(),
	party: Party,
	tick: str(),
	gives: opt(bool()),
});

/** One row of a grant as a source writes it (see `GrantInput`). */
export type GrantInput = Static<typeof GrantInput>;

/** A person: their id, name, whether they have the owner flag, and who made them. */
export const PersonRow = obj({ person: str(), name: str(), owner: bool(), madeBy: Source });

/** A group: its id, name, and whether it is outside (its members never count as everyone here). */
export const GroupRow = obj({ group: str(), name: str(), outside: bool() });

/** A person in a group, as one source put them there, with whether the group is outside. */
export const GroupMemberRow = obj({ group: str(), person: str(), source: Source, outside: bool() });

/**
 * What a caller gets for one thing: its ticks (perhaps none: here without ticks, R10; never a reserved tick), the
 * thing's kind and the ticks version they were read at; on a workspace's own thing also the kinds they may make there
 * (item 114) and the workspaces above it they are present in (item 96).
 */
export const Answer = obj({
	kind: str(),
	ticksVersion: num(),
	ticks: arr(str()),
	depth: int(),
	makes: opt(arr(str())),
	above: opt(arr(str())),
});

/** The things plugin's store: every table's rows as named queries (each a key or index search), and every write. */
export const ThingsStore = local("things.store", {
	version: 1,
	params: {},
	members: {
		things: queries(ThingRow, {
			one: obj({ thing: str() }),
			ofIds: obj({ things: arr(str()) }),
			ofMaker: obj({ sourceKey: str(), kind: str() }),
		}),
		workspaces: queries(WorkspaceRow, {
			one: obj({ workspace: str() }),
			children: obj({ parent: str() }),
			under: obj({ pathPrefix: str() }),
		}),
		links: queries(LinkRow, { here: obj({ workspace: str() }), where: obj({ thing: str() }) }),
		workspaceMembers: queries(WorkspaceMemberRow, {
			here: obj({ workspace: str() }),
			where: obj({ partyKey: str() }),
		}),
		switches: queries(SwitchRow, { here: obj({ workspace: str() }) }),
		grants: queries(GrantRow, { here: obj({ workspace: str() }) }),
		// `ofIds`: the persons of a list in one read (the notes plugin reads its notes' authors' names with it).
		persons: queries(PersonRow, { one: obj({ person: str() }), ofIds: obj({ persons: arr(str()) }) }),
		groupMembers: queries(GroupMemberRow, { ofPerson: obj({ person: str() }) }),
		groups: queries(GroupRow, { ofIds: obj({ groups: arr(str()) }) }),
		/**
		 * Makes a thing of `kind` in `workspace`: the kind's `create` hook first, with the new id (item 34), then one
		 * commit: the thing, its link, the kind's default grants, and every tick for its maker (`by`, a person or a
		 * session's agent; item 90). `input` is checked against the kind's `create.input` before the hook runs (left
		 * out too: a kind with a schema always gets a valid input, a kind without one takes none). Answers its id.
		 */
		create: method(
			obj({
				kind: str(),
				name: str(),
				workspace: str(),
				by: Source,
				input: opt(unknown()),
				defaults: opt(DefaultsChoice),
			}),
			str(),
		),
		/**
		 * Kind `kind`'s seeded thing (`serveThing`'s `one`, made at the start): the one its plugin made, else one made
		 * in Pi through the create path (the kind's hook first, as `create`, by the plugin). Answers its id; `invalid`
		 * for a kind that asks for none.
		 */
		ensure: method(obj({ kind: str() }), str()),
		/**
		 * Links a thing into a workspace, with its kind's default grants there (`defaults`: those left ticked, item 93; a
		 * workspace is placed by its parent, never linked).
		 */
		link: method(obj({ workspace: str(), thing: str(), defaults: opt(DefaultsChoice) })),
		/** Unlinks a thing and what the workspace wrote for it (R15); with its last link the thing goes. */
		unlink: method(obj({ workspace: str(), thing: str() })),
		rename: method(obj({ thing: str(), name: str() })),
		/**
		 * Renames a thing, sets its own default view (`""`: the kind's), and sets some of its kind's settings through
		 * its `configure` hook, each checked against its state member's schema (item 86).
		 */
		configure: method(obj({ thing: str(), name: opt(str()), view: opt(str()), settings: opt(unknown()) })),
		/**
		 * Makes a workspace of workspace kind `kind` under `parent` (never under a leaf): the kind's `create` hook first,
		 * which may answer other default grants and its people default, then one commit: its thing and line, its maker's
		 * every tick and `MAKE_ANY` at itself and the maker put in (items 88, 90, 115), a leaf's agent put in, the
		 * kind's default grants at itself. Answers its id.
		 */
		createWorkspace: method(
			obj({
				kind: str(),
				name: str(),
				parent: str(),
				by: Source,
				showsPeople: opt(bool()),
				input: opt(unknown()),
				defaults: opt(DefaultsChoice),
			}),
			str(),
		),
		/**
		 * Removes workspace `workspace` and everything below it: its line goes in one commit (the subtree gives nothing
		 * from then on), the rest in background commits, one workspace each (links, grants, switches, members; things
		 * linked nowhere else go with their delete hooks); each workspace's kinds are told (`workspaceGone`). Pi stays.
		 */
		removeWorkspace: method(obj({ workspace: str() })),
		/**
		 * Tells every kind that workspace `workspace` is gone though it stays (a session archived): their
		 * `workspaceGone` hooks run, durably, as after a removal.
		 */
		workspaceGone: method(obj({ workspace: str() })),
		/** Shows or hides a thing or party from above; `shown` left out removes the switch (the default decides). */
		setSwitch: method(obj({ workspace: str(), item: Item, shown: opt(bool()) })),
		setDefaults: method(obj({ workspace: str(), showsThings: opt(bool()), showsPeople: opt(bool()) })),
		/**
		 * Writes `source`'s grant rows (a source rewrites only its own), all or none: a giving one only where the thing
		 * is linked, a tick only to whom it is for.
		 */
		setGrants: method(obj({ source: Source, grants: arr(GrantInput) })),
		/**
		 * One checkbox (item 112): every row of `party`'s `tick` on `thing` written in `workspace`, whatever its source,
		 * is replaced by one row of `source` (`gives` true or false), or none (`gives` left out: reset).
		 */
		setTick: method(
			obj({ workspace: str(), thing: str(), party: Party, tick: str(), gives: opt(bool()), source: Source }),
		),
		putParty: method(obj({ workspace: str(), party: Party, source: Source })),
		removeParty: method(obj({ workspace: str(), party: Party })),
		createPerson: method(obj({ name: str(), madeBy: Source }), str()),
		/** Gives or takes the owner flag; refuses taking it from the last owner. */
		setOwner: method(obj({ person: str(), owner: bool() })),
		makeGroup: method(obj({ name: str(), managedBy: ManagedBy, outside: bool() }), str()),
		addToGroup: method(obj({ group: str(), person: str(), source: Source })),
		removeFromGroup: method(obj({ group: str(), person: str(), source: Source })),
		/**
		 * Removes what `source` wrote (grants, group members, workspace members) and the groups it manages, with all
		 * naming them.
		 */
		deleteEverythingFrom: method(obj({ source: Source })),
		/**
		 * The answer `caller` (a `callerKey`) gets for `thing` in `workspace` now, as admission computes it (R41;
		 * `null`: nothing): for a kind's method that names another thing. Not live.
		 */
		answerOf: method(obj({ workspace: str(), thing: str(), caller: str() }), union([Answer, nul()])),
	},
});

/**
 * What a workspace gives one caller (`callerKey` of their principal): each thing they get anything for, by id. One
 * per caller and workspace, following the store's access index; no live query. Server code only: nobody outside
 * names a caller.
 */
export const Gives = local("things.gives", {
	version: 1,
	params: { workspace: str(), caller: str() },
	members: { answers: map(Answer) },
});

/**
 * What the store's object hands admissions: attaching to its index (`Gives` follows it with `self.follow`; `undefined`
 * once the store object ended), and whether it is still the store's.
 */
export type AccessHandle = {
	readonly open: boolean;
	attach(
		workspace: string,
		caller: Caller,
		observer: FollowObserver<unknown>,
		context: Context,
	): Promise<Attachment | undefined>;
	/** Attaches `observer` to a probe over the index (a list's rows, live); `undefined` once the index closed. */
	probe<T>(
		probe: Probe<T>,
		observer: FollowObserver<unknown>,
		context: Context,
	): Promise<ProbeAttachment<T> | undefined>;
	/** The answer `caller` gets for `thing` in `workspace` now (`undefined`: nothing, or the store ended). Not live. */
	answer(workspace: string, thing: string, caller: Caller, context: Context): Promise<Answered | undefined>;
};

/**
 * How admissions reach the index: the store's object contributes its handle while it lives (R5, decision 84), so a
 * reloaded store's index replaces the old one and nothing is module state. Composed: the one contribution.
 */
export const AccessHandles = defineRegistry<AccessHandle, AccessHandle | undefined>("things.access", { version: 1 });

/**
 * A kind's hooks on the server: what is in a new thing (`create`), its settings changed (`configure`), clearing it
 * when it goes (`delete`); and the plugin's one thing in Pi it asks for (`one`, `serveThing`'s).
 */
export type ThingHook = {
	readonly kind: string;
	/**
	 * Prepares what is in a new thing from `input`, made by `by` in `workspace` (for a workspace kind: its parent),
	 * before the commit that makes it (item 34): a throw makes nothing (a kind refuses there what its maker may not
	 * use, as a login another person's sign-in). It may answer the new thing's own default view and, for a workspace
	 * kind, its default grants and people default (`CreateAnswer`).
	 */
	readonly create?: (made: Made<unknown>, ctx: Ctx<P3Principal>) => Promise<CreateAnswer | undefined>;
	/**
	 * Sets `settings`, some of the kind's settings (`KindInfo.settings`: state members), on `thing`;
	 * `Workspace.configure` calls it (slice 2) with values checked against their state members' schemas.
	 */
	readonly configure?: (
		thing: string,
		settings: Readonly<Record<string, unknown>>,
		ctx: Ctx<P3Principal>,
	) => Promise<void>;
	/**
	 * Clears what is in a deleted thing, or in one whose commit failed after `create`; for a deleted thing tried again,
	 * with backoff and at every start, until it succeeds.
	 */
	readonly delete?: (thing: string, ctx: Ctx<P3Principal>) => Promise<void>;
	/**
	 * Clears what the kind keeps for workspace `workspace` (a session's terminals), which is gone: removed, or a session
	 * archived. Called once per workspace after the commit that removed it, tried again with backoff and at every
	 * start until it succeeds; may run again after a crash (it must be safe to repeat).
	 */
	readonly workspaceGone?: (workspace: string, ctx: Ctx<P3Principal>) => Promise<void>;
	/**
	 * The plugin's seeded thing of the kind, named `name`: made in Pi once the kind is registered, and again at once
	 * when it is deleted (`ensure`, `OneThing`).
	 */
	readonly one?: { readonly name: string };
};

/**
 * What a kind's `create` hook may answer: the new thing's own default view; for a workspace kind also the new
 * workspace's default grants instead of the kind's (a private session, decisions 17, 93; the person's `defaults`
 * choice applies within them), and whether people from above are shown in it.
 */
export type CreateAnswer = {
	readonly defaultGrants?: DefaultGrants;
	readonly showsPeople?: boolean;
	/** The new thing's own default view (item 74; `ThingRow.view`), written in the commit that makes it. */
	readonly view?: string;
};

/**
 * What a kind's `create` hook is told about a new thing: its id, its input (checked against the kind's `create.input`),
 * who makes it, and the workspace it is made in (for a workspace kind: its parent).
 */
export type Made<I> = { readonly thing: string; readonly input: I; readonly by: Source; readonly workspace: string };

/** The kinds' hooks, by kind name (the first by plugin name wins a kind). */
export const ThingHooks = defineRegistry<ThingHook, ReadonlyMap<string, TableItem<ThingHook>>>("things.hooks", {
	version: 1,
});

/**
 * The seeded thing of a kind (`serveThing`'s `one`) for server code of any plugin: `thing` its id, live (the session's
 * default location is the machine's). It is the plugin's replaceable singleton: deleted (its last link gone), it is
 * made again in Pi at once and `thing` names the new one (`""` meanwhile); unlinked from Pi but linked elsewhere, it
 * stays. Its plugin makes no other thing of the kind.
 */
export const OneThing = local("things.one", {
	version: 1,
	params: { kind: str() },
	members: { thing: str() },
});
