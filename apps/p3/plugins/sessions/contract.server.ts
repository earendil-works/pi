// The sessions plugin's contract for server facets: the store of the sessions, their members and things, which apps
// call from their server code to manage their sessions (the owner's `Sessions` calls it too), and whose named queries
// other server objects read; and the registry of the kinds of things. `/v1/server` re-exports it.

import {
	arr,
	defineRegistry,
	type JsonValue,
	local,
	method,
	num,
	obj,
	opt,
	queries,
	str,
	type TableItem,
	unknown,
} from "@earendil-works/p3/v1";
import {
	Location,
	Member,
	NewThing,
	OptionsFor,
	Party,
	SessionRow,
	SessionState,
	SessionThing,
	type ThingKind,
	Title,
} from "./contract.ts";

/**
 * The sessions, once per server: their rows, members and things as named queries, and every write. Server code only
 * (an app's server facet, the owner's views): it acts for the Pi and checks no caller.
 */
export const SessionsStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		sessions: queries(SessionRow, {
			/** An app's sessions that are not archived, the last touched first. */
			active: obj({ app: str() }),
			/** An app's archived sessions, the last archived first. */
			archived: obj({ app: str() }),
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
		}),
		members: queries(Member, {
			/** Session `session`'s members, in the order they were added. */
			of: obj({ session: str() }),
		}),
		/** The sessions an app's members (persons and groups by key, `person:<id>`, `group:<id>`) are in. */
		memberships: queries(SessionRow, {
			/** Of `members` in `app`, active, the last touched first. */
			active: obj({ app: str(), members: arr(str()) }),
			/** Of `members` in `app`, archived, the last archived first. */
			archived: obj({ app: str(), members: arr(str()) }),
		}),
		things: queries(SessionThing, {
			/** Session `session`'s things, in the order they were added. */
			of: obj({ session: str() }),
			/** Thing `thing` of session `session`, if it has it. */
			one: obj({ session: str(), thing: str() }),
		}),
		/** The options set for one thing of a session, by whom (`everyone`, `agent`, `person:<id>`, `group:<id>`). */
		options: queries(obj({ thing: str(), for: str(), version: num(), options: unknown() }), {
			/** Every option set for thing `thing` of session `session`. */
			of: obj({ session: str(), thing: str() }),
			/** The options `for` set for every thing of session `session`, by thing. */
			ofSession: obj({ session: str(), for: str() }),
		}),
		/**
		 * Makes a session with its members and things in one commit; answers its id. Without a location it works on
		 * this device in a folder the sessions plugin makes for it (`<data directory>/folders/<id>`).
		 */
		create: method(
			obj({
				app: str(),
				title: opt(Title),
				location: opt(Location),
				members: opt(arr(Member)),
				things: opt(arr(NewThing)),
			}),
			str(),
		),
		rename: method(obj({ session: str(), title: Title })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		addMember: method(obj({ session: str(), member: Member })),
		removeMember: method(obj({ session: str(), party: Party })),
		addThing: method(obj({ session: str(), thing: NewThing }), str()),
		removeThing: method(obj({ session: str(), thing: str() })),
		setOptions: method(obj({ session: str(), thing: str(), for: OptionsFor, options: unknown() })),
		/** Session `session`'s agent is in `state` now: its row says so, and it is touched. */
		report: method(obj({ session: str(), state: SessionState })),
		/** The ids of every session whose agent is working and that is not archived, all of them: the waker's. */
		working: method(obj({}), arr(str())),
	},
});

/** A kind of thing as its plugin offers it: the kind (its options' schema, version, initial) and its title. */
export type ThingKindEntry = { readonly kind: ThingKind<JsonValue>; readonly title: string };

/** The kinds of things by name, each with its plugin: what `addThing` and `setOptions` check options against. */
export const ThingKinds = defineRegistry<ThingKindEntry, ReadonlyMap<string, TableItem<ThingKindEntry>>>(
	"sessions.thing-kinds",
	{ version: 1 },
);
