import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type Component,
	parseTerminalColorSchemeReport,
	type Terminal,
	type TerminalColors,
	type TUI,
	TuiMainScreen,
} from "../src/index.ts";
import { parseOscColorResponse } from "../src/terminal-colors.ts";

class TestTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private readonly columnCount: number;
	private readonly rowCount: number;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnCount;
	}

	get rows(): number {
		return this.rowCount;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	sendResize(): void {
		this.resizeHandler?.();
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(_width: number): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("parseTerminalColorSchemeReport", () => {
	it("parses color scheme reports", () => {
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n"), "dark");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n"), "light");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n\x1b[?997;1n\x1b[?997;1n"), "dark");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n\x1b[?997;2n\x1b[?997;2n"), "light");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;3n"), undefined);
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?996n"), undefined);
		assert.strictEqual(parseTerminalColorSchemeReport("x\x1b[?997;1n"), undefined);
	});
});

describe("parseOscColorResponse", () => {
	it("parses OSC 10, 11, and 4 replies", () => {
		assert.deepStrictEqual(parseOscColorResponse("\x1b]10;rgb:ffff/ffff/ffff\x07"), {
			target: "foreground",
			rgb: { r: 255, g: 255, b: 255 },
		});
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;13;#ff0080\x1b\\"), {
			target: 13,
			rgb: { r: 255, g: 0, b: 128 },
		});
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;1;bogus\x07"), { target: 1, rgb: undefined });
		assert.strictEqual(parseOscColorResponse("\x1b]12;#ffffff\x07"), undefined);
	});
});

const PALETTE_REPLIES = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};#000000\x07`);
const DA1 = "\x1b[?62;22c";
const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

function setup(): { terminal: TestTerminal; tui: TUI; component: InputRecorder } {
	const terminal = new TestTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	const component = new InputRecorder();
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	return { terminal, tui, component };
}

describe("TUI.queryTerminalColors", () => {
	it("queries all colors in one write and consumes the replies", async () => {
		const { terminal, tui, component } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			const written = terminal.writes.at(-1) ?? "";
			assert.ok(written.startsWith("\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07") && written.endsWith("\x1b[c"));

			terminal.sendInput("x");
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
			for (const reply of PALETTE_REPLIES) terminal.sendInput(reply);
			// Resolves once every reply arrived, without waiting for DA1.
			assert.deepStrictEqual(await query, {
				foreground: WHITE,
				background: BLACK,
				palette: Array.from({ length: 16 }, () => BLACK),
			});
			terminal.sendInput(DA1);
			assert.deepStrictEqual(component.inputs, ["x"]);
		} finally {
			tui.stop();
		}
	});

	it("resolves on DA1 with the replies that arrived, in query order", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#000000\x07");
			// An incomplete palette is dropped.
			for (const reply of PALETTE_REPLIES.slice(0, 8)) terminal.sendInput(reply);
			terminal.sendInput(DA1);
			terminal.sendInput(DA1);

			assert.deepStrictEqual(await first, { foreground: undefined, background: BLACK, palette: undefined });
			assert.deepStrictEqual(await second, { foreground: undefined, background: undefined, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it("reports late replies after a timeout and consumes them until DA1", async () => {
		const { terminal, tui, component } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
			await wait(5);
			assert.strictEqual((await query).background, undefined);

			terminal.sendInput("\x1b]11;#ffffff\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(late, [{ foreground: undefined, background: WHITE, palette: undefined }]);
			assert.deepStrictEqual(component.inputs, []);

			// With no query pending, color replies are ordinary input again.
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, ["\x1b]11;#ffffff\x07"]);
		} finally {
			tui.stop();
		}
	});
});
