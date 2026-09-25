import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type Component,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
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

describe("parseOsc11BackgroundColor", () => {
	it("parses 16-bit OSC 11 rgb responses", () => {
		assert.deepStrictEqual(parseOsc11BackgroundColor("\x1b]11;rgb:0000/8000/ffff\x07"), {
			r: 0,
			g: 128,
			b: 255,
		});
	});

	it("parses OSC 11 hex responses", () => {
		assert.deepStrictEqual(parseOsc11BackgroundColor("\x1b]11;#ffffff\x1b\\"), { r: 255, g: 255, b: 255 });
		assert.deepStrictEqual(parseOsc11BackgroundColor("\x1b]11;#000000\x07"), { r: 0, g: 0, b: 0 });
	});

	it("rejects non-strict OSC 11 responses", () => {
		assert.strictEqual(parseOsc11BackgroundColor(`x\x1b]11;#ffffff\x07`), undefined);
		assert.strictEqual(parseOsc11BackgroundColor("\x1b]10;#ffffff\x07"), undefined);
		assert.strictEqual(parseOsc11BackgroundColor("\x1b]11;#ffffff\x07x"), undefined);
	});
});

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
		assert.deepStrictEqual(parseOscColorResponse("\x1b]11;#000000\x1b\\"), {
			target: "background",
			rgb: { r: 0, g: 0, b: 0 },
		});
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;13;rgb:ff/00/80\x1b\\"), {
			target: 13,
			rgb: { r: 255, g: 0, b: 128 },
		});
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;1;bogus\x07"), { target: 1, rgb: undefined });
		assert.strictEqual(parseOscColorResponse("\x1b]12;#ffffff\x07"), undefined);
		assert.strictEqual(parseOscColorResponse("\x1b]4;;#ffffff\x07"), undefined);
	});
});

function hex(index: number): string {
	return `#${index.toString(16).padStart(2, "0")}0000`;
}

function paletteReplies(count = 16): string[] {
	return Array.from({ length: count }, (_, index) => `\x1b]4;${index};${hex(index)}\x07`);
}

const PALETTE: RgbColor[] = Array.from({ length: 16 }, (_, index) => ({ r: index, g: 0, b: 0 }));

function setup(): { terminal: TestTerminal; tui: TUI; component: InputRecorder; listenerInputs: string[] } {
	const terminal = new TestTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	const component = new InputRecorder();
	const listenerInputs: string[] = [];
	tui.addChild(component);
	tui.setFocus(component);
	tui.addInputListener((data) => {
		listenerInputs.push(data);
		return undefined;
	});
	tui.start();
	return { terminal, tui, component, listenerInputs };
}

describe("TUI.queryTerminalColors", () => {
	it("writes OSC 10, 11, 4 queries followed by DA1 in one write", () => {
		const { terminal, tui } = setup();
		try {
			void tui.queryTerminalColors({ timeoutMs: 1000 });
			const query = terminal.writes.at(-1) ?? "";
			assert.ok(query.startsWith("\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07"));
			assert.ok(query.includes("\x1b]4;15;?\x07"));
			assert.ok(query.endsWith("\x1b[c"));
		} finally {
			tui.stop();
		}
	});

	it("resolves with all colors once every reply arrived, without waiting for DA1", async () => {
		const { terminal, tui, component, listenerInputs } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
			for (const reply of paletteReplies()) terminal.sendInput(reply);

			assert.deepStrictEqual(await query, {
				foreground: { r: 255, g: 255, b: 255 },
				background: { r: 0, g: 0, b: 0 },
				palette: PALETTE,
			});
			terminal.sendInput("\x1b[?62;22c");
			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("resolves on DA1 without a palette when the terminal skips some palette replies", async () => {
		const { terminal, tui } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]11;#000000\x07");
			for (const reply of paletteReplies(8)) terminal.sendInput(reply);
			terminal.sendInput("\x1b[?1;2c");

			assert.deepStrictEqual(await query, {
				foreground: { r: 255, g: 255, b: 255 },
				background: { r: 0, g: 0, b: 0 },
				palette: undefined,
			});
		} finally {
			tui.stop();
		}
	});

	it("resolves empty on DA1 when the terminal answers no color query", async () => {
		const { terminal, tui, component } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b[?1;2c");

			assert.deepStrictEqual(await query, { foreground: undefined, background: undefined, palette: undefined });
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("assigns replies to queries in order", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput("\x1b[?1;2c");
			terminal.sendInput("\x1b]11;#ffffff\x07");
			terminal.sendInput("\x1b[?1;2c");

			assert.deepStrictEqual((await first).background, { r: 0, g: 0, b: 0 });
			assert.deepStrictEqual((await second).background, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	it("dispatches unrelated input normally while waiting for replies", async () => {
		const { terminal, tui, component, listenerInputs } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput("x");
			assert.deepStrictEqual(listenerInputs, ["x"]);
			assert.deepStrictEqual(component.inputs, ["x"]);

			terminal.sendInput("\x1b[?1;2c");
			await query;
		} finally {
			tui.stop();
		}
	});

	it("reports late replies after a timeout and consumes them until DA1 arrives", async () => {
		const { terminal, tui, component, listenerInputs } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
			await wait(5);
			assert.deepStrictEqual(await query, { foreground: undefined, background: undefined, palette: undefined });

			terminal.sendInput("\x1b]11;#ffffff\x07");
			for (const reply of paletteReplies()) terminal.sendInput(reply);
			assert.deepStrictEqual(late, []);
			terminal.sendInput("\x1b[?1;2c");

			assert.deepStrictEqual(late, [
				{ foreground: undefined, background: { r: 255, g: 255, b: 255 }, palette: PALETTE },
			]);
			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);

			// With no query pending, color replies are ordinary input again.
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, ["\x1b]11;#ffffff\x07"]);
		} finally {
			tui.stop();
		}
	});

	it("does not report late replies when the query completed in time", async () => {
		const { terminal, tui } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1000, onLateReply: (colors) => late.push(colors) });
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput("\x1b[?1;2c");
			assert.deepStrictEqual((await query).background, { r: 0, g: 0, b: 0 });
			await wait(5);
			assert.deepStrictEqual(late, []);
		} finally {
			tui.stop();
		}
	});

	it("keeps the background and foreground helpers working", async () => {
		const { terminal, tui } = setup();
		try {
			const background = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#ffffff\x07");
			terminal.sendInput("\x1b[?1;2c");
			assert.deepStrictEqual(await background, { r: 255, g: 255, b: 255 });

			const foreground = tui.queryTerminalForegroundColor({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]10;not-a-color\x07");
			terminal.sendInput("\x1b[?1;2c");
			assert.strictEqual(await foreground, undefined);
		} finally {
			tui.stop();
		}
	});
});
