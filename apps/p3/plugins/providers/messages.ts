// The providers plugin's texts people see (decision 65): its kind's title and its tick's label, as the things plugin's
// Settings view shows it, and why a sign-in ended. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The providers plugin's messages, by key. */
export const messages = defineMessages("providers", {
	en: {
		kindLogin: "Model sign-in",
		tickUse: "Use its models",
		failed: "The sign-in failed. Check what you entered and try again.",
		expired: "The sign-in took too long. Start it again.",
		stopped: "Sign-in cancelled: the server stopped.",
	},
});
