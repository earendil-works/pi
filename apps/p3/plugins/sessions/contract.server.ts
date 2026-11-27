// The sessions plugin's contract for server facets: its store (`SessionsStore`): what the plugin keeps of each session
// besides its workspace (where it works and where its moved conversations work, its state, its model, whether it is
// archived; its name and its place are its thing's in the things store). Server code only: it checks no caller.
// `/v1/server` re-exports it.

import { arr, keyed, local, method, nul, obj, opt, queries, Session, str, union } from "@earendil-works/p3/v1";
import { ConversationKey, Location, ModelChoice, SessionDetail, SessionRow, SessionState } from "./contract.ts";

/** The sessions plugin's store, once per server: its rows as a named query, and every write. */
export const SessionsStore = local("sessions.store", {
	version: 2,
	params: {},
	members: {
		sessions: queries(SessionRow, {
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
		}),
		/** Each session's moved conversations, by its address: one document, whole (none moved: no location). */
		moved: keyed(SessionDetail, Session),
		/**
		 * Writes a new session's row (the session kind's create hook, before its workspace's commit, after it checked the
		 * maker may use the machine, R41). Left out, the session works on this device in a folder the plugin makes for it
		 * (`<work root>/<id>`); `null`: on no machine; a location given must name a machine and a full path (its Work is
		 * checked at use: the session's workspace does not stand yet).
		 */
		insert: method(obj({ id: str(), location: opt(union([Location, nul()])), model: union([ModelChoice, nul()]) })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		setModel: method(obj({ session: str(), model: union([ModelChoice, nul()]) })),
		/**
		 * Moves conversation `conversation` of session `session` to `location` (decision 24): refused unless its folder is
		 * a full path (`invalid`) and the session's agents have Work on its machine there (`forbidden`, the machine kind's
		 * rule), each with a message. The next tool call of the conversation works there; a call under way keeps its
		 * environment. `null` undoes its move: it works where its owner conversation works again.
		 */
		moveLocation: method(obj({ session: str(), conversation: ConversationKey, location: union([Location, nul()]) })),
		/**
		 * Session `session`'s agent is in `state` now: its row says so, and it is touched. `working` is refused for an
		 * archived session (its worker saw the archive too late), so the waker never wakes one.
		 */
		report: method(obj({ session: str(), state: SessionState })),
		/**
		 * Deletes session `session`'s row, its moved conversations and what its workers kept (their directory, after its
		 * worker stopped): its workspace went, or its commit failed.
		 */
		remove: method(obj({ session: str() })),
		/** The ids of every session whose agent is working and that is not archived, all of them: the waker's. */
		working: method(obj({}), arr(str())),
	},
});
