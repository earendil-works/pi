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
		// No workspace named: the person may not be present where the thing is linked (decision 96).
		belowLink: "Ticks are given where this is linked; here they can only be taken away.",
		lastOwner: "A Pi needs at least one owner.",
		notOffered: "This person is not present where you are: invite them with a link.",
		groupNotManaged: "Only whoever manages this group may add people to it.",
		tickLink: "Link",
		tickHide: "Hide",
		tickConfigure: "Configure",
		tickManagePeople: "Manage people",
		tickManageAccess: "Manage access",
		mayNotMake: (kind: string) => `You may not make a ${kind} here.`,
		mayNotLink: "To link this here you need Link here and where it is linked now.",
		notLinkedHere: "This is not linked here.",
		fromAboveOnly: "Only what comes from above can be hidden here; unlink what is linked here.",
		leafHoldsNoWorkspaces: "This holds no workspaces.",
		notYet: "This comes later.",
		noAccessForAll:
			"No access takes out a person, a group or one agent. For everyone here or the agents, hide people from above instead.",
	},
});
