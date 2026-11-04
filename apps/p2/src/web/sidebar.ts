// The app-level collapsed sidebar state from Pi Mobile, shared by the shell and drawer controls.
import { useSyncExternalStore } from "react";

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
