import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/**
 * Regression: when content is taller than the terminal and a component above
 * the visible viewport changes (e.g. the Loader spinner ticking while a tall
 * ui.custom dialog fills the screen), doRender() hit the
 * `firstChanged < prevViewportTop` branch and did a fullRender(true) on every
 * frame — manifesting as the screen "scrolling like crazy".
 */

class Lines implements Component {
	constructor(public lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

const tick = () => new Promise<void>((r) => process.nextTick(r));

describe("TUI differential render with offscreen changes", () => {
	it("does not full-redraw when the only change is above the viewport", async () => {
		const rows = 10;
		const terminal = new VirtualTerminal(80, rows);
		const tui = new TUI(terminal);

		// chat + spinner are pushed above the viewport by a tall dialog
		const spinner = new Lines(["⠋ Working"]);
		const dialog = new Lines(Array.from({ length: rows + 2 }, (_, i) => `dialog ${i}`));
		tui.addChild(new Lines(["chat 0", "chat 1", "chat 2"]));
		tui.addChild(spinner);
		tui.addChild(dialog);

		tui.start();
		await tick();
		await terminal.flush();

		const initialViewport = terminal.getViewport();
		assert.ok(!initialViewport.some((l) => l.includes("Working")), "precondition: spinner is offscreen");
		assert.ok(
			initialViewport.some((l) => l.includes(`dialog ${rows + 1}`)),
			"precondition: dialog bottom visible",
		);

		const redrawsBefore = tui.fullRedraws;

		for (const f of ["⠙", "⠹", "⠸", "⠼", "⠴"]) {
			spinner.lines = [`${f} Working`];
			tui.requestRender();
			await tick();
		}
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, redrawsBefore, "offscreen-only change must not trigger fullRender");
		assert.deepStrictEqual(terminal.getViewport(), initialViewport, "viewport must remain stable");

		tui.stop();
	});
});
