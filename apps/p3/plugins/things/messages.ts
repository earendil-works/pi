// The things plugin's texts people see (decision 65: everything that reaches the UI is a message): what a denial
// says to the person denied, and what a refused write says to whoever made it. Every facet that renders imports it,
// and the server builds its messages as data (`messages.message("notGiven")`) for `deny` and `invalid`.

import { defineMessages } from "@earendil-works/p3/v1";

/** The things plugin's messages, by key. */
export const messages = defineMessages("things", {
	en: {
		notGiven: "You have no access to this here.",
		catchingUp: "This was just updated. Try again in a moment.",
		tickNotFor: (tick: string, party: string) => `${tick} cannot be given to ${party}.`,
		belowLink: (workspace: string) =>
			`This is linked in ${workspace}. Ticks are given there; here they can only be taken away.`,
		lastOwner: "A Pi needs at least one owner.",
		tickLink: "Link",
		tickHide: "Hide",
		tickConfigure: "Configure",
		tickManagePeople: "Manage people",
		tickManageAccess: "Manage access",
		mayNotMake: (kind: string) => `You may not make a ${kind} here.`,
		mayNotLink: "To link this here you need Link here and where it is linked now.",
		notLinkedHere: "This is not linked here.",
		fromAboveOnly: "Only what comes from above can be hidden here; unlink what is linked here.",
		leafHoldsNoWorkspaces: "A session holds no workspaces.",
		notYet: "This comes later.",
	},
});
