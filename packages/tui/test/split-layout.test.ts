import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { Text, TUI } from "../src/index.ts";

// Mock terminal for testing
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
		drainInput: async () => {},
		hideCursor: () => {},
		showCursor: () => {},
		moveBy: (_lines: number) => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: (_title: string) => {},
		setProgress: (_active: boolean) => {},
		get kittyProtocolActive() {
			return false;
		},
		getWritten: () => written,
		reset: () => {
			written = "";
		},
	};
}

describe("SplitLayout", () => {
	it("renders left and right panels side by side", () => {
		const terminal = createMockTerminal(80, 24) as any;
		const tui = new TUI(terminal);

		const left = new Text("Left Content", 0, 0);
		const right = new Text("Right Content", 0, 0);

		tui.addChild(left);
		tui.setSplitLayout(0.6, right);

		const lines = tui.render(80);
		ok(lines.length > 0, "Should produce lines");

		const firstLine = lines[0]!;
		ok(firstLine.includes("Left Content"), "Left content present");
		ok(firstLine.includes("\u2502"), "Divider present");
		ok(firstLine.includes("Right Content"), "Right content present");
	});

	it("pads shorter side with empty lines", () => {
		const terminal = createMockTerminal(80, 24) as any;
		const tui = new TUI(terminal);

		const left = new Text("Line 1\nLine 2\nLine 3", 0, 0);
		const right = new Text("Single Line", 0, 0);

		tui.addChild(left);
		tui.setSplitLayout(0.6, right);

		const lines = tui.render(80);
		ok(lines.length >= 3, "Should have at least 3 lines");
		ok(lines[1]!.includes("Line 2"), "Second left line present");
		ok(lines[1]!.includes("\u2502"), "Divider on second line");
	});

	it("clearSplitLayout restores normal rendering", () => {
		const terminal = createMockTerminal(80, 24) as any;
		const tui = new TUI(terminal);

		const left = new Text("Normal Content", 0, 0);
		tui.addChild(left);
		tui.setSplitLayout(0.6, new Text("", 0, 0));

		const splitLines = tui.render(80);
		const splitFirst = splitLines[0]!;
		ok(splitFirst.includes("\u2502"), "Is in split mode");

		tui.clearSplitLayout();
		const normalLines = tui.render(80);
		const normalFirst = normalLines[0]!;
		ok(!normalFirst.includes("\u2502"), "Split mode cleared");
	});

	it("falls back to full width when terminal is too narrow", () => {
		const terminal = createMockTerminal(15, 24) as any;
		const tui = new TUI(terminal);

		const left = new Text("Content", 0, 0);
		tui.addChild(left);
		tui.setSplitLayout(0.6, new Text("", 0, 0));

		const lines = tui.render(15);
		ok(lines[0]!.includes("Content"), "Content rendered");
		ok(!lines[0]!.includes("\u2502"), "No divider in narrow terminal");
	});
});
