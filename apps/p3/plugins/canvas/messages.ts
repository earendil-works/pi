// The canvas plugin's texts people see (decision 65): its ticks' labels (a flag tick among them), as the things
// plugin's Settings view shows them, its title (the plugin's and the kind's: `canvas`; `untitled` names a board without
// a name), the board view's texts and the refusals a person can cause. Imported by the kind, the store and every facet
// that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The canvas plugin's messages, by key. */
export const messages = defineMessages("canvas", {
	en: {
		tickDraw: "Draw",
		tickModerate: "Moderate",
		tickRemoveAny: "Remove anyone's shapes",
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
		someone: "Someone",
		byAgent: "An agent",
		byPi: "Pi",
		noShape: "This shape is not here any more.",
		notYours: "Someone else drew this shape.",
		gone: "This canvas does not exist any more.",
		full: (max: number) => `This canvas is full: it holds ${max} shapes at most.`,
	},
});
