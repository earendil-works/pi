import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import type { Component } from "../src/tui.js";
import { Container, TUI } from "../src/tui.js";
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

class StaticDialog implements Component {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class OverlayEditorDialog implements Component {
	readonly editor: Editor;

	constructor() {
		this.editor = new Editor(defaultEditorTheme);
		this.editor.maxHeight = 4;
		this.editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
		for (let i = 0; i < 30; i++) {
			this.editor.handleInput("\x1b[A");
		}
	}

	render(width: number): string[] {
		return this.editor.render(width);
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

class SpyEditor extends Editor {
	public readonly seenInputs: string[] = [];

	override handleInput(data: string): void {
		this.seenInputs.push(data);
		super.handleInput(data);
	}
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

	it("routes a visible overlay scrollbar click to the centered editor", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const overlay = new OverlayEditorDialog();

		ui.setOverlay(overlay, { width: 20, minWidth: 20, maxWidth: 20, marginX: 6 });
		ui.setFocus(overlay);
		ui.start();

		try {
			await terminal.flush();
			assert.strictEqual(overlay.editor.getScrollOffset(), 0);

			terminal.sendInput("\x1b[<0;50;12M");
			await terminal.flush();

			assert.ok(
				overlay.editor.getScrollOffset() > 0,
				"expected clicking the visible centered scrollbar to scroll the overlay editor",
			);
		} finally {
			ui.stop();
		}
	});

	it("enables mouse tracking in chat mode and keeps it available for overlay dialogs", () => {
		const terminal = new RecordingTerminal(80, 24);
		const ui = new TUI(terminal);
		const overlay = new OverlayEditorDialog();

		ui.addChild(new Text("chat 0", 0, 0));
		ui.setFocus(new SpyEditor(defaultEditorTheme));
		ui.start();

		assert.equal(
			terminal.writes.some((write) => write.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h")),
			true,
			"expected chat mode to enable mouse tracking so wheel input can reach the focused chat component",
		);

		ui.setOverlay(overlay, { width: 20, minWidth: 20, maxWidth: 20, marginX: 6 });
		ui.setFocus(overlay);

		assert.equal(
			terminal.writes.some((write) => write.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h")),
			true,
			"expected dialog mode to keep mouse tracking enabled for overlay interactions",
		);

		ui.clearOverlay();
		ui.setFocus(null);

		const disableWrites = terminal.writes.filter((write) =>
			write.includes("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l"),
		);
		assert.ok(disableWrites.length >= 1, "expected clearing focus after dialog mode to disable mouse tracking again");
	});

	it("routes mouse wheel input to the focused editor in chat mode", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const chat = new Container();
		for (let i = 0; i < 80; i++) {
			chat.addChild(new Text(`chat ${i}`, 0, 0));
		}
		const editor = new SpyEditor(defaultEditorTheme);

		ui.addChild(chat);
		ui.addChild(editor);
		ui.setFocus(editor);
		ui.start();

		try {
			await terminal.flush();

			terminal.sendInput("\x1b[<65;10;10M");
			await terminal.flush();

			assert.equal(
				editor.seenInputs.includes("\x1b[<65;10;10M"),
				true,
				"expected chat-mode wheel input to reach the focused editor again",
			);
		} finally {
			ui.stop();
		}
	});

	it("routes mouse wheel input to the overlay editor in dialog mode", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const mainEditor = new SpyEditor(defaultEditorTheme);
		const overlay = new OverlayEditorDialog();

		ui.addChild(new Text("chat 0", 0, 0));
		ui.addChild(mainEditor);
		ui.setOverlay(overlay, { width: 20, minWidth: 20, maxWidth: 20, marginX: 6 });
		ui.setFocus(overlay);
		ui.start();

		try {
			await terminal.flush();
			assert.strictEqual(overlay.editor.getScrollOffset(), 0);

			terminal.sendInput("\x1b[<65;50;12M");
			await terminal.flush();

			assert.equal(
				mainEditor.seenInputs.includes("\x1b[<65;50;12M"),
				false,
				"expected overlay-focused wheel input not to leak to the hidden main editor",
			);
			assert.ok(
				overlay.editor.getScrollOffset() > 0,
				"expected wheel input inside the dialog to scroll the overlay editor",
			);
		} finally {
			ui.stop();
		}
	});
});
