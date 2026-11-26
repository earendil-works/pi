// The pane layout (`PaneLayout`, the layout plugin's component; decision ERNDL-696): the app's panes by id, and a tree
// (`tree.ts`) of splits and tab groups that says where each one is, which the app keeps as JSON (`onChange`).
// From 48rem the person resizes splits, reorders tabs, moves them between groups and splits groups by dragging
// (`pane-splits.tsx`); on a phone each pane fills the screen under a row of chips, one per open pane, and a swipe goes
// to the neighbour (`pane-chips.tsx`). Both forms show the same tree: what is opened on one shows on the other.

import { useSyncExternalStore } from "react";
import type { PaneLayoutProps } from "./contract.web.tsx";
import { PaneChips } from "./pane-chips.tsx";
import { PaneSplits } from "./pane-splits.tsx";
import { activatePane, closePane, groupOf, groupsOf, panesOf } from "./tree.ts";

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
