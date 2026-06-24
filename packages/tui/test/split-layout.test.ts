import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { Text, TUI } from "../src/index.ts";

function createMockTerminal(columns = 80, rows = 24) {
	let written = "";
	return {
		columns,
		rows,
		write: (data: string) => {
			written += data;
		},
		start: () => {},
		stop: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		getWritten: () => written,
		reset: () => {
			written = "";
		},
	};
}

describe("SplitLayout", () => {
	it("full render cycle produces divider in terminal output", async () => {
		const terminal = createMockTerminal(80, 24) as any;
		const tui = new TUI(terminal);

		const left = new Text("Hello World", 0, 0);
		const right = new Text("Right Panel", 0, 0);

		tui.addChild(left);
		tui.setSplitLayout(0.6, right);

		// Wait for the async render scheduled by setSplitLayout
		await new Promise<void>((resolve) => process.nextTick(() => resolve()));

		const written = terminal.getWritten();
		ok(written.includes("│"), "Divider appears in terminal output");
		ok(written.includes("Right Panel"), "Right content appears in terminal output");
	});

	it("clearSplitLayout stops producing divider", async () => {
		const terminal = createMockTerminal(80, 24) as any;
		const tui = new TUI(terminal);

		const left = new Text("Hello", 0, 0);
		const right = new Text("Right", 0, 0);

		tui.addChild(left);
		tui.setSplitLayout(0.6, right);

		await new Promise<void>((resolve) => process.nextTick(() => resolve()));
		const withSplit = terminal.getWritten();
		ok(withSplit.includes("│"), "Divider present with split");

		terminal.reset();
		tui.clearSplitLayout();
		await new Promise<void>((resolve) => process.nextTick(() => resolve()));
		const afterClear = terminal.getWritten();
		ok(!afterClear.includes("│"), "No divider after clearSplitLayout");
	});

	it("render() returns full-width content (split applied only in doRender)", () => {
		const terminal = createMockTerminal(80, 24) as any;
		const tui = new TUI(terminal);

		const content = new Text("Normal Content", 0, 0);
		tui.addChild(content);

		const lines = tui.render(80);
		ok(lines.length > 0, "render() produces lines");
		ok(lines[0]!.includes("Normal Content"), "Content appears");
	});
});
