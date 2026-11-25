// The coding tools' TUI facet: their cards in the transcript, as pi draws them (cards.ts; bash with the shared shell
// card).
import { contribute, defineFacet } from "@p2/app/v1";
import { createShellRenderers, TuiToolRenderers } from "@p2/app/v1/tui";
import { editRenderers, findRenderers, grepRenderers, lsRenderers, readRenderers, writeRenderers } from "./cards.ts";

/** The coding tools' cards, by tool name. */
export const codingToolRenderers = {
	read: readRenderers,
	bash: createShellRenderers("$"),
	edit: editRenderers,
	write: writeRenderers,
	grep: grepRenderers,
	find: findRenderers,
	ls: lsRenderers,
};

export default defineFacet((host) => {
	contribute(host, "p2.tui-coding-tools", (self) => {
		self.contribute(TuiToolRenderers, codingToolRenderers);
	});
});
