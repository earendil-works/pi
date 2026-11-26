// The sessions plugin's contract for server facets: its store (`SessionsStore`): what the plugin keeps of each session
// besides its workspace (where it works, its state, its model, whether it is archived; its title and parent are its
// thing's and line's in the things store), and each session defaults thing's settings. Server code only: it checks no
// caller. `/v1/server` re-exports it.

import { arr, local, method, nul, num, obj, opt, queries, str, union } from "@earendil-works/p3/v1";
import { Location, ModelChoice, SessionDefaults, SessionState } from "./contract.ts";

/**
 * What the sessions plugin keeps of a session: its id (its workspace's), where it works, when it was made, its state,
 * when it was last touched, when it was archived (`null`: it is not) and its model (`null`: the agent's default).
 */
export const SessionRecord = obj({
	id: str(),
	location: Location,
	createdAt: num(),
	state: SessionState,
	lastTouch: num(),
	archivedAt: union([num(), nul()]),
	model: union([ModelChoice, nul()]),
});

/** A session defaults thing's settings, by thing. */
export const DefaultsRecord = obj({ thing: str(), defaults: SessionDefaults });

/** The sessions plugin's store, once per server: its rows as named queries, and every write. */
export const SessionsStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		sessions: queries(SessionRecord, {
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
		}),
		defaults: queries(DefaultsRecord, {
			/** The settings of defaults thing `thing`, if any were set. */
			one: obj({ thing: str() }),
		}),
		/**
		 * Writes a new session's row (the session kind's create hook, before its workspace's commit). Without a location it
		 * works on this device in a folder the plugin makes for it (`<data directory>/folders/<id>`); a location given must
		 * name a machine there is.
		 */
		insert: method(obj({ id: str(), location: opt(Location), model: union([ModelChoice, nul()]) })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		setModel: method(obj({ session: str(), model: union([ModelChoice, nul()]) })),
		/** Session `session`'s agent is in `state` now: its row says so, and it is touched. */
		report: method(obj({ session: str(), state: SessionState })),
		/** Deletes session `session`'s row (its workspace went, or its commit failed). */
		remove: method(obj({ session: str() })),
		/** The ids of every session whose agent is working and that is not archived, all of them: the waker's. */
		working: method(obj({}), arr(str())),
		/** Sets defaults thing `thing`'s settings. */
		setDefaults: method(DefaultsRecord),
		/** Deletes defaults thing `thing`'s settings (the thing went). */
		removeDefaults: method(obj({ thing: str() })),
	},
});
