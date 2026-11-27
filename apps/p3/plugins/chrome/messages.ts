// The chrome's texts (decision 65): the bar, the person menu, the gear and the corner button, the landing, `/me`, and
// what a view that throws shows.

import { defineMessages } from "@earendil-works/p3/v1";

/** The chrome's messages, by key. */
export const messages = defineMessages("chrome", {
	en: {
		connected: "Connected",
		connecting: "Connecting…",
		offline: "Offline",
		signedInAs: (name: string) => `Signed in as ${name}`,
		me: "Me",
		settings: "Settings",
		back: "Back",
		navigator: "Navigator",
		menu: "Menu",
		nothingYet: "There is nothing for you on this Pi yet.",
		notFound: "There is nothing at this address.",
		stopped: "This view stopped with an error.",
		meTitle: "Me",
		meHint: "Only you see this page.",
	},
});
