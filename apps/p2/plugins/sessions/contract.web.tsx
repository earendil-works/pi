// What the sessions drawer shares with other plugins' drawer entries (`drawer-head:*` slots, browser): the rows as the
// drawer shows them, and listing sessions apart from the folders because an entry of their own shows them.
import type { SessionSummary } from "@p2/app/v1/web";
import { createContext } from "react";

export type DrawerRows = {
	/** Every row of the drawer, with its worker state, including the ones listed apart. */
	readonly sessions: readonly SessionSummary[];
	/** Leaves `ids` out of the folders under `key` (one entry per plugin); `[]` lists them there again. */
	readonly listApart: (key: string, ids: readonly string[]) => void;
};

/** The drawer's rows for its `drawer-head` entries. */
export const DrawerRowsContext = createContext<DrawerRows>({ sessions: [], listApart: () => {} });
