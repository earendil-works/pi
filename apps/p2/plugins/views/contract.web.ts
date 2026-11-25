// What the views plugin's page state offers other plugins' web facets (an html artifact's pane, the artifacts sheet):
// one entry of a registry the views plugin serves and fills. Plugins' web scripts are built one per plugin, a file one
// imports from another copied into it: state a module holds would be a second copy there, so it is reached here.
import { type HeldIn, keyedRegistry } from "@p2/app/v1";
import type { OpenInput, Views } from "./contract.ts";

/**
 * What the annotation layer asks a pane that is a frame of its own (an html artifact): the text the person selected in it,
 * and what lies in a rectangle of it (frame pixels). Panes in the page itself need none: the layer reads the page.
 */
export type FrameHandle = {
	readonly selection: () => string;
	readonly describe: (rect: { x: number; y: number; width: number; height: number }) => Promise<string>;
};

/** The views plugin's page state as other plugins use it. */
export type ViewsPage = {
	/** Opens a view in the session (for everyone in it) and shows it in front on this device. */
	readonly open: (editor: HeldIn<typeof Views, "editor">, session: string, input: OpenInput) => Promise<void>;
	/** Whether the person is annotating now (a selection then is what a comment quotes, not the pane's selection). */
	readonly annotating: () => boolean;
	/** Registers the frame handle of view `view`'s pane; the returned function removes it. */
	readonly frame: (view: string, handle: FrameHandle) => () => void;
	/** Notes the person's newest text selection (empty text: none) in pane `view`: what Comment and Remove mark up. */
	readonly noteSelection: (view: string, quote: string) => void;
};

/** The views plugin's page state, under the key `views` (served and filled by the views plugin's web facet). */
export const ViewsPages = keyedRegistry<ViewsPage>("p2.views-page");
