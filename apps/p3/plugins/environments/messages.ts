// The environments plugin's texts people see: the machine kind's tick (decision 65), as the things plugin's Settings
// view shows it, and what a refused machine says. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The environments plugin's messages, by key. */
export const messages = defineMessages("environments", {
	en: {
		tickWork: "Work here",
		notHere: "This machine is not available here.",
		noWork: "Agents may not work on this machine here.",
		noTerminals: "Terminals on this machine are not there yet.",
		tooMany: "Too many terminals are open here; close one first.",
	},
});
