import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Container, Editor, Text, TUI } from "../src/index.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const KITTY_PREFIX = "\x1b_G";

function waitForRender(): Promise<void> {
	return new Promise((resolve) => {
		process.nextTick(() => {
			setTimeout(resolve, 30);
		});
	});
}

describe("Render work characterization", () => {
	let terminal: VirtualTerminal;

	before(() => {
		terminal = new VirtualTerminal(80, 24);
	});

	after(() => {
		// VirtualTerminal doesn't need explicit disposal
	});

	it("should bound per-keystroke work by viewport, not transcript size", async () => {
		const ui = new TUI(terminal);
		const chatContainer = new Container();
		const editorContainer = new Container();
		const editor = new Editor(ui, defaultEditorTheme);

		// Build a large transcript: 5000+ text lines + some fake images
		for (let i = 0; i < 4990; i++) {
			const msg = new Text(`Message ${i}: Lorem ipsum dolor sit amet.`);
			chatContainer.addChild(msg);
		}

		// Add a few fake kitty image lines (off-screen)
		for (let i = 0; i < 10; i++) {
			const fakeImage = new Text(
				`${KITTY_PREFIX}a=T,f=100,i=${i},s=1,v=1,t=d,C=1;${Buffer.from("fake").toString("base64")}\x1b\\`,
			);
			chatContainer.addChild(fakeImage);
		}

		// Small editor at bottom
		editor.setText("hello");
		editorContainer.addChild(editor);

		ui.addChild(chatContainer);
		ui.addChild(editorContainer);

		// Start the UI and trigger initial render
		ui.start();
		ui.requestRender();
		await waitForRender();

		// Verify we have a large transcript
		const viewportHeight = terminal.rows;
		assert(ui.lastRenderStats, "Render stats should be populated after first render");
		const initialStats = ui.lastRenderStats;
		assert(initialStats.totalLines > 5000, `Total lines should be > 5000, got ${initialStats.totalLines}`);

		// Simulate a keystroke: modify the editor
		editor.setText("hello world");
		ui.requestRender();
		await waitForRender();

		// Check per-keystroke work via render stats
		assert(ui.lastRenderStats, "Render stats should be populated after keystroke");
		const keystrokeStats = ui.lastRenderStats;

		// After T003 fix: processedLines should be ~viewport height, not totalLines.
		const maxExpectedWork = viewportHeight * 3; // viewport + reasonable margin

		// T003 assertion: processedLines is viewport-bounded
		assert(
			keystrokeStats.processedLines <= maxExpectedWork,
			`Per-keystroke processedLines is ${keystrokeStats.processedLines} ` +
				`(totalLines=${keystrokeStats.totalLines}), exceeding the expected viewport-bounded ` +
				`work of ~${maxExpectedWork} lines.`,
		);

		// T005 assertion: resetAllocs should also be bounded (only non-committed, non-image lines)
		// With 5000 text lines + 10 images, and ~24 processedLines, resetAllocs should be ~24 (minus images)
		assert(
			keystrokeStats.resetAllocs <= maxExpectedWork,
			`Per-keystroke resetAllocs is ${keystrokeStats.resetAllocs}, should be bounded by ~${maxExpectedWork}`,
		);

		ui.stop();
	});

	it("small transcript should have bounded work (control case)", () => {
		const ui = new TUI(terminal);
		const editor = new Editor(ui, defaultEditorTheme);
		editor.setText("hello");
		ui.addChild(editor);

		const lines = ui.render(terminal.cols);
		assert(lines.length < 50, "Small transcript should have few lines");
		// For small transcripts, even full processing is acceptable
		assert(lines.length > 0, "Should have some lines");
	});
});
