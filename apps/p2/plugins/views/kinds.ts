// The web's view kinds (the registry itself is the API's, `src/web/view-kinds.ts`, so any plugin's web facet can add
// a kind), and what the annotation layer asks of panes that are frames of their own.

import type { FrameHandle } from "./contract.web.ts";

export { type PaneProps, ViewKinds } from "@p2/app/v1/web";

/** The frame handles of the panes on screen, by view ID. */
export const frameHandles = new Map<string, FrameHandle>();

/** The text the person selected last in any pane, frames included: what Comment and Remove mark up. */
let lastSelection: { view: string; quote: string; at: number } | undefined;
/** A selection older than this is forgotten: the person moved on. */
const SELECTION_TTL = 120_000;

/** Notes the person's newest text selection (empty text: none) in pane `view`. */
export function noteSelection(view: string, quote: string): void {
	const text = quote.trim();
	if (text) lastSelection = { view, quote: text.slice(0, 4000), at: Date.now() };
}

/** The newest text selection, taken: a second Comment needs a new one. */
export function takeSelection(): { view: string; quote: string } | undefined {
	const taken = lastSelection;
	lastSelection = undefined;
	return taken && Date.now() - taken.at < SELECTION_TTL ? { view: taken.view, quote: taken.quote } : undefined;
}
