// Each session's layout on this device (layout.ts), kept in the browser's storage, shared by the workbench and the
// Views sheet; and the annotation mode, which the top bar switches and the workbench shows.
import { useSyncExternalStore } from "react";
import { activate, CHAT, initialLayout, type Layout, parseLayout, place, viewsIn, without } from "./layout.ts";

const KEY = "p2.views.layout:";
const layouts = new Map<string, Layout>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const changed = () => {
	for (const listener of listeners) listener();
};

/** Session `session`'s layout on this device (the transcript alone at first). */
export function layoutOf(session: string): Layout {
	let layout = layouts.get(session);
	if (!layout) {
		try {
			const stored = localStorage.getItem(KEY + session);
			layout = stored === null ? undefined : parseLayout(JSON.parse(stored));
		} catch {
			layout = undefined;
		}
		layout ??= initialLayout();
		layouts.set(session, layout);
	}
	return layout;
}

/** Changes session `session`'s layout and keeps it. */
export function setLayout(session: string, change: (layout: Layout) => Layout): void {
	const next = change(layoutOf(session));
	if (next === layouts.get(session)) return;
	layouts.set(session, next);
	try {
		localStorage.setItem(KEY + session, JSON.stringify(next));
	} catch {}
	changed();
}

/** Session `session`'s layout, re-rendering on change. */
export function useLayout(session: string): Layout {
	return useSyncExternalStore(
		subscribe,
		() => layoutOf(session),
		() => layoutOf(session),
	);
}

/** Hides a view on this device: out of the layout until the Views sheet or the agent shows it again. */
export function hide(session: string, id: string): void {
	setLayout(session, (current) => ({
		...current,
		tree: without(current.tree, id) ?? current.tree,
		hidden: [...current.hidden.filter((each) => each !== id), id],
		phone: current.phone === id ? CHAT : current.phone,
	}));
}

/** Shows a view on this device again, in front. */
export function show(session: string, id: string): void {
	setLayout(session, (current) => ({
		...current,
		hidden: current.hidden.filter((each) => each !== id),
		tree: viewsIn(current.tree).includes(id) ? activate(current.tree, id) : place(current.tree, id),
		phone: id,
	}));
}

/** Annotation mode: off, marking text (comments and removals), or drawing. */
export type AnnotateMode = "off" | "text" | "draw";
let mode: AnnotateMode = "off";

/** The annotation mode now. */
export const annotateMode = (): AnnotateMode => mode;

/** Switches annotation mode. */
export function setAnnotateMode(next: AnnotateMode): void {
	if (next === mode) return;
	mode = next;
	changed();
}

/** The annotation mode, re-rendering on change. */
export function useAnnotateMode(): AnnotateMode {
	return useSyncExternalStore(
		subscribe,
		() => mode,
		() => mode,
	);
}
