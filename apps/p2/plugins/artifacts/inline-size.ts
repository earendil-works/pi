// Inline artifacts' heights: what a card in the transcript last measured for each artifact, so a pane mounted again
// (scrolled back into view, its row drawn again) starts at that height instead of collapsing and pushing the transcript
// around; and the channel through which a pane, shown inline, reports its real height once it has it.
import type { Host } from "@p2/app/v1";
import { createContext } from "react";

/** What an inline card gives its pane: the height it last had, and where to report the real one. */
export type InlineSize = {
	/** The pane's last known height, in CSS pixels, if it was shown before. */
	readonly initial: number | undefined;
	/** The pane's real height, once its content is drawn (an html page's reported size, a document rendered). */
	readonly report: (height: number) => void;
};

/** Set by an inline card around its pane; absent beside the transcript. */
export const InlineSizeContext = createContext<InlineSize | undefined>(undefined);

// Owned by the page's host: the heights go with it (sign-out, reload); one number per inline artifact seen meanwhile.
const remembered = new WeakMap<Host, Map<string, number>>();

/** The heights the inline cards of `host`'s page measured, by `<session>/<artifact>`. */
export function inlineHeights(host: Host): Map<string, number> {
	let heights = remembered.get(host);
	if (!heights) {
		heights = new Map();
		remembered.set(host, heights);
	}
	return heights;
}
