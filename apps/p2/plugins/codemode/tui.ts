// Code mode's TUI facet: its card in the transcript (card.ts), with the script's calls as nested.ts reads them.
import { contribute, defineFacet } from "@p2/app/v1";
import { type ToolRenderers, TuiToolRenderers } from "@p2/app/v1/tui";
import { codemodeCard } from "./card.ts";
import { scriptCalls } from "./nested.ts";

/** Code mode's card: the script, its calls (live, then its result's list) and what it printed. */
export const codemodeRenderers: ToolRenderers = { ...codemodeCard, nestedCalls: scriptCalls };

export default defineFacet((host) => {
	contribute(host, "p2.tui-codemode", (self) => {
		self.contribute(TuiToolRenderers, { codemode: codemodeRenderers });
	});
});
