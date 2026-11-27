// The sessions plugin's contract for server facets: its store (`SessionsStore`): what the plugin keeps of each session
// besides its workspace (where it works and where its moved conversations work, its state, its model, whether it is
// archived; its name and its place are its thing's in the things store). Server code only: it checks no caller.
// `/v1/server` re-exports it.

import { arr, local, method, nul, obj, opt, queries, str, union } from "@earendil-works/p3/v1";
import { ConversationLocation, Location, ModelChoice, SessionRow, SessionState } from "./contract.ts";

/**
 * How many conversations of one session may have a location of their own (`moveLocation` refuses more): what the live
 * reads of them ask for, so they are whole (a session's conversations are its main one and its subagents').
 */
export const MOVED_MAX = 1000;

/** The sessions plugin's store, once per server: its rows as a named query, and every write. */
export const SessionsStore = local("sessions.store", {
	version: 2,
	params: {},
	members: {
		sessions: queries(SessionRow, {
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
		}),
		locations: queries(ConversationLocation, {
			/** Session `session`'s moved conversations, by conversation id. */
			ofSession: obj({ session: str() }),
		}),
		/**
		 * Writes a new session's row (the session kind's create hook, before its workspace's commit). Without a location it
		 * works on this device in a folder the plugin makes for it (`<work root>/<id>`); a location given must name a
		 * machine (its Work is checked at use: the session's workspace does not stand yet).
		 */
		insert: method(obj({ id: str(), location: opt(Location), model: union([ModelChoice, nul()]) })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		setModel: method(obj({ session: str(), model: union([ModelChoice, nul()]) })),
		/**
		 * Moves conversation `conversation` of session `session` to `location`: refused (`invalid`, with a message) unless
		 * its folder is a full path and the session's agents have Work on its machine there (decision 24). The next tool
		 * call of the conversation works there; a call under way keeps its environment.
		 */
		moveLocation: method(obj({ session: str(), conversation: str({ max: 20 }), location: Location })),
		/**
		 * Session `session`'s agent is in `state` now: its row says so, and it is touched. `working` is refused for an
		 * archived session (its worker saw the archive too late), so the waker never wakes one.
		 */
		report: method(obj({ session: str(), state: SessionState })),
		/** Deletes session `session`'s row and its moved conversations (its workspace went, or its commit failed). */
		remove: method(obj({ session: str() })),
		/** The ids of every session whose agent is working and that is not archived, all of them: the waker's. */
		working: method(obj({}), arr(str())),
	},
});
