// The app-level collapsed sidebar state from Pi Mobile, shared by the shell and drawer controls, and where the sidebar
// docks instead of being the drawer.
import { useSyncExternalStore } from "react";

/** Where the sidebar docks beside the main area; below it the sessions are a drawer. */
export const SIDEBAR_DOCKS = "(min-width: 900px)";

const subscribeDocked = (changed: () => void) => {
	const media = window.matchMedia(SIDEBAR_DOCKS);
	media.addEventListener("change", changed);
	return () => media.removeEventListener("change", changed);
};
const dockedSnapshot = () => window.matchMedia(SIDEBAR_DOCKS).matches;

/** Whether the sidebar docks (wide screens) rather than opening as the drawer. */
export function useSidebarDocked(): boolean {
	return useSyncExternalStore(subscribeDocked, dockedSnapshot);
}

const KEY = "pi-sidebar-collapsed";
const listeners = new Set<() => void>();
let collapsed = false;
try {
	collapsed = localStorage.getItem(KEY) === "1";
} catch {}

const snapshot = () => collapsed;
export function useSidebarCollapsed(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		snapshot,
		snapshot,
	);
}
export function setSidebarCollapsed(value: boolean): void {
	if (value === collapsed) return;
	collapsed = value;
	try {
		localStorage.setItem(KEY, value ? "1" : "0");
	} catch {}
	for (const listener of listeners) listener();
}
export function toggleSidebar(): void {
	setSidebarCollapsed(!collapsed);
}
