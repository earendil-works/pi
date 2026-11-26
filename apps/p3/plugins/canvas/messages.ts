// The canvas plugin's texts people see: its ticks' labels (flag ticks among them) (decision 65), as the things plugin's Settings
// view shows them. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The canvas plugin's messages, by key. */
export const messages = defineMessages("canvas", {
	en: {
		tickDraw: "Draw",
		tickModerate: "Moderate",
		tickExport: "Export as an image",
		tickRemoveAny: "Remove anyone's shapes",
	},
});
