import assert from "node:assert";
import { describe, it } from "node:test";
import stripAnsi from "strip-ansi";
import { Editor } from "../src/components/editor.js";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import { Container, TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class CountingTerminal implements Terminal {
	public writes = 0;

	constructor(public inner: VirtualTerminal) {}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}

	stop(): void {
		this.inner.stop();
	}

	write(data: string): void {
		this.writes++;
		this.inner.write(data);
	}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return this.inner.rows;
	}

	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}

	hideCursor(): void {
		this.inner.hideCursor();
	}

	showCursor(): void {
		this.inner.showCursor();
	}

	clearLine(): void {
		this.inner.clearLine();
	}

	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}

	clearScreen(): void {
		this.inner.clearScreen();
	}
}

const waitForRenderTick = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};

const trimRight = (line: string): string => line.replace(/\s+$/g, "");

const expectedViewport = (ui: TUI, width: number, rows: number): string[] => {
	const lines = ui.render(width).map((line) => trimRight(stripAnsi(line)));
	if (lines.length >= rows) {
		return lines.slice(lines.length - rows);
	}
	return [...lines, ...Array.from({ length: rows - lines.length }, () => "")];
};

const getActualViewport = async (terminal: VirtualTerminal): Promise<string[]> => {
	await terminal.flush();
	return terminal.getViewport().map(trimRight);
};

const createResizeStormFixture = (): {
	ui: TUI;
	terminal: CountingTerminal;
	virtualTerminal: VirtualTerminal;
	editor: Editor;
} => {
	const virtualTerminal = new VirtualTerminal(48, 12);
	const terminal = new CountingTerminal(virtualTerminal);
	const ui = new TUI(terminal);

	const root = new Container();
	for (let i = 0; i < 20; i++) {
		root.addChild(new Text(`history ${String(i).padStart(2, "0")} ${"x".repeat(32)}`, 0, 0));
	}

	const editor = new Editor(defaultEditorTheme);
	editor.maxHeight = 10;
	editor.setText("Long editor content that wraps at width forty-eight and is easy to spot when rows become stale.");
	root.addChild(editor);

	ui.addChild(root);
	ui.setFocus(editor);

	return { ui, terminal, virtualTerminal, editor };
};

const sameFinalWidthResizeStorm = (terminal: VirtualTerminal): void => {
	for (const width of [120, 55, 100, 42, 95, 39, 110, 44, 88, 37, 90, 60, 75, 48]) {
		terminal.resize(width, 12);
	}
};

describe("TUI resize baseline invalidation", () => {
	it("fully redraws after a resize storm that ends at the original width", async () => {
		const { ui, terminal, virtualTerminal, editor } = createResizeStormFixture();

		ui.start();
		await waitForRenderTick();
		await virtualTerminal.flush();

		virtualTerminal.sendInput("a");
		await waitForRenderTick();
		await virtualTerminal.flush();

		const writesBeforeStorm = terminal.writes;
		sameFinalWidthResizeStorm(virtualTerminal);
		await waitForRenderTick();
		await virtualTerminal.flush();

		const actual = await getActualViewport(virtualTerminal);
		const expected = expectedViewport(ui, virtualTerminal.columns, virtualTerminal.rows);

		assert.ok(
			terminal.writes > writesBeforeStorm,
			"expected at least one redraw after resize events, even if final width matches previous width",
		);
		assert.deepStrictEqual(actual, expected);

		ui.stop();
		void editor;
	});

	it("keeps the viewport correct when typing after a same-final-width resize storm", async () => {
		const { ui, virtualTerminal } = createResizeStormFixture();

		ui.start();
		await waitForRenderTick();
		await virtualTerminal.flush();

		virtualTerminal.sendInput("a");
		await waitForRenderTick();
		await virtualTerminal.flush();

		sameFinalWidthResizeStorm(virtualTerminal);
		await waitForRenderTick();
		await virtualTerminal.flush();

		virtualTerminal.sendInput("b");
		await waitForRenderTick();
		await virtualTerminal.flush();

		const actual = await getActualViewport(virtualTerminal);
		const expected = expectedViewport(ui, virtualTerminal.columns, virtualTerminal.rows);

		assert.deepStrictEqual(actual, expected);

		ui.stop();
	});
});
