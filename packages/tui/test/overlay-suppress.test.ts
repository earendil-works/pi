import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SimpleContent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

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

/** Regression for #10667: modal dialogs (extension select/input) must temporarily hide overlays. */
describe("TUI suppressOverlays", () => {
	it("hides visible overlays while suppressed and restores exactly those after", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		const overlay = new SimpleOverlay();
		const handle = tui.showOverlay(overlay);
		tui.start();
		await terminal.waitForRender();

		// Suppression hides the overlay from the rendered screen.
		tui.suppressOverlays(true);
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("OVERLAY")), "overlay hidden while suppressed");
		assert.equal(handle.isHidden(), true);

		// Restore brings the same overlay back.
		tui.suppressOverlays(false);
		await terminal.waitForRender();
		assert.ok(
			terminal.getViewport().some((line) => line.includes("OVERLAY")),
			"overlay restored after suppression",
		);
		assert.equal(handle.isHidden(), false);

		tui.stop();
	});

	it("does not resurrect overlays that were hidden by their owner before suppression", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		const owner = new SimpleOverlay();
		const ownerHandle = tui.showOverlay(owner);
		ownerHandle.hide(); // owner closed its overlay permanently
		tui.start();
		await terminal.waitForRender();

		tui.suppressOverlays(true);
		tui.suppressOverlays(false);
		await terminal.waitForRender();

		assert.ok(!terminal.getViewport().some((line) => line.includes("OVERLAY")), "owner-hidden overlay stays hidden");
		tui.stop();
	});
});
