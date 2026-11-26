// The layout plugin's contract for web facets: the pane layout an app places (`PaneLayoutView`: the app's panes and
// a tree of splits and tab groups the app keeps as JSON), and what an app does with that tree itself (plain data and
// pure functions: make one, open or activate a pane, keep only known panes, read one back from storage). Dragging,
// resizing and closing are the view's. `/v1/web` re-exports this file for third-party apps.

import { defineComponent } from "@earendil-works/p3/v1/web";
import type { ReactNode } from "react";
import type { PaneNode } from "./tree.ts";

export {
	activatePane,
	groupOf,
	groupsOf,
	keepPanes,
	openPane,
	type PaneGroup,
	type PaneNode,
	type PaneSplit,
	panesOf,
	paneTree,
	parsePaneTree,
} from "./tree.ts";

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

/**
 * The pane layout (decision ERNDL-696): from 48rem splits the person resizes and tabs they reorder, move and split by
 * dragging; on a phone one pane at a time under a row of chips, a swipe to the neighbour. Both show the same tree.
 */
export const PaneLayoutView = defineComponent<PaneLayoutProps>("layout.panes");
