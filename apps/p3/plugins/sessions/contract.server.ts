// The sessions plugin's contract for server facets: the store of the sessions, whose named queries other objects on the
// server read (the plugin's own views now; groupings and people later).

import { arr, local, method, obj, queries, str } from "@earendil-works/p3/v1";
import { Creator, SessionRow, SessionState, Title } from "./contract.ts";

/** The sessions: their rows as named queries, and the writes. Once per server. */
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
		create: method(obj({ title: Title, creator: Creator }), str()),
		rename: method(obj({ id: str(), title: Title })),
		archive: method(obj({ id: str() })),
		restore: method(obj({ id: str() })),
		/** Session `id`'s agent is in `state` now: its row says so, and it is touched. */
		report: method(obj({ id: str(), state: SessionState })),
		/** The ids of every session whose agent is working, all of them: whose workers the waker starts. */
		working: method(obj({}), arr(str())),
	},
});
