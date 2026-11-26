// The people plugin's contract for server facets: the persons and groups, once per server. Apps make their groups
// here from their server code (`group` is made once per app and name) and put persons into them; the sessions plugin
// reads a person's groups to answer their access. `/v1/server` re-exports it.

import { arr, local, method, obj, queries, str } from "@earendil-works/p3/v1";
import { Group, Person } from "./contract.ts";

/** The persons and groups: their rows as named queries, and every write. Server code only: it checks no caller. */
export const PeopleStore = local("people.store", {
	version: 1,
	params: {},
	members: {
		persons: queries(Person, {
			/** Every person, by name. */
			all: obj({}),
			/** The person `id`, if there is one. */
			one: obj({ id: str() }),
			/** The owner's person: one, from the server's first start on. */
			owner: obj({}),
			/** The persons of `ids` there are, by id (a session's members, for their names). */
			ofIds: obj({ ids: arr(str()) }),
		}),
		groups: queries(Group, {
			/** An app's groups, by name. */
			ofApp: obj({ app: str() }),
			/** The group `id`, if there is one. */
			one: obj({ id: str() }),
			/** The groups of `ids` there are, by id (a session's members, for their names). */
			ofIds: obj({ ids: arr(str()) }),
			/** The groups person `person` is in, by id: read whole by whoever decides access with them. */
			ofPerson: obj({ person: str() }),
		}),
		/** The persons of group `group`, by name. */
		members: queries(Person, { of: obj({ group: str() }) }),
		/** Makes a person (no owner); answers their id. */
		createPerson: method(obj({ name: str({ min: 1, max: 200 }) }), str()),
		renamePerson: method(obj({ person: str(), name: str({ min: 1, max: 200 }) })),
		/** Removes a person, from every group too; never the owner (`invalid`). */
		removePerson: method(obj({ person: str() })),
		/** App `app`'s group `name`, made by the first call; answers its id. */
		group: method(obj({ app: str(), name: str({ min: 1, max: 200 }) }), str()),
		addToGroup: method(obj({ group: str(), person: str() })),
		removeFromGroup: method(obj({ group: str(), person: str() })),
	},
});
