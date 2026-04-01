import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.js";
import { SelectList } from "../src/components/select-list.js";
import type { Terminal } from "../src/terminal.js";
import { type Component, Container, TUI, visibleWidth } from "../src/tui.js";
import { defaultSelectListTheme } from "./test-themes.js";

class RecordingTerminal implements Terminal {
	constructor(
		private readonly _columns: number,
		private readonly _rows: number,
	) {}

	public writes: string[] = [];

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

class MutableLine implements Component {
	constructor(public line: string) {}

	render(_width: number): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

const forceRender = (ui: TUI): void => {
	(ui as unknown as { doRender: () => void }).doRender();
};

describe("TUI width safety", () => {
	it("keeps SelectList rows within terminal width for wide characters", () => {
		const list = new SelectList(
			[
				{ value: "1", label: "你好你好你好", description: "宽字符描述宽字符描述" },
				{ value: "2", label: "plain", description: "plain desc" },
			],
			5,
			defaultSelectListTheme,
			30,
		);

		const lines = list.render(12);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= 12,
				`expected width <= 12, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
			);
		}
	});

	it("keeps Input rows within terminal width for wide characters", () => {
		const input = new Input();
		input.setValue("你你你你你你你你你你");

		const lines = input.render(12);
		assert.strictEqual(lines.length, 1);
		assert.ok(visibleWidth(lines[0] ?? "") <= 12, lines[0]);
	});

	it("does not throw on diff render when a changed line exceeds width before clamping", () => {
		const terminal = new RecordingTerminal(12, 6);
		const ui = new TUI(terminal);
		const root = new Container();
		const line = new MutableLine("ok");
		root.addChild(line);
		ui.addChild(root);

		forceRender(ui);

		line.line = "你好你好你好好";
		assert.doesNotThrow(() => forceRender(ui));
		assert.ok(terminal.writes.length >= 2);
	});
});
