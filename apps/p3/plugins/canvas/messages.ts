// The canvas plugin's texts people see (decision 65): its ticks' labels (flag ticks among them), as the things plugin's
// Settings view shows them, its title in the add-thing picker and its view's title. Imported by the contract and by
// every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The canvas plugin's messages, by key. */
export const messages = defineMessages("canvas", {
	en: {
		tickDraw: "Draw",
		tickModerate: "Moderate",
		tickExport: "Export as an image",
		tickRemoveAny: "Remove anyone's shapes",
		plugin: "Canvas",
		viewBoard: "Board",
	},
});
