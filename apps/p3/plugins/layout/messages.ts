// The layout plugin's texts (decision 65): what its controls are called for those who listen to the page.

import { defineMessages } from "@earendil-works/p3/v1";

/** The layout plugin's messages, by key. */
export const messages = defineMessages("layout", {
	en: {
		resize: "Resize",
		close: (pane: string) => `Close ${pane}`,
	},
});
