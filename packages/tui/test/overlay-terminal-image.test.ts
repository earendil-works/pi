import assert from "node:assert";
import { describe, it } from "node:test";
import {
	deleteKittyImage,
	encodeITerm2,
	encodeKitty,
	getImageLineExtent,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import type { Component, OverlayOptions } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	writes = "";

	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}

const panel: Component = { render: () => ["PANEL"], invalidate: () => {} };

function staticComponent(lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

// Regression tests for #11584: overlays left a hole where they intersected a terminal image.
describe("overlays over terminal images", () => {
	it("deletes a Kitty image under an overlay and redraws it after the overlay closes", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		try {
			const image = encodeKitty("AAAA", { columns: 4, rows: 4, imageId: 11584, moveCursor: false });
			tui.addChild(staticComponent(["top", image, "", "", "", "bottom"]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			// Row 3 is the third image row, below the image line itself.
			const overlay = tui.showOverlay(panel, { row: 3, col: 2, width: 8 } satisfies OverlayOptions);
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(deleteKittyImage(11584)), "the covered image is deleted");
			assert.ok(!terminal.writes.includes("\x1b_Ga=T"), "the covered image is not drawn again");
			assert.strictEqual(terminal.getViewport()[3]?.trimEnd(), "  PANEL");

			terminal.writes = "";
			overlay.hide();
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(image), "the image is drawn again once uncovered");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("keeps images whose rows the overlay does not touch", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		try {
			const image = encodeKitty("AAAA", { columns: 4, rows: 2, imageId: 11585, moveCursor: false });
			tui.addChild(staticComponent([image, "", "text", "", "", ""]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			tui.showOverlay(panel, { row: 4, col: 0, width: 8 });
			await terminal.waitForRender();
			assert.ok(!terminal.writes.includes(deleteKittyImage(11585)));
			assert.strictEqual(terminal.getViewport()[4]?.trimEnd(), "PANEL");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("keeps an image beside an overlay that shares its rows", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		try {
			const image = encodeKitty("AAAA", { columns: 4, rows: 4, imageId: 11588, moveCursor: false });
			tui.addChild(staticComponent(["top", image, "", "", "", "bottom"]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			// A sidebar at columns 10-17 next to the image at columns 0-3.
			tui.showOverlay(staticComponent(["SIDE", "SIDE", "SIDE", "SIDE", "SIDE", "SIDE"]), {
				row: 0,
				col: 10,
				width: 8,
			});
			await terminal.waitForRender();
			// The main screen redraws an image whenever a row it covers changes, so it may delete it first.
			assert.ok(
				terminal.writes.lastIndexOf(image) > terminal.writes.lastIndexOf(deleteKittyImage(11588)),
				"the image beside the sidebar is drawn",
			);
			const viewport = terminal.getViewport();
			assert.strictEqual(viewport[2]?.slice(10).trimEnd(), "SIDE", "rows below the image line show the sidebar");
			// The image line itself still passes through, so the sidebar skips that row.
			assert.strictEqual(viewport[1]?.trim(), "");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("keeps a fullscreen image beside an overlay that shares its rows", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		try {
			const imageId = 11591;
			const image = encodeKitty("AAAA", { columns: 4, rows: 3, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 4, rows: 3, widthPx: 100, heightPx: 100 });
			tui.setLayoutRoot(staticComponent(["top", image, "", "", "after", ""]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			tui.showOverlay(staticComponent(["SIDE", "SIDE", "SIDE", "SIDE"]), { row: 1, col: 10, width: 8 });
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(`\x1b_Ga=p,q=2`), "the image is placed again after the redraw");
			assert.ok(terminal.writes.includes(`i=${imageId}`));
			assert.strictEqual(terminal.getViewport()[2]?.slice(10).trimEnd(), "SIDE");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("hides an image of unknown width under any overlay sharing its rows", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		try {
			// No `c=` and no registered metadata: the width cannot be read.
			const image = encodeKitty("AAAA", { rows: 2, imageId: 11589, moveCursor: false });
			tui.addChild(staticComponent(["top", image, "", "", "", ""]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			tui.showOverlay(panel, { row: 2, col: 15, width: 5 });
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(deleteKittyImage(11589)));
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("reads the cells an image line covers", () => {
		const kitty = `  ${encodeKitty("AAAA", { columns: 6, rows: 3, imageId: 11590, moveCursor: false })}`;
		assert.deepStrictEqual(getImageLineExtent(kitty), { firstRow: 0, lastRow: 2, startCol: 2, endCol: 8 });
		const iterm2 = `\x1b[2A${encodeITerm2("AAAA", { width: 5, height: "auto" })}`;
		assert.deepStrictEqual(getImageLineExtent(iterm2), { firstRow: -2, lastRow: 0, startCol: 0, endCol: 5 });
		const autoWidth = encodeITerm2("AAAA", { width: "50%", height: "auto" });
		assert.strictEqual(getImageLineExtent(autoWidth)?.endCol, Infinity);
		assert.strictEqual(getImageLineExtent("plain text"), undefined);
	});

	it("hides an image inside an overlay when a later overlay covers it", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		try {
			const image = encodeKitty("AAAA", { columns: 4, rows: 3, imageId: 11587, moveCursor: false });
			tui.addChild(staticComponent(["", "", "", "", "", ""]));
			tui.start();
			tui.showOverlay(staticComponent([image, "", ""]), { row: 0, col: 0, width: 10 });
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(image), "the overlay's own image is drawn");

			terminal.writes = "";
			tui.showOverlay(panel, { row: 2, col: 0, width: 8 });
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(deleteKittyImage(11587)), "the image under the top overlay is deleted");
			assert.strictEqual(terminal.getViewport()[2]?.trimEnd(), "PANEL");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("hides an iTerm2 image when an overlay covers rows above its image line", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		try {
			const image = `\x1b[2A${encodeITerm2("AAAA", { width: 4, height: "auto" })}`;
			tui.addChild(staticComponent(["top", "", "", image, "", "bottom"]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			const overlay = tui.showOverlay(panel, { row: 1, col: 0, width: 8 });
			await terminal.waitForRender();
			assert.ok(!terminal.writes.includes("\x1b]1337;File="), "the covered image is not drawn again");
			// xterm ignores the iTerm2 sequence but applies its cursor-up prefix, so check writes, not the viewport.
			assert.ok(terminal.writes.includes("PANEL"));

			terminal.writes = "";
			overlay.hide();
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes(image), "the image is drawn again once uncovered");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	it("removes Kitty placements in fullscreen mode while an overlay covers them", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		try {
			const imageId = 11586;
			const image = encodeKitty("AAAA", { columns: 4, rows: 3, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 4, rows: 3, widthPx: 100, heightPx: 100 });
			tui.setLayoutRoot(staticComponent(["top", image, "", "", "after", ""]));
			tui.start();
			await terminal.waitForRender();

			terminal.writes = "";
			const overlay = tui.showOverlay(panel, { row: 2, col: 1, width: 8 });
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes("\x1b_Ga=d,d=a,q=2\x1b\\"), "visible placements are deleted");
			assert.ok(!terminal.writes.includes(`i=${imageId}`), "the covered image is not placed again");
			assert.strictEqual(terminal.getViewport()[2]?.trimEnd(), " PANEL");

			terminal.writes = "";
			overlay.hide();
			await terminal.waitForRender();
			assert.ok(terminal.writes.includes("\x1b_Ga=p,q=2"), "the uploaded image is placed again");
			assert.ok(!terminal.writes.includes("\x1b_Ga=T"), "the image data is not uploaded again");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});
});
