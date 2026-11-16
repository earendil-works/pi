// What the sessions plugin shares with other plugins' web facets: for rows of their own in the sidebar (the
// `sidebar-start:<name>` slots) the rows as the sidebar shows them, a row's shape and state marks, and listing sessions
// apart from the rollups because a row of their own shows them; for session commands in the command menu, the session a
// command acts on (command-session.tsx); for conversation rows, the mark a subagent's row has.
import { sharedContext } from "@p2/app/v1/web";
import type { SidebarRow } from "./sidebar/model.ts";

export {
	commandSession,
	NotArchived,
	openPanelIn,
	useCommandSession,
	useOpenFromMenu,
	useSessions,
} from "./command-session.tsx";
export { IconMarker, RunMark, UnreadMark, WorkingMark } from "./sidebar/marks.tsx";
export type { SidebarRow } from "./sidebar/model.ts";
export { NavRow } from "./sidebar/NavRow.tsx";

export type DrawerRows = {
	/** Every row of the sidebar, with its worker state, including the ones listed apart. */
	readonly sessions: readonly SidebarRow[];
	/** Leaves `ids` out of the rollups under `key` (one entry per plugin); `[]` lists them there again. */
	readonly listApart: (key: string, ids: readonly string[]) => void;
};

/** The sidebar's rows for other plugins' entries in it (one context for every plugin's script: `sharedContext`). */
export const DrawerRowsContext = sharedContext<DrawerRows>("p2.sessions.drawer-rows", {
	sessions: [],
	listApart: () => {},
});
