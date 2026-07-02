import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

describe("TUI sticky bottom", () => {
	it("keeps boundary component and following siblings fixed at the bottom", () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const history = new TestComponent(["h0", "h1", "h2", "h3", "h4", "h5"]);
		const editor = new TestComponent(["editor"]);
		const footer = new TestComponent(["footer"]);

		tui.addChild(history);
		tui.addChild(editor);
		tui.addChild(footer);
		tui.setStickyBottomStart(editor);

		assert.deepStrictEqual(tui.render(40), ["h3", "h4", "h5", "editor", "footer"]);
	});

	it("scrolls only the history area with PageUp/PageDown", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const history = new TestComponent(["h0", "h1", "h2", "h3", "h4", "h5"]);
		const editor = new TestComponent(["editor"]);
		const footer = new TestComponent(["footer"]);

		tui.addChild(history);
		tui.addChild(editor);
		tui.addChild(footer);
		tui.setStickyBottomStart(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.render(40), ["h1", "h2", "h3", "editor", "footer"]);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.render(40), ["h3", "h4", "h5", "editor", "footer"]);

		tui.stop();
	});

	it("keeps the viewed history stable when new lines append while scrolled up", () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const history = new TestComponent(["h0", "h1", "h2", "h3", "h4", "h5"]);
		const editor = new TestComponent(["editor"]);

		tui.addChild(history);
		tui.addChild(editor);
		tui.setStickyBottomStart(editor);
		terminal.sendInput("\x1b[5~");
		// Direct input is not connected until start(); exercise the render logic by using the private method at runtime.
		(tui as unknown as { scrollStickyViewport(delta: number): boolean }).scrollStickyViewport(2);
		assert.deepStrictEqual(tui.render(40), ["h0", "h1", "h2", "h3", "editor"]);

		history.setLines(["h0", "h1", "h2", "h3", "h4", "h5", "h6"]);
		assert.deepStrictEqual(tui.render(40), ["h0", "h1", "h2", "h3", "editor"]);
	});
});
