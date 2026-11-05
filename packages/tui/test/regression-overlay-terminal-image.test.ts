import assert from "node:assert";
import { describe, it } from "node:test";
import {
	deleteKittyImage,
	encodeITerm2,
	encodeKitty,
	isImageLine,
	registerKittyImageMetadata,
} from "../src/terminal-image.ts";
import { type Component, compositeTuiLine, TuiBase } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticComponent implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
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
	it("preserves the generic image-line compositing behavior", () => {
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 5, imageId: 1, moveCursor: false });

		assert.strictEqual(compositeTuiLine(imageLine, "PANEL", 10, 20, 100), imageLine);
	});

	it("hides a Kitty image when an overlay intersects a reserved row and column", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId: 2, moveCursor: false });
		const overlay = tui.showOverlay(new StaticComponent(["PANEL"]), { row: 1, col: 10, width: 20 });

		const result = tui.composite([imageLine, "", "", "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[0]), false);
		assert.ok(result[1].includes("PANEL"));

		overlay.setHidden(true);
		const restored = tui.composite([imageLine, "", "", "tail"], 100, 6);
		assert.strictEqual(isImageLine(restored[0]), true);
	});

	it("keeps a Kitty image when the overlay is horizontally disjoint", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId: 3, moveCursor: false });
		tui.showOverlay(new StaticComponent(["PANEL"]), { row: 1, col: 30, width: 20 });

		const result = tui.composite([imageLine, "", "", "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[0]), true);
		assert.ok(result[1].includes("PANEL"));
	});

	it("composites a disjoint overlay on a Kitty anchor row", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId: 4, moveCursor: false });
		tui.showOverlay(new StaticComponent(["PANEL"]), { row: 0, col: 30, width: 20 });

		const result = tui.composite([imageLine, "", "", "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[0]), true);
		assert.ok(result[0].includes("\x1b[31G"));
		assert.ok(result[0].includes("PANEL"));
	});

	it("hides an iTerm2 image when an overlay intersects a row above its anchor", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = `\x1b[2A${encodeITerm2("AAAA", { width: 20, height: 3 })}`;
		tui.showOverlay(new StaticComponent(["PANEL"]), { row: 0, col: 30, width: 20 });

		const result = tui.composite(["", "", imageLine, "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[2]), false);
		assert.ok(result[0].includes("PANEL"));
	});

	it("keeps an image visible behind an empty overlay", () => {
		const tui = new TestTui(new VirtualTerminal(100, 6));
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId: 5, moveCursor: false });
		tui.showOverlay(new StaticComponent([]), { row: 1, col: 10, width: 20 });

		const result = tui.composite([imageLine, "", "", "tail"], 100, 6);

		assert.strictEqual(isImageLine(result[0]), true);
	});

	it("deletes an obscured Kitty image and restores it after the overlay closes", async () => {
		const imageId = 6;
		registerKittyImageMetadata({ imageId, columns: 20, rows: 3, widthPx: 200, heightPx: 60 });
		const imageLine = encodeKitty("AAAA", { columns: 20, rows: 3, imageId, moveCursor: false });
		const terminal = new LoggingVirtualTerminal(100, 6);
		const tui = new TuiMainScreen(terminal);
		const content = new StaticComponent([imageLine, "", "", "tail"]);
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		terminal.clearWrites();
		const overlay = tui.showOverlay(new StaticComponent(["PANEL"]), { row: 1, col: 10, width: 20 });
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes(deleteKittyImage(imageId)));

		terminal.clearWrites();
		overlay.setHidden(true);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes(imageLine));
		tui.stop();
	});
});
