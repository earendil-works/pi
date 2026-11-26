// The things plugin's contracts for server facets only: the store (`ThingsStore`: every table's rows as named
// queries, and every write; trusted server code, it checks no caller), `Gives` (what a workspace gives one caller,
// what every thing's admission derives from), the registry the store hands its access index to admissions through
// (`AccessHandles`), and the kinds' hooks (`ThingHooks`).

import {
	arr,
	bool,
	type Context,
	type Ctx,
	defineRegistry,
	type FollowObserver,
	local,
	map,
	method,
	num,
	obj,
	opt,
	type P3Principal,
	queries,
	type Static,
	str,
	type TableItem,
	unknown,
} from "@earendil-works/p3/v1";
import type { Attachment } from "./access.ts";
import { type Caller, Item, ManagedBy, Party, Source } from "./contract.ts";

/** A thing: its id, kind, name, who made it and when. */
export const ThingRow = obj({
	thing: str(),
	kind: str(),
	name: str(),
	madeBy: Source,
	madeAt: num(),
});

/** A workspace: its id, the workspace above (`""`: none), its two defaults, its path (the root first, itself last). */
export const WorkspaceRow = obj({
	workspace: str(),
	parent: str(),
	showsThings: bool(),
	showsPeople: bool(),
	path: arr(str()),
});

/** A thing linked into a workspace, with its kind. */
export const LinkRow = obj({ workspace: str(), thing: str(), of: str() });

/** A party put into a workspace, and who put it there. */
export const WorkspaceMemberRow = obj({ workspace: str(), party: Party, source: Source });

/** A thing or party from above, shown or hidden in a workspace by hand. */
export const SwitchRow = obj({ workspace: str(), item: Item, shown: bool() });

/**
 * One source's grant on a thing for a party, written in a workspace: whether it gives (perhaps no tick), the ticks it
 * gives, the ticks it takes from what comes from above, the thing's kind and the kind's version they were written at.
 */
export const GrantRow = obj({
	workspace: str(),
	thing: str(),
	kind: str(),
	version: num(),
	party: Party,
	source: Source,
	gives: bool(),
	ticks: arr(str()),
	takenAway: arr(str()),
});

/** A grant as a source writes it: `gives: false` with no take-away removes the source's grant. */
export const GrantInput = obj({
	workspace: str(),
	thing: str(),
	party: Party,
	gives: bool(),
	ticks: arr(str()),
	takenAway: arr(str()),
});

/** A grant as a source writes it (see `GrantInput`). */
export type GrantInput = Static<typeof GrantInput>;

/** A person: their id, name, whether they have the owner flag, and who made them. */
export const PersonRow = obj({ person: str(), name: str(), owner: bool(), madeBy: Source });

/** A group: its id, name, who changes its members, and whether it is outside (its members never count as everyone). */
export const GroupRow = obj({ group: str(), name: str(), managedBy: ManagedBy, outside: bool() });

/** A party with the group's own tick (it changes the members). */
export const GroupManagerRow = obj({ group: str(), party: Party });

/** A person in a group, as one source put them there, with whether the group is outside. */
export const GroupMemberRow = obj({ group: str(), person: str(), source: Source, outside: bool() });

/** The things plugin's store: every table's rows as named queries (each a key or index search), and every write. */
export const ThingsStore = local("things.store", {
	version: 1,
	params: {},
	members: {
		things: queries(ThingRow, {
			one: obj({ thing: str() }),
			ofIds: obj({ things: arr(str()) }),
			madeBy: obj({ sourceKey: str() }),
			ofKind: obj({ kind: str() }),
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
			ofParties: obj({ workspaces: arr(str()), partyKeys: arr(str()) }),
		}),
		switches: queries(SwitchRow, {
			here: obj({ workspace: str() }),
			ofItems: obj({ workspaces: arr(str()), itemKeys: arr(str()) }),
		}),
		grants: queries(GrantRow, {
			here: obj({ workspace: str() }),
			of: obj({ workspace: str(), thing: str() }),
			ofParty: obj({ partyKey: str() }),
			ofThing: obj({ thing: str() }),
		}),
		persons: queries(PersonRow, {
			one: obj({ person: str() }),
			ofIds: obj({ persons: arr(str()) }),
			owners: obj({}),
		}),
		groups: queries(GroupRow, { one: obj({ group: str() }), ofIds: obj({ groups: arr(str()) }) }),
		groupManagers: queries(GroupManagerRow, { of: obj({ group: str() }) }),
		groupMembers: queries(GroupMemberRow, { ofPerson: obj({ person: str() }), ofGroup: obj({ group: str() }) }),
		/**
		 * Makes a thing of `kind` in `workspace`, in one commit: the thing, its link, the kind's default grants, and every
		 * tick for its maker (`by`, a person or a session's agent; item 90); then the kind's `create` hook. Answers its id.
		 */
		create: method(obj({ kind: str(), name: str(), workspace: str(), by: Source, input: opt(unknown()) }), str()),
		/** Plugin `plugin`'s one thing of `kind`, made in `workspace` by the first call; answers its id. */
		ensure: method(obj({ kind: str(), name: str(), workspace: str(), plugin: str() }), str()),
		/** Links a thing into a workspace, with its kind's default grants there. */
		link: method(obj({ workspace: str(), thing: str(), by: Source })),
		/** Unlinks a thing and what the workspace wrote for it (R15); with its last link the thing goes. */
		unlink: method(obj({ workspace: str(), thing: str() })),
		rename: method(obj({ thing: str(), name: str() })),
		/** Makes a workspace of `kind` under `parent`; answers its id. */
		createWorkspace: method(
			obj({ kind: str(), name: str(), parent: str(), by: Source, showsPeople: opt(bool()) }),
			str(),
		),
		/** Shows or hides a thing or party from above; `shown` left out removes the switch (the default decides). */
		setSwitch: method(obj({ workspace: str(), item: Item, shown: opt(bool()) })),
		setDefaults: method(obj({ workspace: str(), showsThings: opt(bool()), showsPeople: opt(bool()) })),
		/** Writes `source`'s grants (a source rewrites only its own): a giving one only where the thing is linked. */
		setGrants: method(obj({ source: Source, grants: arr(GrantInput) })),
		putParty: method(obj({ workspace: str(), party: Party, source: Source })),
		removeParty: method(obj({ workspace: str(), party: Party })),
		createPerson: method(obj({ name: str(), madeBy: Source }), str()),
		/** Gives or takes the owner flag; refuses taking it from the last owner. */
		setOwner: method(obj({ person: str(), owner: bool() })),
		makeGroup: method(obj({ name: str(), managedBy: ManagedBy, outside: bool() }), str()),
		addToGroup: method(obj({ group: str(), person: str(), source: Source })),
		removeFromGroup: method(obj({ group: str(), person: str(), source: Source })),
		setGroupManagers: method(obj({ group: str(), parties: arr(Party) })),
		/** Removes what `source` wrote (grants, group members, workspace members) and the groups it manages, with all naming them. */
		deleteEverythingFrom: method(obj({ source: Source })),
	},
});

/** What a caller gets for one thing: its ticks (perhaps none: here without ticks, R10). */
export const Answer = obj({ ticks: arr(str()) });

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
};

/**
 * How admissions reach the index: the store's object contributes its handle while it lives (R5, decision 84), so a
 * reloaded store's index replaces the old one and nothing is module state. Composed: the one contribution.
 */
export const AccessHandles = defineRegistry<AccessHandle, AccessHandle | undefined>("things.access", { version: 1 });

/** A kind's hooks on the server: what is in a new thing (`create`), and clearing it when it goes (`delete`). */
export type ThingHook = {
	readonly kind: string;
	/** Prepares what is in a new thing from `input`; a throw deletes the thing again. */
	readonly create?: (thing: string, input: unknown, ctx: Ctx<P3Principal>) => Promise<void>;
	/** Clears what is in a deleted thing; retried at the next start while it fails. */
	readonly delete?: (thing: string, ctx: Ctx<P3Principal>) => Promise<void>;
};

/** The kinds' hooks, by kind name (the first by plugin name wins a kind). */
export const ThingHooks = defineRegistry<ThingHook, ReadonlyMap<string, TableItem<ThingHook>>>("things.hooks", {
	version: 1,
});
