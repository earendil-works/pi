// The terminals plugin's texts people see: its ticks' labels (decision 65), as the things plugin's Settings view shows
// them, what a refused call says, and the terminal pane's labels. Imported by the contract and by every facet that
// renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The terminals plugin's messages, by key. */
export const messages = defineMessages("terminals", {
	en: {
		tickWatch: "Watch",
		tickUse: "Use",
		notAbsolute: "A folder starts at the machine's root (/).",
		noTerminal: "This terminal does not exist here.",
		notRunning: "This terminal's program has ended.",
		noHost: "Terminals cannot be reached now.",
		pane: "Terminals",
		open: "New terminal",
		close: "Close",
		none: "No terminals are open here.",
		loading: "Loading…",
		denied: "You may not watch terminals here.",
		unavailable: "Terminals cannot be shown now.",
		ended: (code: number) => `Ended with code ${code}.`,
	},
});
