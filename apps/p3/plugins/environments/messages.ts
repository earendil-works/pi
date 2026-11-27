// The environments plugin's texts people see: the machine kind's tick (decision 65), as the things plugin's Settings
// view shows it, the machine's view and titles, and what a refused machine says.
// Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The environments plugin's messages, by key. */
export const messages = defineMessages("environments", {
	en: {
		tickWork: "Work here",
		kind: "Machine",
		view: "Machine",
		plugin: "Machines",
		ready: "Ready.",
		unavailable: "Unavailable: its type is not installed.",
		unavailableView: "This machine cannot be shown now.",
		denied: "You may not see this machine.",
		loading: "Loading…",
		thisDevice: "This device",
		noType: (type: string) => `There is no machine type ${type} here.`,
		badSettings: (reason: string) => `These settings do not fit the machine type: ${reason}`,
		notHere: "This machine is not available here.",
		noWork: "Agents may not work on this machine here.",
		noTerminals: "Terminals on this machine are not there yet.",
		tooMany: "Too many terminals are open here; close one first.",
		ptyFailed: (reason: string) => `The terminal could not start: ${reason}`,
	},
});
