// The backup plugin's contract for server facets: its store, which owns the settings and each session's backup state.
// Every write goes through it.

import { bool, local, method, nul, obj, oneOf, queries, str, union } from "@earendil-works/p3/v1";
import { BackupStatus, SessionBackupRow } from "./contract.ts";

/**
 * The backup's store, once per server: whether sessions are backed up by default, each session's own choice, and each
 * session's backup state.
 */
export const BackupStore = local("backup.store", {
	version: 1,
	params: {},
	members: {
		defaultEnabled: bool(),
		/** Sets whether sessions without a choice of their own are backed up. */
		setDefault: method(bool()),
		/** Each session's own choice: `default` (follow it), `on` or `off`. A session without a row follows the default. */
		choices: queries(obj({ choice: oneOf("default", "on", "off") }), {
			/** Session `session`'s own choice, if it has one. */
			one: obj({ session: str() }),
		}),
		/** Sets session `session`'s own choice; `null` goes back to the default. */
		setSession: method(obj({ session: str(), enabled: union([bool(), nul()]) })),
		/** Each session's backup state, for sessions that reported one. */
		states: queries(SessionBackupRow, {
			/** Session `session`'s state, if it reported one. */
			one: obj({ session: str() }),
		}),
		/** Keeps session `session`'s reported state: written only when it differs from the stored one. */
		report: method(obj({ session: str(), status: BackupStatus })),
	},
});
