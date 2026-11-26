// The things plugin's contracts for server facets only: the store (`ThingsStore`: every table's rows as named
// queries, and every write; trusted server code, it checks no caller), `Gives` (what a workspace gives one caller,
// what every thing's admission derives from), the registry the store hands its access index to admissions through
// (`AccessHandles`), the kinds' hooks (`ThingHooks`), a kind's seeded thing (`OneThing`), and for kinds whose calls or
// streams name another thing, what a workspace gives a caller (`givesTo`) and a stream's hold on it (`abortWhen`).

import {
	arr,
	bool,
	type Context,
	type Ctx,
	constant,
	defineRegistry,
	type FollowObserver,
	local,
	map,
	method,
	type NativeWatchable,
	num,
	obj,
	opt,
	type P3Principal,
	queries,
	type Self,
	type Static,
	str,
	type TableItem,
	unknown,
	until,
	type Watchable,
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

/** A workspace: its id, the workspace above (`""`: none), and its two defaults. */
export const WorkspaceRow = obj({ workspace: str(), parent: str(), showsThings: bool(), showsPeople: bool() });

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

/** A person in a group, as one source put them there, with whether the group is outside. */
export const GroupMemberRow = obj({ group: str(), person: str(), source: Source, outside: bool() });

/** The things plugin's store: every table's rows as named queries (each a key or index search), and every write. */
export const ThingsStore = local("things.store", {
	version: 1,
	params: {},
	members: {
		things: queries(ThingRow, { one: obj({ thing: str() }), ofMaker: obj({ sourceKey: str(), kind: str() }) }),
		workspaces: queries(WorkspaceRow, { one: obj({ workspace: str() }), children: obj({ parent: str() }) }),
		links: queries(LinkRow, { here: obj({ workspace: str() }) }),
		workspaceMembers: queries(WorkspaceMemberRow, { here: obj({ workspace: str() }) }),
		switches: queries(SwitchRow, { here: obj({ workspace: str() }) }),
		grants: queries(GrantRow, { here: obj({ workspace: str() }) }),
		// `ofIds`: the persons of a list in one read (the notes plugin reads its notes' authors' names with it).
		persons: queries(PersonRow, { one: obj({ person: str() }), ofIds: obj({ persons: arr(str()) }) }),
		groupMembers: queries(GroupMemberRow, { ofPerson: obj({ person: str() }) }),
		/**
		 * Makes a thing of `kind` in `workspace`: the kind's `create` hook first, with the new id (item 34), then one
		 * commit: the thing, its link, the kind's default grants, and every tick for its maker (`by`, a person or a
		 * session's agent; item 90). `input` is checked against the kind's `create.input` before the hook runs (left
		 * out too: a kind with a schema always gets a valid input, a kind without one takes none). Answers its id.
		 */
		create: method(obj({ kind: str(), name: str(), workspace: str(), by: Source, input: opt(unknown()) }), str()),
		/**
		 * Kind `kind`'s seeded thing (`serveThing`'s `one`, made at the start): the one its plugin made, else one made
		 * in Pi through the create path (the kind's hook first, as `create`, by the plugin). Answers its id; `invalid`
		 * for a kind that asks for none.
		 */
		ensure: method(obj({ kind: str() }), str()),
		/** Links a thing into a workspace, with its kind's default grants there. */
		link: method(obj({ workspace: str(), thing: str() })),
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
		/**
		 * Writes `source`'s grant rows (a source rewrites only its own), all or none: a giving one only where the thing
		 * is linked, a tick only to whom it is for.
		 */
		setGrants: method(obj({ source: Source, grants: arr(GrantInput) })),
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
	},
});

/**
 * What a caller gets for one thing: its ticks (perhaps none: here without ticks, R10), the thing's kind and the ticks
 * version they were read at.
 */
export const Answer = obj({ kind: str(), ticksVersion: num(), ticks: arr(str()) });

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
 * What `workspace` gives `caller`, live, for a kind's object whose calls name another thing (Files and Terminals: a
 * machine). The server (trusted code) is no party anywhere: nothing.
 */
export function givesTo(
	self: Self<P3Principal>,
	workspace: string,
	caller: Caller,
): Watchable<Readonly<Record<string, Static<typeof Answer>>>> {
	if (caller.kind === "server") return constant({});
	const key = caller.kind === "person" ? `person:${caller.person}` : `worker:${caller.session}`;
	return self.get(Gives, { workspace, caller: key }).answers;
}

/**
 * Aborts `controller` once `lost` holds for `source`'s value (the current one included) or its watch ends, unless
 * `context` aborts first: how a kind's stream (a download, a terminal's bytes) holds what lets its caller in
 * (decision 25) and ends the moment that goes.
 */
export function abortWhen<T>(
	source: NativeWatchable<T>,
	lost: (value: T) => boolean,
	controller: AbortController,
	context: Context,
): void {
	const end = () => controller.abort();
	void until(source, lost, context).then(end, end);
}

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

/**
 * A kind's hooks on the server: what is in a new thing (`create`), its settings changed (`configure`), clearing it
 * when it goes (`delete`); and the plugin's one thing in Pi it asks for (`one`, `serveThing`'s).
 */
export type ThingHook = {
	readonly kind: string;
	/**
	 * Prepares what is in a new thing from `input`, made by `by`, before the commit that makes it (item 34): a throw
	 * makes nothing (a kind refuses there what its maker may not use, as a login another person's sign-in).
	 */
	readonly create?: (thing: string, input: unknown, by: Source, ctx: Ctx<P3Principal>) => Promise<void>;
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
	 * The plugin's seeded thing of the kind, named `name`: made in Pi once the kind is registered, and again at once
	 * when it is deleted (`ensure`, `OneThing`).
	 */
	readonly one?: { readonly name: string };
};

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
