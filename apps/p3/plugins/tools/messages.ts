// The tools plugin's texts people see: the coding tools' title and tick labels (decision 65), as the things plugin's
// Settings view shows them. Imported by the contract.

import { defineMessages } from "@earendil-works/p3/v1";

/** The tools plugin's messages, by key. */
export const messages = defineMessages("tools", {
	en: {
		kindCoding: "Coding tools",
		tickRead: "Read files",
		tickWrite: "Write files",
		tickEdit: "Edit files",
		tickBash: "Run commands (can also change files)",
	},
});
