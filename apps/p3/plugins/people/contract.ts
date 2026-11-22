// The people plugin's contracts: who the caller is (`Me`), and the owner's persons (`People`, `PeopleList`). A
// person is anyone besides the owner who signs in; the owner makes one with an invite link, which signs its first
// browser in as them. Groups are made by apps (`PeopleStore`, `contract.server.ts`). `/v1` re-exports this file.

import { arr, bool, lit, method, obj, remote, Server, type Static, str, union } from "@earendil-works/p3/v1";

/** A person: their id and their name as the owner gave it. */
export const Person = obj({ id: str(), name: str({ max: 200 }) });

/** A person (see `Person`). */
export type Person = Static<typeof Person>;

/** A group an app made for one of its roles: its id, its app and its name in that app. */
export const Group = obj({ id: str(), app: str(), name: str({ max: 200 }) });

/** A group (see `Group`). */
export type Group = Static<typeof Group>;

/** Who the caller is: the owner, or a person. */
export const Me = remote("people.me", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		me: { state: { me: union([obj({ kind: lit("owner") }), obj({ kind: lit("person"), id: str(), name: str() })]) } },
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
	variants: {
		owner: {
			methods: {
				invite: method(obj({ name: str({ min: 1, max: 200 }) }), obj({ person: str(), link: str() })),
				/** A fresh invite link for an existing person (the previous one no longer valid). */
				link: method(obj({ person: str() }), str()),
				rename: method(obj({ person: str(), name: str({ min: 1, max: 200 }) })),
				remove: method(obj({ person: str() })),
			},
		},
	},
});

/** One screen's list of the owner's persons, by name; `more` loads the next page. */
export const PeopleList = remote("people.list", {
	version: 1,
	params: { view: str() },
	hostAddress: () => Server(),
	variants: { owner: { state: { list: obj({ rows: arr(Person), moreAfter: bool() }) }, methods: { more: method() } } },
});
