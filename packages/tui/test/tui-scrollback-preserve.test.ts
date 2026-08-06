import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}
}

describe("TUI scrollback preservation", () => {
	// Regression test for conversation history disappearing from terminal scrollback.
	//
	// When a line above the previous viewport changes (e.g. streaming markdown
	// re-flowing while the message has grown past the visible area), the renderer
	// falls back to a full redraw. Previously this issued \x1b[3J unconditionally,
	// wiping the terminal's scrollback buffer and discarding any content the host
	// shell or earlier messages had placed there. Content-driven redraws must
	// preserve scrollback; only width changes (which invalidate prior wrapping)
	// should clear it.
	it("preserves shell scrollback across a content-driven full redraw", async () => {
		const terminal = new VirtualTerminal(40, 10);

		// Simulate pre-existing shell history: lines that the user's terminal
		// had in its scrollback before the TUI started. The TUI must not
		// destroy these on a content-driven redraw.
		for (let i = 0; i < 25; i++) {
			terminal.write(`shell-history-${i}\r\n`);
		}
		await terminal.waitForRender();

		const tui: TUI = new TuiMainScreen(terminal);
		const content = new Lines(Array.from({ length: 30 }, (_, i) => `Line ${i}`));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Trigger the `firstChanged < prevViewportTop` path by changing a line
		// that has scrolled above the visible viewport.
		content.setLines(Array.from({ length: 30 }, (_, i) => (i === 5 ? "Line 5 CHANGED" : `Line ${i}`)));
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "above-viewport change should trigger a full redraw");

		const scrollback = terminal.getScrollBuffer();
		const survivedLines = scrollback.filter((row) => row.includes("shell-history"));
		assert.ok(
			survivedLines.length > 0,
			`pre-TUI shell history should survive a content-driven redraw; none of the shell-history lines remained in scrollback`,
		);
		tui.stop();
	});

	// A viewport-only redraw writes only the last `height` lines of the document
	// so earlier content is not pushed into scrollback a second time.
	it("does not duplicate content into scrollback on a content-driven full redraw", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const content = new Lines(Array.from({ length: 30 }, (_, i) => `Line ${i}`));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const scrollbackBefore = terminal.getScrollBuffer();
		const topOfContentBefore = scrollbackBefore.filter((row) => row.includes("Line 0")).length;

		content.setLines(Array.from({ length: 30 }, (_, i) => (i === 5 ? "Line 5 CHANGED" : `Line ${i}`)));
		tui.requestRender();
		await terminal.waitForRender();

		const scrollbackAfter = terminal.getScrollBuffer();
		const topOfContentAfter = scrollbackAfter.filter((row) => row.includes("Line 0")).length;
		assert.ok(
			topOfContentAfter <= topOfContentBefore,
			"a viewport-only full redraw must not push duplicate copies of earlier content into scrollback",
		);
		tui.stop();
	});

	it("clears scrollback on width change (wrapping invalidates prior render)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		// Pre-existing shell history that becomes stale after a re-flow.
		for (let i = 0; i < 20; i++) {
			terminal.write(`shell-${i}\r\n`);
		}
		await terminal.waitForRender();

		const tui: TUI = new TuiMainScreen(terminal);
		const content = new Lines(Array.from({ length: 15 }, (_, i) => `Line ${i}`));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		terminal.resize(60, 10);
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		const survivedLines = scrollback.filter((row) => row.includes("shell-"));
		assert.ok(
			survivedLines.length === 0,
			"width change should clear stale scrollback since wrapping has changed",
		);
		tui.stop();
	});
});
