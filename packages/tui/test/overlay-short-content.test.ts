import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class SimpleContent implements Component {
	constructor(private lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

class SimpleOverlay implements Component {
	render(): string[] {
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	invalidate() {}
}

describe("TUI overlay with short content", () => {
	it("should render overlay when content is shorter than terminal height", async () => {
		// Terminal has 24 rows, but content only has 3 lines
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		// Only 3 lines of content
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		// Show overlay centered - should be around row 10 in a 24-row terminal
		const overlay = new SimpleOverlay();
		tui.showOverlay(overlay);

		// Trigger render
		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const hasOverlay = viewport.some((line) => line.includes("OVERLAY"));

		console.log("Terminal rows:", terminal.rows);
		console.log("Content lines: 3");
		console.log("Overlay visible:", hasOverlay);

		if (!hasOverlay) {
			console.log("\nViewport contents:");
			for (let i = 0; i < viewport.length; i++) {
				console.log(`  [${i}]: "${viewport[i]}"`);
			}
		}

		assert.ok(hasOverlay, "Overlay should be visible when content is shorter than terminal");

		tui.stop();
	});
});
