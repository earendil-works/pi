// A layout of panes an app gives its page (`PaneLayout`, `/v1/web`; decision ERNDL-696): the app's panes by id, and a
// tree (`pane-tree.ts`) of splits and tab groups that says where each one is, which the app keeps as JSON (`onChange`).
// From 48rem the person resizes splits, reorders tabs, moves them between groups and splits groups by dragging
// (`pane-splits.tsx`); on a phone each pane fills the screen under a row of chips, one per open pane, and a swipe goes
// to the neighbour (`pane-chips.tsx`). Both forms show the same tree: what is opened on one shows on the other.

import { type ReactNode, useSyncExternalStore } from "react";
import { PaneChips } from "./pane-chips.tsx";
import { PaneSplits } from "./pane-splits.tsx";
import { activatePane, closePane, groupOf, groupsOf, type PaneNode, panesOf } from "./pane-tree.ts";

/** A pane: its id (as the tree names it), its tab's title, whether the person may close it, and its content. */
export type Pane = {
	readonly id: string;
	readonly title: string;
	readonly closable: boolean;
	readonly render: () => ReactNode;
};

/**
 * What a pane layout takes: the app's panes (a pane the tree names without one here is not shown), the tree, which
 * the app keeps (`onChange` gets every change), and the focused pane (the one the app's route names), whose change
 * the person asks for with `onFocus`.
 */
export type PaneLayoutProps = {
	readonly panes: readonly Pane[];
	readonly tree: PaneNode;
	readonly onChange: (tree: PaneNode) => void;
	readonly focused: string | undefined;
	readonly onFocus: (pane: string) => void;
};

/** The layout: split and draggable from 48rem, one pane at a time under its chips on a phone. */
export function PaneLayout(props: PaneLayoutProps) {
	const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
	return wide ? <PaneSplits {...props} /> : <PaneChips {...props} />;
}

/** The media query the split form needs: a tablet or wider. */
const WIDE = "(min-width: 48rem)";

/** Subscribes `changed` to the window crossing `WIDE`. */
function subscribeWide(changed: () => void): () => void {
	const query = matchMedia(WIDE);
	query.addEventListener("change", changed);
	return () => query.removeEventListener("change", changed);
}

/** Whether the window is `WIDE`. */
function isWide(): boolean {
	return matchMedia(WIDE).matches;
}

/** Shows `pane`: active in its group, and focused. */
export function showPane(props: PaneLayoutProps, pane: string): void {
	props.onChange(activatePane(props.tree, pane));
	props.onFocus(pane);
}

/**
 * Closes `pane`; when it was the focused one, the focus goes to the pane its group shows next, else (the group went)
 * to the pane that followed it in the tree's order (the chips' order), else the one before it.
 */
export function closeShownPane(props: PaneLayoutProps, pane: string): void {
	const next = closePane(props.tree, pane);
	props.onChange(next);
	if (props.focused !== pane) return;
	const group = groupOf(props.tree, pane)?.id;
	const left = panesOf(next);
	const at = Math.min(panesOf(props.tree).indexOf(pane), left.length - 1);
	const focus = groupsOf(next).find((each) => each.id === group)?.active ?? left[at];
	if (focus !== undefined) props.onFocus(focus);
}
