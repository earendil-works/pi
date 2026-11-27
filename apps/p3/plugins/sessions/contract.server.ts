// The sessions plugin's contract for server facets: its store (`SessionsStore`): what the plugin keeps of each session
// besides its workspace (where it works, its state, its model, whether it is archived; its name and its place are its
// thing's in the things store). Server code only: it checks no caller. `/v1/server` re-exports it.

import { arr, local, method, nul, obj, opt, queries, str, union } from "@earendil-works/p3/v1";
import { Location, ModelChoice, SessionRow, SessionState } from "./contract.ts";

/** The sessions plugin's store, once per server: its rows as a named query, and every write. */
export const SessionsStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		sessions: queries(SessionRow, {
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
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
		/**
		 * Session `session`'s agent is in `state` now: its row says so, and it is touched. `working` is refused for an
		 * archived session (its worker saw the archive too late), so the waker never wakes one.
		 */
		report: method(obj({ session: str(), state: SessionState })),
		/** Deletes session `session`'s row (its workspace went, or its commit failed). */
		remove: method(obj({ session: str() })),
		/** The ids of every session whose agent is working and that is not archived, all of them: the waker's. */
		working: method(obj({}), arr(str())),
	},
});
