// The people plugin's contracts: who the caller is (`Me`), the owner's persons (`People`, `PeopleList`), and the
// admission of the owner's objects (`admitOwner`, from `OwnerAccess`). A person is anyone who signs in; the owner is one too, the one whose
// row says so (made at the server's first start, never removed). The owner makes the others with invite links, which
// sign their first browser in as them. Groups are made by apps (`PeopleStore`, `contract.server.ts`). `/v1`
// re-exports this file.

import {
	type Admission,
	type AdmitSelf,
	allow,
	arr,
	bool,
	callerKey,
	deny,
	lit,
	method,
	obj,
	type P3Principal,
	remote,
	Server,
	type Static,
	str,
	union,
	type Watchable,
} from "@earendil-works/p3/v1";

/**
 * A person: their id, their name as the owner gave it (the owner's own: the OS user's at first), and whether they are
 * the owner.
 */
export const Person = obj({ id: str(), name: str({ max: 200 }), owner: bool() });

/** A person (see `Person`). */
export type Person = Static<typeof Person>;

/** A group an app made for one of its roles: its id, its app and its name in that app. */
export const Group = obj({ id: str(), app: str(), name: str({ max: 200 }) });

/** A group (see `Group`). */
export type Group = Static<typeof Group>;

/** The admission value of the owner's objects: none (the owner is admitted, anyone else denied). */
export const OwnerAdmission = obj({});

/** Who the caller is: a person (`owner`: the owner, read live from their row), or a session's agent (its worker). */
export const Me = remote("people.me", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: {
		me: union([
			obj({ kind: lit("person"), id: str(), name: str(), owner: bool() }),
			obj({ kind: lit("agent"), session: str() }),
		]),
	},
});

/**
 * The owner's persons: `invite` makes a person and answers the path of a one-time link (`/_p3/invite#<token>`, valid
 * 10 minutes) whose page signs a browser in as them; `rename`, `remove` (their sign-ins end at once).
 */
export const People = remote("people.people", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	admission: OwnerAdmission,
	methods: {
		invite: method(obj({ name: str({ min: 1, max: 200 }) }), obj({ person: str(), link: str() })),
		/** A fresh invite link for an existing person (the previous one no longer valid). */
		link: method(obj({ person: str() }), str()),
		rename: method(obj({ person: str(), name: str({ min: 1, max: 200 }) })),
		remove: method(obj({ person: str() })),
	},
});

/** One screen's list of the owner's persons, by name; `more` loads the next page. */
export const PeopleList = remote("people.list", {
	version: 1,
	params: { view: str() },
	hostAddress: () => Server(),
	admission: OwnerAdmission,
	state: { list: obj({ rows: arr(Person), moreAfter: bool() }) },
	methods: { more: method() },
});

/**
 * Whether a caller (`callerKey`) is the owner: a person whose row says so, read live. Asked by the server and workers
 * about anyone (an admission on a worker asks for its object's caller), by anyone else about themselves only.
 */
export const OwnerAccess = remote("people.owner-access", {
	version: 1,
	params: { caller: str() },
	hostAddress: () => Server(),
	state: { owner: bool() },
});

/**
 * The admission of an object for the owner only (`admission: OwnerAdmission`), on the server or a worker: allowed
 * while the caller is the owner (`OwnerAccess`, live), denied for anyone else.
 */
export function admitOwner(
	_params: unknown,
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<Record<string, never>>> {
	const answer = self.get(OwnerAccess, { caller: callerKey(principal) });
	return self.derive([answer.owner], ([owner]) => (owner ? allow({}) : deny("the owner's only")));
}
