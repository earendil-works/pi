import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import type { Component } from "../src/tui.js";
import { Container, TUI } from "../src/tui.js";

class RecordingTerminal implements Terminal {
	private _columns: number;
	private _rows: number;

	constructor(columns: number, rows: number) {
		this._columns = columns;
		this._rows = rows;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	write(_data: string): void {}
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

class StaticDialog implements Component {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

describe("TUI overlay dialog", () => {
	it("renders a centered floating overlay without replacing the base content tree", () => {
		const ui = new TUI(new RecordingTerminal(40, 12));
		const base = new Container();
		base.addChild(new Text("chat 0", 0, 0));
		base.addChild(new Text("chat 1", 0, 0));
		base.addChild(new Text("chat 2", 0, 0));
		base.addChild(new Text("chat 3", 0, 0));
		ui.addChild(base);

		ui.setOverlay(new StaticDialog(["+----------+", "|   note   |", "+----------+"]), {
			width: 12,
			minWidth: 12,
			maxWidth: 12,
			marginX: 0,
		});

		const lines = ui.render(40);

		assert.equal(lines.length, 12);
		assert.equal(lines[0]?.trim(), "chat 0");
		assert.equal(lines[1]?.trim(), "chat 1");
		assert.equal(lines[4]?.indexOf("+----------+"), 14);
		assert.equal(lines[5]?.indexOf("|   note   |"), 14);
		assert.equal(lines[6]?.indexOf("+----------+"), 14);
		assert.equal(lines[11], "");
	});

	it("removes the floating overlay cleanly", () => {
		const ui = new TUI(new RecordingTerminal(40, 12));
		const base = new Container();
		base.addChild(new Text("chat 0", 0, 0));
		base.addChild(new Text("chat 1", 0, 0));
		ui.addChild(base);

		ui.setOverlay(new StaticDialog(["+--+"]), { width: 4, minWidth: 4, maxWidth: 4, marginX: 0 });
		assert.equal(
			ui.render(40).some((line) => line.includes("+--+")),
			true,
		);

		ui.clearOverlay();
		const lines = ui.render(40);
		assert.equal(lines.length, 2);
		assert.equal(
			lines.some((line) => line.includes("+--+")),
			false,
		);
		assert.equal(lines[0]?.trim(), "chat 0");
		assert.equal(lines[1]?.trim(), "chat 1");
	});
});
