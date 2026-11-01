import assert from "node:assert";
import { describe, it } from "node:test";
import { encodeITerm2, encodeKitty, isImageLine } from "../src/terminal-image.ts";
import { type Component, compositeTuiLine, TuiBase } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class TestTui extends TuiBase {
	readonly mode = "regular" as const;

	protected doRender(): void {}

	composite(lines: string[], width: number, height: number): string[] {
		return this.compositeOverlays(lines, width, height);
	}
}

// Regression tests for https://github.com/earendil-works/pi/issues/11584
describe("overlays over terminal images", () => {
	it("composites an overlay over an image protocol line", () => {
		const imageLine = `${encodeKitty("AAAA", { columns: 20, rows: 5, imageId: 1, moveCursor: false })}${" ".repeat(80)}`;
		const result = compositeTuiLine(imageLine, "PANEL", 30, 40, 100);

		assert.strictEqual(isImageLine(result), false);
		assert.ok(result.includes("PANEL"));
	});

	it("hides a Kitty image when an overlay intersects a reserved row", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId: 2, moveCursor: false });
		const overlay = tui.showOverlay(new StaticOverlay(["PANEL"]), { row: 1, col: 30, width: 40 });

		const result = tui.composite([imageLine, "", "", "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[0]), false);
		assert.ok(result[1].includes("PANEL"));

		overlay.setHidden(true);
		const restored = tui.composite([imageLine, "", "", "tail"], 100, 6);
		assert.strictEqual(isImageLine(restored[0]), true);
	});

	it("hides an iTerm2 image when an overlay intersects a row above its anchor", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = `\x1b[2A${encodeITerm2("AAAA", { width: 20, height: 3 })}`;
		tui.showOverlay(new StaticOverlay(["PANEL"]), { row: 0, col: 30, width: 40 });

		const result = tui.composite(["", "", imageLine, "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[2]), false);
		assert.ok(result[0].includes("PANEL"));
	});

	it("keeps an image visible behind an empty overlay", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId: 3, moveCursor: false });
		tui.showOverlay(new StaticOverlay([]), { row: 1, col: 30, width: 40 });

		const result = tui.composite([imageLine, "", "", "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[0]), true);
	});
});
