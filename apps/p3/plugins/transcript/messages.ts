// The transcript plugin's texts on the page (decision 65): its view's title under "Open with…", its pane's tab, and
// the transcript's and the composer's texts.

import { defineMessages } from "@earendil-works/p3/v1";

/** The transcript plugin's messages, by key. */
export const messages = defineMessages("transcript", {
	en: {
		view: "Transcript",
		pane: "Transcript",
		denied: "You have no access to this session.",
		ended: "This conversation ended.",
		loadEarlier: "Load earlier",
		empty: "Nothing here yet.",
		loading: "Loading…",
		reconnecting: "Reconnecting…",
		broken: (reason: string) => `This session cannot be opened: ${reason}`,
		summarized: "Earlier messages were summarized.",
		newContext: "A new context starts here.",
		stopped: "Stopped.",
		failed: "Failed.",
		thinking: "Thinking",
		message: "Message",
		send: "Send",
		stop: "Stop",
	},
});
