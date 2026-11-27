// The environments plugin's contract for web facets: where a view opened in a workspace works (`useWorkLocation`):
// the session's location when the workspace is a session's (its kind says so), else this device's machine at its
// root. Files and Terminals open there.

import { BACKGROUND_CONTEXT, type Reference, SessionObject, ThisDevice, Workspace } from "@earendil-works/p3/v1";
import { useHold, useHost, useLive, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useEffect, useState } from "react";

/** Where a view works: not known yet, a machine thing's id and a folder on it, or a session whose row the person may
 * not read (so its location is not theirs to see). */
export type WorkLocation =
	| { readonly kind: "loading" }
	| { readonly kind: "at"; readonly machine: string; readonly folder: string }
	| { readonly kind: "unreadable" };

/** The session kind's name: a workspace of it works where its row says. */
const SESSION_KIND = "sessions.session";

/** Not known yet. */
const LOADING: WorkLocation = { kind: "loading" };

/**
 * Where a view opened in `workspace` works: the session's location when `workspace` is a session's (its row, live),
 * else this device's machine at its root.
 */
export function useWorkLocation(workspace: string): WorkLocation {
	const info = useWatch(useLive(useHold(Workspace, { workspace }))?.info);
	const session = useSession(workspace, info?.kind === SESSION_KIND);
	const row = useWatch(useLive(session)?.row);
	const state = useRefState(session);
	const device = useWatch(useLive(useHold(ThisDevice, {}))?.machine);
	if (info === undefined) return LOADING;
	if (info.kind === SESSION_KIND) {
		if (row !== undefined) return { kind: "at", machine: row.location.environment, folder: row.location.folder };
		return state?.kind === "failed" ? { kind: "unreadable" } : LOADING;
	}
	return device === undefined || device === "" ? LOADING : { kind: "at", machine: device, folder: "/" };
}

/** Session `workspace`'s object, held while `held` (a workspace that is no session's is never asked for one). */
function useSession(workspace: string, held: boolean): Reference<typeof SessionObject> | undefined {
	const host = useHost();
	const [ref, setRef] = useState<Reference<typeof SessionObject>>();
	useEffect(() => {
		if (!held) return;
		const hold = host.hold(SessionObject, { workspace, thing: workspace }, BACKGROUND_CONTEXT);
		setRef(hold);
		return () => {
			hold.release();
			setRef(undefined);
		};
	}, [host, workspace, held]);
	return ref;
}
