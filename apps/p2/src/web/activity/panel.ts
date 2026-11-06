// Which activity sheet or panel is open: one at a time, so opening another turn's steps takes the
// docked panel's place. A tiny external store, keyed by each opener's id (useId).
import { useSyncExternalStore } from "react";

let open: string | undefined;
const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};

export function openPanel(id: string): void {
	open = id;
	notify();
}

/** Closes `id`'s panel, if it is the open one. */
export function closePanel(id: string): void {
	if (open !== id) return;
	open = undefined;
	notify();
}

/** Closes whichever panel is open, such as to show the transcript behind a sheet. */
export function closeAnyPanel(): void {
	if (open === undefined) return;
	open = undefined;
	notify();
}

/** Whether `id`'s panel is the open one. */
export function usePanelOpen(id: string): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => open === id,
		() => false,
	);
}
