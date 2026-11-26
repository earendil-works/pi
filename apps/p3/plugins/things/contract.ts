// The things plugin's contract data every kind imports: the typed values its tables hold (who wrote something, whom a
// grant names, what a switch is about, who manages a group), the one function per value that makes its key column,
// and who calls a thing's object, as its admission hands the factory. A thing's own contract comes from `defineThing`
// (`kind.ts`); the store and the admission's objects are server only (`contract.server.ts`). And a group's object
// (`Group`): its members and the calls its own tick gives.

import { arr, bool, grantable, lit, method, obj, remote, Server, type Static, str, union } from "@earendil-works/p3/v1";

/** The prefix of the reserved tick names (item 113): a kind's own tick names cannot start with it. */
export const RESERVED = "@";

/**
 * The reserved tick that lets a party open a thing with no ticks (given), or keeps it from opening it by every route
 * (withheld; item 113). Any giving row of a tick of the kind lets the party in too.
 */
export const OPEN = "@open";

/** The prefix of a Make tick (item 114): `@make:<kind name>` lets its party make things of that kind in a workspace. */
const MAKE = "@make:";

/** The Make tick for every kind, also kinds registered later (item 114): `@make:*`. */
export const MAKE_ANY = `${MAKE}*`;

/** The Make tick of kind `kind` (item 114): `@make:<kind name>`; built only here, never by hand. */
export function makeTick(kind: { readonly name: string }): string {
	return `${MAKE}${kind.name}`;
}

/** Whether `tick` is reserved (item 113): `OPEN` and the Make ticks; a kind's own tick names cannot be. */
export function isReserved(tick: string): boolean {
	return tick.startsWith(RESERVED);
}

/** The kind a Make tick names (`*` for `MAKE_ANY`), or `undefined` for any other tick. */
export function kindOfMakeTick(tick: string): string | undefined {
	return tick.startsWith(MAKE) ? tick.slice(MAKE.length) : undefined;
}

/**
 * Who wrote something: a person by hand, a session's agent (a thing it made), a thing (a share, a bot: it goes with
 * it), a sign-in provider, a plugin.
 */
export const Source = union([
	obj({ kind: lit("person"), person: str() }),
	obj({ kind: lit("agent"), session: str() }),
	obj({ kind: lit("thing"), thing: str() }),
	obj({ kind: lit("identity"), provider: str() }),
	obj({ kind: lit("plugin"), plugin: str() }),
]);

/** Who wrote something (see `Source`). */
export type Source = Static<typeof Source>;

/**
 * Whom a grant names: everyone here (every person who counts as here; never an agent), the agents (of any session
 * here), one person, one group, or one session's agent by name.
 */
export const Party = union([
	obj({ kind: lit("everyone") }),
	obj({ kind: lit("agents") }),
	obj({ kind: lit("person"), person: str() }),
	obj({ kind: lit("group"), group: str() }),
	obj({ kind: lit("agent"), session: str() }),
]);

/** Whom a grant names (see `Party`). */
export type Party = Static<typeof Party>;

/** What a switch is about: a thing, or a party, from above. */
export const Item = union([obj({ kind: lit("thing"), thing: str() }), obj({ kind: lit("party"), party: Party })]);

/** What a switch is about (see `Item`). */
export type Item = Static<typeof Item>;

/**
 * Who changes a group's members: whoever has the group's own tick (`people`), a thing (a share), a sign-in provider, a
 * plugin, or one workspace (its own Guests group).
 */
export const ManagedBy = union([
	obj({ kind: lit("people") }),
	obj({ kind: lit("thing"), thing: str() }),
	obj({ kind: lit("identity"), provider: str() }),
	obj({ kind: lit("plugin"), plugin: str() }),
	obj({ kind: lit("workspace"), workspace: str() }),
]);

/** Who changes a group's members (see `ManagedBy`). */
export type ManagedBy = Static<typeof ManagedBy>;

/**
 * Who calls a thing's object, as data: a person, a session's agent, or the server (trusted server code). What a
 * kind's factory gets as `caller` (authors, names).
 */
export const Caller = union([
	obj({ kind: lit("person"), person: str() }),
	obj({ kind: lit("agent"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who calls a thing's object (see `Caller`). */
export type Caller = Static<typeof Caller>;

/** The admission data of every thing's object besides `granted`: who calls. */
export const ThingAdmission = obj({ caller: Caller });

/** The params of every thing's object: the workspace it is held in, and the thing. */
export const THING_PARAMS = { workspace: str(), thing: str() };

/** The key of `party`: what the tables store and every map in memory is keyed by. The only writer of such a text. */
export function partyKey(party: Party): string {
	switch (party.kind) {
		case "everyone":
		case "agents":
			return party.kind;
		case "person":
			return `person/${party.person}`;
		case "group":
			return `group/${party.group}`;
		case "agent":
			return `agent/${party.session}`;
	}
}

/** The party whose key (`partyKey`) is `key`: its inverse, for what the index keeps by key. */
export function partyOf(key: string): Party {
	if (key === "everyone" || key === "agents") return { kind: key };
	const at = key.indexOf("/");
	const id = key.slice(at + 1);
	switch (key.slice(0, at)) {
		case "person":
			return { kind: "person", person: id };
		case "group":
			return { kind: "group", group: id };
		default:
			return { kind: "agent", session: id };
	}
}

/**
 * The key of `source`; a thing's, a provider's and a plugin's are the same texts as `managedByKey` makes (the cleanup
 * matches them).
 */
export function sourceKey(source: Source): string {
	switch (source.kind) {
		case "person":
			return `person/${source.person}`;
		case "agent":
			return `agent/${source.session}`;
		case "thing":
			return `thing/${source.thing}`;
		case "identity":
			return `identity/${source.provider}`;
		case "plugin":
			return `plugin/${source.plugin}`;
	}
}

/** The key of `item`: a thing's `thing/<id>`, a party's its party key (no party key starts with `thing/`). */
export function itemKey(item: Item): string {
	return item.kind === "thing" ? `thing/${item.thing}` : partyKey(item.party);
}

/** The key of `by`: as `sourceKey` for a thing, a provider and a plugin, so a source's cleanup finds its groups. */
export function managedByKey(by: ManagedBy): string {
	switch (by.kind) {
		case "people":
			return "people";
		case "workspace":
			return `workspace/${by.workspace}`;
		default:
			return sourceKey(by);
	}
}

/**
 * A group as anyone it is present for holds it (1141 §7, decision 68): its info and members for all of them (its
 * members, its managers, the owners, and whoever it is present for where they are present); its calls only with the
 * group's own tick (a manager: a person named, or a person in a group named) or the owner flag, and only on a group
 * people manage (a share's, a provider's, a plugin's or a workspace's group is changed by its manager alone). A member
 * a person adds must be one the picker offers them (present where they are present; the owner: anyone).
 */
export const Group = remote("things.group", {
	version: 1,
	params: { group: str() },
	hostAddress: () => Server(),
	admission: obj({}),
	state: {
		info: obj({ group: str(), name: str(), outside: bool(), managedBy: ManagedBy }),
		/** The members, a page at a time (`more`): a provider's company group may be large. */
		members: obj({ rows: arr(obj({ person: str(), name: str(), source: Source })), moreAfter: bool() }),
		managers: arr(Party),
	},
	methods: {
		/** The next page of `members`. */
		more: method(),
		addMember: grantable(method(obj({ person: str() }))),
		/** Takes the person out of the group: every row but a provider's and a share's (theirs to rewrite). */
		removeMember: grantable(method(obj({ person: str() }))),
		rename: grantable(method(obj({ name: str({ min: 1, max: 200 }) }))),
		setManagers: grantable(method(obj({ parties: arr(Party) }))),
		/** Removes the group (`ThingsStore.removeGroup`); the call ends with the object, denied once the group is gone. */
		remove: grantable(method()),
	},
});
