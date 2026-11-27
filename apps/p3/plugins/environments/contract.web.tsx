// The environments plugin's contract for web facets: where a view opened in a workspace works (`useWorkLocation`):
// the session's location when the workspace is a session's, else this device's machine at its root. Files and
// Terminals open there.

import { SessionObject, ThisDevice } from "@earendil-works/p3/v1";
import { useHold, useLive, useRefState, useWatch } from "@earendil-works/p3/v1/web";

/** A machine thing's id and a folder on it. */
export type WorkLocation = { readonly machine: string; readonly folder: string };

/**
 * Where a view opened in `workspace` works: the session's location when `workspace` is a session's (its row, live),
 * else this device's machine at its root; `undefined` while that is not known yet.
 */
export function useWorkLocation(workspace: string): WorkLocation | undefined {
	const session = useHold(SessionObject, { workspace, thing: workspace });
	const row = useWatch(useLive(session)?.row);
	const state = useRefState(session);
	const device = useWatch(useLive(useHold(ThisDevice, {}))?.machine);
	if (row !== undefined) return { machine: row.location.machine, folder: row.location.folder };
	// No session's workspace (Pi, a plain one): this device, once its machine was made.
	if (state?.kind === "failed" && device !== undefined && device !== "") return { machine: device, folder: "/" };
	return undefined;
}
