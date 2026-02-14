import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import { Container, TUI } from "../src/tui.js";

class RecordingTerminal implements Terminal {
	private _columns: number;
	private _rows: number;
	public writes: string[] = [];

	constructor(columns: number, rows: number) {
		this._columns = columns;
		this._rows = rows;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
}

const forceRender = (ui: TUI): void => {
	(ui as unknown as { doRender: () => void }).doRender();
};

describe("TUI diff rendering range", () => {
	it("does not repaint lines below the changed line (spinner above editor)", () => {
		const terminal = new RecordingTerminal(100, 40);
		const ui = new TUI(terminal);

		const root = new Container();
		for (let i = 0; i < 480; i++) {
			root.addChild(new Text(`static ${i} ${"x".repeat(40)}`, 0, 0));
		}
		const spinner = new Text("spinner: 0", 0, 0);
		root.addChild(spinner);
		for (let i = 0; i < 20; i++) {
			root.addChild(new Text(`editor ${i} ${"y".repeat(20)}`, 0, 0));
		}

		ui.addChild(root);
		forceRender(ui);

		spinner.setText("spinner: 1");
		forceRender(ui);

		const lastWrite = terminal.writes.at(-1) ?? "";
		assert.equal(lastWrite.includes("spinner: 1"), true);
		// Regression check: old renderer repaints everything below firstChanged, including the editor.
		assert.equal(lastWrite.includes("editor 0"), false);
	});

	it("does not repaint the editor when a streaming line above it changes", () => {
		const terminal = new RecordingTerminal(100, 40);
		const ui = new TUI(terminal);

		const root = new Container();
		for (let i = 0; i < 470; i++) {
			root.addChild(new Text(`chat ${i} ${"x".repeat(40)}`, 0, 0));
		}

		const streamLines: Text[] = [];
		for (let i = 0; i < 10; i++) {
			const line = new Text(`stream ${i}: ${"a".repeat(60)}`, 0, 0);
			streamLines.push(line);
			root.addChild(line);
		}

		for (let i = 0; i < 20; i++) {
			root.addChild(new Text(`editor ${i} ${"y".repeat(20)}`, 0, 0));
		}

		ui.addChild(root);
		forceRender(ui);

		streamLines[9]?.setText(`stream 9: ${"b".repeat(60)}`);
		forceRender(ui);

		const lastWrite = terminal.writes.at(-1) ?? "";
		assert.equal(lastWrite.includes("stream 9:"), true);
		assert.equal(lastWrite.includes("editor 0"), false);
	});
});
