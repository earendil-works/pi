import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { sliceByColumn, sliceWithWidth, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Regression context:
// A literal tab ("\t") was measured as 3 columns by visibleWidth()/truncateToWidth()
// but as 0 columns by graphemeWidth() (it matches \p{Control}). graphemeWidth() backs the
// column-slicing primitives used by the overlay compositor, so a tab in an overlay's
// content (e.g. tab-indented source shown in a popup) made the compositor under-measure
// the overlay by 3 per tab, append stray padding, and overflow the terminal width. The
// width guard then tripped (crash log: terminal width 179 vs rendered line width 182) and
// differential redraw smeared. A second issue: emitting a raw "\t" let the terminal expand
// it to its own tab stop (commonly 8), desyncing the physical render from the width model.

describe("tab width overflow regression", () => {
	it("measures a tab as 3 columns consistently across width primitives", () => {
		assert.strictEqual(visibleWidth("\t"), 3);
		assert.strictEqual(sliceWithWidth("\t", 0, 10, true).width, 3);

		// sliceWithWidth must agree with visibleWidth for mixed content.
		assert.strictEqual(sliceWithWidth("a\tb", 0, 10, true).width, visibleWidth("a\tb"));
		assert.strictEqual(visibleWidth("a\tb"), 5);
	});

	it("clips tab-bearing lines to the requested column budget (safeguard works)", () => {
		// 14 tabs == 42 columns under the 3-per-tab model. Slicing to 40 columns must not
		// exceed 40. Under the old (tab=0) accounting, sliceByColumn kept all 14 tabs and
		// returned a 42-column line, so the compositor's final safeguard failed to clip.
		const wide = "\t".repeat(14);
		assert.strictEqual(visibleWidth(wide), 42);
		const clipped = sliceByColumn(wide, 0, 40, true);
		assert.ok(visibleWidth(clipped) <= 40, `expected <= 40, got ${visibleWidth(clipped)}`);
	});
});

class StaticLines implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class StaticOverlay implements Component {
	private readonly line: string;
	constructor(line: string) {
		this.line = line;
	}
	render(): string[] {
		return [this.line];
	}
	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI overlay tab compositing", () => {
	it("does not overflow or wrap when an overlay line contains a tab", async () => {
		const width = 40;
		// Overlay content with a leading tab; 3 (tab) + 37 == exactly `width` columns.
		const overlayLine = `\t${"X".repeat(37)}`;
		assert.strictEqual(visibleWidth(overlayLine), width);

		const terminal = new VirtualTerminal(width, 6);
		const tui = new TUI(terminal);
		tui.addChild(new StaticLines(["B".repeat(width), "SENTINEL"]));
		tui.showOverlay(new StaticOverlay(overlayLine), { row: 0, col: 0, width });
		tui.start();
		await renderAndFlush(tui, terminal);

		const viewport = terminal.getViewport();
		const overlayRow = viewport[0] ?? "";

		// Tab must have been expanded to spaces before reaching the terminal.
		assert.ok(!overlayRow.includes("\t"), "raw tab leaked to terminal");
		// No physical overflow: the row fits within `width` columns...
		assert.ok(overlayRow.length <= width, `overlay row overflowed: ${overlayRow.length} > ${width}`);
		// ...rendered as 3 spaces of indent followed by the content.
		assert.strictEqual(overlayRow, `   ${"X".repeat(37)}`);
		// And the following line stayed on its own row (it was not pushed down by a wrap).
		assert.strictEqual(viewport[1], "SENTINEL");

		tui.stop();
	});
});
