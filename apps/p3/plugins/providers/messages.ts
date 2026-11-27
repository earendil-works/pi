// The providers plugin's texts people see (decision 65): its kinds' titles and their ticks' labels, as the things
// plugin's Settings view shows them, and why a sign-in ended. Imported by the contracts and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The providers plugin's messages, by key. */
export const messages = defineMessages("providers", {
	en: {
		kindLogin: "Model sign-in",
		kindModelSettings: "Model settings",
		tickUse: "Use its models",
		tickUseModelSettings: "Use these model settings",
		tickEditModelSettings: "Change these model settings",
		notInSession: "This session gives you nothing.",
		failed: "The sign-in failed. Check what you entered and try again.",
		expired: "The sign-in took too long. Start it again.",
		stopped: "Sign-in cancelled: the server stopped.",
	},
});
