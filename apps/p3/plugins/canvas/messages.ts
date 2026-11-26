// The canvas plugin's texts people see (decision 65): its ticks' labels (flag ticks among them), as the things plugin's
// Settings view shows them, its title in the add-thing picker, its view's title and the board view's texts. Imported by the contract and by
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
		untitled: "Canvas",
		canvas: "Canvas",
		denied: "You may not see this canvas.",
		unavailable: "This canvas cannot be shown now.",
		loading: "Loading…",
		viewOnly: "View only",
		tool: "Tool",
		pen: "Pen",
		box: "Box",
		text: "Text",
		colour: "Colour",
		ink: "Ink",
		red: "Red",
		blue: "Blue",
		green: "Green",
		orange: "Orange",
		undo: "Undo",
		clear: "Clear",
		textToPlace: "Text to place",
		textHint: "Type, then tap the board",
		drawing: "Drawing",
	},
});
