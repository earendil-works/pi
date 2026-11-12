// The view kinds of the page: the pane component of each kind of view beside the transcript, contributed by web facets
// and keyed by kind (the views plugin's built-in kinds; any plugin's, an agent-written one included, under its own name).
// The views plugin serves the registry and lays the panes out (`plugins/views`, docs/views.md).
import type { ComponentType } from "react";
import type { Annotation, Selection, View } from "../../plugins/views/contract.ts";
import { keyedRegistry } from "../runtime/chord.ts";

/** What a pane gets: its view, whether the person may change it, and its annotations. */
export type PaneProps = {
	readonly session: string;
	/** The view: its ID, kind and title, and (for a plugin's kind) whatever else its plugin keeps in the view's state. */
	readonly view: View;
	/** The person may send in the session: their selections and changes are saved. */
	readonly editable: boolean;
	/** Sets (null: clears) the person's selection in this view. */
	readonly select: (selection: Pick<Selection, "summary" | "data"> | null) => void;
	/** The annotations on this view. */
	readonly annotations: readonly Annotation[];
};

/** The pane component of each view kind. */
export const ViewKinds = keyedRegistry<ComponentType<PaneProps>>("p2.view-kinds");
