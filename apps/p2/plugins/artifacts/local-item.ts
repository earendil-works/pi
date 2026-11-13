// The artifacts side panel's name, and the item a reader looks at in it, per session, on this device only: people who
// may not change the session's views (read-only guests) open an artifact there instead of as a view of the session.
import { useSyncExternalStore } from "react";

/** The side panel's name for the artifacts (`Route.panel`). */
export const PANEL = "artifacts";

/** An item shown in the side panel: its view kind (whose pane shows it), ID and title. */
export type LocalItem = { readonly kind: string; readonly id: string; readonly title: string };

const shown = new Map<string, LocalItem>();
const listeners = new Set<() => void>();

/** Shows `item` in `session`'s side panel (undefined: the list again). */
export function showLocally(session: string, item: LocalItem | undefined): void {
	if (item) shown.set(session, item);
	else shown.delete(session);
	for (const listener of listeners) listener();
}

/** The item `session`'s side panel shows, if any. */
export function useLocalItem(session: string): LocalItem | undefined {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => shown.get(session),
	);
}
