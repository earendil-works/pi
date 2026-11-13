// Where sheets render while the Settings window is open: its content pane instead of a sheet of their own, so a
// plugin's sheet (Providers, Envs, ...) becomes a page of Settings without changing its code.
import { useSyncExternalStore } from "react";

/** The Settings window's content pane, and on phones the way back to its list of sections. */
export type SettingsEmbed = { readonly element: HTMLElement; readonly back?: () => void };

let current: SettingsEmbed | undefined;
const listeners = new Set<() => void>();

/** Sets (the Settings window shows a section) or clears where sheets render. */
export function setSettingsEmbed(embed: SettingsEmbed | undefined): void {
	if (embed?.element === current?.element && embed?.back === current?.back) return;
	current = embed;
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () => current;

/** Where a sheet renders now: the Settings window's pane, or `undefined` (a sheet of its own). */
export function useSettingsEmbed(): SettingsEmbed | undefined {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
