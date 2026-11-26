// The objects the page holds about a workspace and what is in it (ERNDL-1141 §6, §8, §9, and the page's additions
// recorded there): the workspace itself (`Workspace`: its info, and every change a workspace tick allows), its lists
// (the caller's roots, its children, what is here, who is here, what the caller may link here), one thing as it is
// available here (`ThingInfo`), who may do what with a thing here (`WhoMay`), and every registered kind as data
// (`ThingKindsView`, slice 1's). Every list is paged and live; a "from" never names a workspace the caller is not present in (item 96).

import {
	arr,
	bool,
	grantable,
	lit,
	MessageSchema,
	map,
	method,
	obj,
	oneOf,
	opt,
	remote,
	Server,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import { Party, Source } from "./contract.ts";

/** Where something comes from, as the caller may see it: here, a workspace above they are present in, or above. */
export const Origin = union([
	obj({ kind: lit("here") }),
	obj({ kind: lit("above"), workspace: str(), name: str() }),
	obj({ kind: lit("aboveUnnamed") }),
]);

/** Where something comes from (see `Origin`). */
export type Origin = Static<typeof Origin>;

/** Which of a kind's default grants a new link writes (item 93): the ticks left ticked for everyone and for agents. */
export const DefaultsChoice = obj({ everyone: arr(str()), agents: arr(str()) });

/** Which of a kind's default grants a new link writes (see `DefaultsChoice`). */
export type DefaultsChoice = Static<typeof DefaultsChoice>;

/** A party as the picker offers it: whom, and their name. */
export const PartyInfo = obj({ party: Party, name: str() });

/** A party as the picker offers it (see `PartyInfo`). */
export type PartyInfo = Static<typeof PartyInfo>;

/** A workspace as its holders see it; `parent` only if the caller is present there (else it is a root for them). */
export const WorkspaceInfo = obj({
	workspace: str(),
	name: str(),
	kind: str(),
	view: opt(str()),
	showsThings: bool(),
	showsPeople: bool(),
	parent: opt(obj({ workspace: str(), name: str() })),
});

/** A workspace as its holders see it (see `WorkspaceInfo`). */
export type WorkspaceInfo = Static<typeof WorkspaceInfo>;

/** How long an invite link lasts and how often it may be used. */
export const InviteUses = oneOf("one", "several");

/**
 * A workspace, held by anyone present there: its info and what the caller may make here (`makes`, from its Make ticks),
 * and every change one of its ticks allows: Make, Link, Hide, Configure, Manage people, Manage access.
 */
export const Workspace = remote("things.workspace", {
	version: 1,
	params: { workspace: str() },
	hostAddress: () => Server(),
	admission: obj({ makes: arr(str()) }),
	state: { info: WorkspaceInfo, makes: grantable(arr(str())) },
	methods: {
		make: grantable(
			method(obj({ kind: str(), name: opt(str()), input: opt(unknown()), defaults: opt(DefaultsChoice) }), str()),
		),
		link: grantable(method(obj({ thing: str(), defaults: opt(DefaultsChoice) }))),
		unlink: grantable(method(obj({ thing: str() }))),
		hide: grantable(method(obj({ thing: str(), shown: bool() }))),
		setShowsThings: grantable(method(obj({ shown: bool() }))),
		configure: grantable(method(obj({ thing: str(), name: opt(str()), view: opt(str()), settings: opt(unknown()) }))),
		picker: grantable(method(obj({ query: str() }), arr(PartyInfo))),
		inviteLink: grantable(
			method(
				obj({
					name: str(),
					as: oneOf("member", "guest"),
					expires: opt(str()),
					uses: opt(InviteUses),
					group: opt(str()),
				}),
				obj({ url: str() }),
			),
		),
		putParty: grantable(method(obj({ party: Party }))),
		removeParty: grantable(method(obj({ party: Party }))),
		makeGroup: grantable(method(obj({ name: str() }), str())),
		hideParty: grantable(method(obj({ party: Party, shown: bool() }))),
		setShowsPeople: grantable(method(obj({ shown: bool() }))),
		/** One checkbox, one grant row (item 112): `gives` true gives, false withholds, absent resets the cell. */
		setTick: grantable(method(obj({ thing: str(), party: Party, tick: str(), gives: opt(bool()) }))),
	},
});

/** The caller's topmost workspaces: those they are present in with none above that they are present in. */
export const Roots = remote("things.roots", {
	version: 1,
	params: { view: str() },
	hostAddress: () => Server(),
	state: { list: obj({ rows: arr(obj({ workspace: str(), kind: str(), name: str() })), moreAfter: bool() }) },
	methods: { more: method() },
});

/** The sub-workspaces of a workspace the caller is present in (sessions among them). */
export const WorkspaceChildren = remote("things.children", {
	version: 1,
	params: { workspace: str(), view: str() },
	hostAddress: () => Server(),
	state: { list: obj({ rows: arr(obj({ workspace: str(), kind: str(), name: str() })), moreAfter: bool() }) },
	methods: { more: method() },
});

/** What is here: things linked here, and things from above with whether a switch hides them here. */
export const WorkspaceContents = remote("things.contents", {
	version: 1,
	params: { workspace: str(), view: str() },
	hostAddress: () => Server(),
	state: {
		list: obj({
			rows: arr(obj({ thing: str(), kind: str(), name: str(), from: Origin, hidden: bool() })),
			moreAfter: bool(),
		}),
	},
	methods: { more: method() },
});

/** Who is here: parties put in here, and those from above with whether a switch hides them here. */
export const WorkspacePeople = remote("things.people", {
	version: 1,
	params: { workspace: str(), view: str() },
	hostAddress: () => Server(),
	state: {
		list: obj({
			rows: arr(obj({ party: Party, name: str(), from: Origin, hidden: bool(), outside: bool() })),
			moreAfter: bool(),
		}),
	},
	methods: { more: method() },
});

/** The things the caller may link here (Link where each is linked now), by a name prefix. */
export const Linkable = remote("things.linkable", {
	version: 1,
	params: { workspace: str(), query: str(), view: str() },
	hostAddress: () => Server(),
	state: {
		list: obj({ rows: arr(obj({ thing: str(), kind: str(), name: str(), from: Origin })), moreAfter: bool() }),
	},
	methods: { more: method() },
});

/** One thing as it is available here: its kind, name, own default view and where it is linked. Admitted by its answer. */
export const ThingInfo = remote("things.thing-info", {
	version: 1,
	params: { workspace: str(), thing: str() },
	hostAddress: () => Server(),
	state: { info: obj({ thing: str(), kind: str(), name: str(), view: opt(str()), from: Origin }) },
});

/**
 * One checkbox (item 112): the rows written here for this party and tick (each giving or withholding, its source,
 * whether the kind's plugin wrote it, and whether it applies), and whether the party has the tick here by any route.
 */
export const Cell = obj({
	here: arr(obj({ gives: bool(), source: Source, kindDefault: bool(), inEffect: bool() })),
	has: bool(),
});

/** One checkbox (see `Cell`). */
export type Cell = Static<typeof Cell>;

/** Whom a tick is for (item 91). */
export const TickFor = oneOf("agents", "people", "all");

/**
 * Who may do what with a thing here: the kind's own ticks, where its grants are written, and per party the `@open`
 * cell and one cell per tick. On a workspace `ticks` also has cells `@make:*` and `@make:<kind>` (item 114).
 */
export const WhoMay = remote("things.who-may", {
	version: 1,
	params: { workspace: str(), thing: str() },
	hostAddress: () => Server(),
	state: {
		table: obj({
			ticks: arr(obj({ name: str(), label: MessageSchema, for: TickFor })),
			linkedIn: Origin,
			rows: arr(obj({ party: Party, name: str(), open: Cell, ticks: map(Cell) })),
		}),
	},
});
