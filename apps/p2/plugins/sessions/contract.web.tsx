// What the sessions sidebar shares with other plugins' entries (the `drawer-brand` slot, browser): the rows as the sidebar
// shows them, their state dot, and listing sessions apart from the rollups because an entry of their own shows them.
import { createContext } from "react";
import type { SidebarRow } from "./sidebar/model.ts";

export type { SidebarRow } from "./sidebar/model.ts";
export { SessionDot } from "./sidebar/Row.tsx";

export type DrawerRows = {
	/** Every row of the sidebar, with its worker state, including the ones listed apart. */
	readonly sessions: readonly SidebarRow[];
	/** Leaves `ids` out of the rollups under `key` (one entry per plugin); `[]` lists them there again. */
	readonly listApart: (key: string, ids: readonly string[]) => void;
};

/** The sidebar's rows for other plugins' entries in it. */
export const DrawerRowsContext = createContext<DrawerRows>({ sessions: [], listApart: () => {} });
