// Browser-only component fixture, bundled by `Browser.loadFixture` into a disposable localhost page: a file or patch's
// lines in `LinesBlock`, highlighted.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { LinesBlock, patchLines, textLines } from "../../src/web/Code.tsx";

const element = document.createElement("div");
document.body.replaceChildren(element);
const root = createRoot(element);
Object.assign(window, {
	showFile(text: string, language: string) {
		root.render(createElement(LinesBlock, { lines: textLines(text), language }));
	},
	showPatch(patch: string, language: string) {
		root.render(createElement(LinesBlock, { lines: patchLines(patch), language }));
	},
});
