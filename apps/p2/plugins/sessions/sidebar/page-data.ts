// What the sidebar publishes for views outside it: a rollup's or a group's list page in the main area and the command
// menu's folder pages. The sidebar is always mounted (docked, or in the drawer) and holds the one copy of the data, with
// its edits shown at once; the views render from it, so they show the same rows as the sidebar, offline too.
import { useSyncExternalStore } from "react";
import type { SearchResults } from "../../search/contract.ts";
import type { NewTarget, Rollup, RollupContext, SidebarRow, View } from "./model.ts";

/** What a list page shows and acts with, and where a group's "+" starts a session. */
export type PageData = {
	readonly rows: readonly SidebarRow[];
	readonly rollups: readonly Rollup[];
	readonly context: RollupContext;
	readonly view: View;
	/** The sessions (or, for a project's list, the projects) are not known yet. */
	readonly loading: (page: string) => boolean;
	readonly connected: boolean;
	readonly onOpen: (id: string, conversation?: number) => void;
	readonly onRestore: (id: string, conversation?: number) => void;
	readonly onSearch?: (query: string, archived: boolean, sessions: readonly string[]) => Promise<SearchResults>;
	readonly onNewIn?: (target: NewTarget) => void;
};

const listeners = new Set<() => void>();
let data: PageData | undefined;

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** Publishes the sidebar's data (the sidebar calls it as its data changes). */
export function publishPage(next: PageData): void {
	data = next;
	for (const listener of listeners) listener();
}

/** The sidebar's data as last published; undefined before the sidebar first rendered. */
export const usePageData = (): PageData | undefined => useSyncExternalStore(subscribe, () => data);
