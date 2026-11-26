// The providers plugin's texts people see (decision 65): its ticks' labels, as the things plugin's Settings view shows
// them, and what a sign-in tells the person signing in. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The providers plugin's messages, by key. */
export const messages = defineMessages("providers", {
	en: {
		tickUse: "Use its models",
		signedIn: "Signed in.",
		cancelled: "Sign-in cancelled.",
		replaced: "Replaced by a new sign-in.",
		expired: "The sign-in took too long. Start it again.",
		stopped: "Sign-in cancelled: the server stopped.",
		failed: (why: string) => `Sign-in failed: ${why}`,
	},
});
