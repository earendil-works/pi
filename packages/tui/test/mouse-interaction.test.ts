import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Viewport } from "../src/components/viewport.ts";
import { type Component, Container, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

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

describe("TUI mouse interaction", () => {
	it("routes a terminal click through a fixed viewport into the editor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, theme);
		editor.setText("abcdef");
		const fixed = new Container();
		fixed.addChild(editor);
		const viewport = new Viewport({
			content: new TestComponent(Array.from({ length: 8 }, (_, index) => `history ${index}`)),
			fixed,
			getHeight: () => terminal.rows,
		});
		tui.addChild(viewport);
		tui.setFocus(editor);
		tui.setMouseTracking(true);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;4;5M");
		await terminal.waitForRender();

		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		tui.stop();
	});
});
