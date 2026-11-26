// The backup plugin's contract for server facets: its store, which owns the settings. Every write goes through it.

import { bool, local, method, nul, obj, oneOf, queries, str, union } from "@earendil-works/p3/v1";

/** The backup's store, once per server: whether sessions are backed up by default, and each session's own choice. */
export const BackupStore = local("backup.store", {
	version: 1,
	params: {},
	members: {
		defaultEnabled: bool(),
		/** Sets whether sessions without a choice of their own are backed up. */
		setDefault: method(bool()),
		/** Each session's own choice, for sessions that have one: the others follow the default. */
		choices: queries(obj({ choice: oneOf("on", "off") }), {
			/** Session `session`'s own choice, if it has one. */
			one: obj({ session: str() }),
		}),
		/** Sets session `session`'s own choice; `null` goes back to the default. */
		setSession: method(obj({ session: str(), enabled: union([bool(), nul()]) })),
	},
});
