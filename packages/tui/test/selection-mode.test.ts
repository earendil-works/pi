import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import type { Component } from "../src/tui.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class RecordingTerminal implements Terminal {
	private _columns: number;
	private _rows: number;
	public readonly writes: string[] = [];

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

class MutableText implements Component {
	constructor(private text: string) {}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
}

class SpyEditor extends Editor {
	public readonly seenInputs: string[] = [];

	wantsMouseTracking(): boolean {
		return true;
	}

	override handleInput(data: string): void {
		this.seenInputs.push(data);
		super.handleInput(data);
	}
}

describe("TUI selection mode", () => {
	it("forces mouse tracking off even when the focused component wants it", () => {
		const terminal = new RecordingTerminal(80, 24);
		const ui = new TUI(terminal);
		const editor = new SpyEditor(defaultEditorTheme);

		ui.addChild(new Text("chat 0", 0, 0));
		ui.setFocus(editor);
		ui.start();
		ui.enterSelectionMode();

		const joined = terminal.writes.join("");
		assert.equal(ui.isSelectionMode(), true);
		assert.equal(
			joined.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"),
			true,
			"expected normal focus to enable mouse tracking before selection mode",
		);
		assert.equal(
			joined.includes("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l"),
			true,
			"expected entering selection mode to disable mouse tracking",
		);
	});

	it("defers renders until selection mode exits", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const ui = new TUI(terminal);
		const text = new MutableText("before");

		ui.addChild(text);
		ui.start();
		await terminal.flush();
		assert.equal(terminal.getViewport()[0]?.trim(), "before");

		ui.enterSelectionMode();
		text.setText("after");
		ui.requestRender();
		await terminal.flush();
		assert.equal(terminal.getViewport()[0]?.trim(), "before");

		ui.exitSelectionMode();
		await terminal.flush();
		assert.equal(terminal.getViewport()[0]?.trim(), "after");
	});

	it("ignores focused input until escape exits selection mode", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const editor = new SpyEditor(defaultEditorTheme);

		ui.addChild(editor);
		ui.setFocus(editor);
		ui.start();
		await terminal.flush();

		ui.enterSelectionMode();
		terminal.sendInput("abc");
		await terminal.flush();

		assert.deepEqual(editor.seenInputs, []);
		assert.equal(ui.isSelectionMode(), true);

		terminal.sendInput("\x1b");
		await terminal.flush();
		assert.equal(ui.isSelectionMode(), false);

		terminal.sendInput("z");
		await terminal.flush();
		assert.deepEqual(editor.seenInputs, ["z"]);
	});
});
