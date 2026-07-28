import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const theme = {
	borderColor: (value: string) => value,
	selectList: {
		selectedPrefix: (value: string) => value,
		selectedText: (value: string) => value,
		description: (value: string) => value,
		scrollInfo: (value: string) => value,
		noMatch: (value: string) => value,
	},
};

const leftClick = (x: number, y: number) => ({
	type: "press" as const,
	button: "left" as const,
	x,
	y,
	shift: false,
	alt: false,
	ctrl: false,
});

describe("Editor mouse positioning", () => {
	it("places the caret at the clicked text column", () => {
		const tui = new TUI(new VirtualTerminal(20, 10));
		const editor = new Editor(tui, theme);
		editor.setText("hello world");
		editor.render(20);

		assert.strictEqual(editor.handleMouse(leftClick(5, 1)), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
	});

	it("accounts for editor padding", () => {
		const tui = new TUI(new VirtualTerminal(20, 10));
		const editor = new Editor(tui, theme, { paddingX: 2 });
		editor.setText("hello");
		editor.render(20);

		editor.handleMouse(leftClick(4, 1));
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("maps clicks on wrapped visual lines back to the logical line", () => {
		const tui = new TUI(new VirtualTerminal(6, 10));
		const editor = new Editor(tui, theme);
		editor.setText("abcdefgh");
		editor.render(6);

		editor.handleMouse(leftClick(2, 2));
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });
	});

	it("places the caret after a wide grapheme when its second cell is clicked", () => {
		const tui = new TUI(new VirtualTerminal(20, 10));
		const editor = new Editor(tui, theme);
		editor.setText("a🙂b");
		editor.render(20);

		editor.handleMouse(leftClick(2, 1));
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
	});

	it("accounts for the editor's internal vertical scroll", () => {
		const tui = new TUI(new VirtualTerminal(20, 10));
		const editor = new Editor(tui, theme);
		editor.setText(Array.from({ length: 7 }, (_, index) => `line ${index}`).join("\n"));
		editor.render(20);

		editor.handleMouse(leftClick(2, 1));
		assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 2 });
	});

	it("ignores clicks on the border", () => {
		const tui = new TUI(new VirtualTerminal(20, 10));
		const editor = new Editor(tui, theme);
		editor.setText("hello");
		editor.render(20);

		assert.strictEqual(editor.handleMouse(leftClick(2, 0)), false);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
	});
});
