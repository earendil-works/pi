// Browser-only component fixture, bundled by `Browser.loadFixture` into a disposable localhost page: a long transcript
// in which rendering a row at the start of the rendered range moves the scroll position down by a few pixels and
// dropping it moves it back, as the browser's scroll anchoring did for a row of a real transcript. The range follows
// the scroll position, so this is the feedback a virtual list must not keep repeating.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Transcript } from "../../src/web/transcript.ts";
import { TranscriptFixture } from "./transcript.ts";

const SHIFT = 9;
// A viewport-high column, as the app's, so the transcript scrolls.
const element = document.createElement("div");
element.style.cssText = "height: 100vh; display: flex; flex-direction: column";
document.body.replaceChildren(element);
new MutationObserver((records) => {
	const scroller = document.querySelector<HTMLElement>(".scroller");
	if (!scroller) return;
	for (const record of records) {
		const atStart = record.previousSibling instanceof HTMLElement && record.previousSibling.matches(".row-space");
		if (!atStart) continue;
		for (const node of record.addedNodes)
			if (node instanceof HTMLElement && node.matches(".row")) scroller.scrollTop += SHIFT;
		for (const node of record.removedNodes)
			if (node instanceof HTMLElement && node.matches(".row")) scroller.scrollTop -= SHIFT;
	}
}).observe(element, { childList: true, subtree: true });
const root = createRoot(element);
const transcript: Transcript = {
	items: Array.from({ length: 300 }, (_, index) => ({
		type: "marker" as const,
		key: String(index + 1),
		label: `Marker ${index + 1}`,
	})),
	earlier: false,
	busy: false,
	working: false,
	compactions: [],
	queued: [],
	agent: {} as Transcript["agent"],
};
Object.assign(window, {
	showEdgeRows() {
		root.render(createElement(TranscriptFixture, { transcript }));
	},
});
