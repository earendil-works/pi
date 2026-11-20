import assert from "node:assert";
import { describe, it, type TestContext } from "node:test";
import {
	type Component,
	parseTerminalColorSchemeReport,
	type Terminal,
	type TerminalColors,
	type TUI,
	TuiMainScreen,
} from "../src/index.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
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
	setProgramStatus(): void {}

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

	it("consumes delayed Ghostty color fragments without typing their tail or opening the editor", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { terminal, tui, component } = setup();
		const buffer = new StdinBuffer();
		buffer.on("data", (data) => terminal.sendInput(data));
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			// Captured from Ghostty 1.3.1 with Ayu Light, split at the reported tail.
			buffer.process("\x1b]4;1;rgb:eaea/6c");
			t.mock.timers.tick(100);
			buffer.process(`6c/6d6d\x07${DA1}`);
			assert.deepStrictEqual(await query, { foreground: undefined, background: undefined, palette: undefined });
			assert.deepStrictEqual(component.inputs, []);

			// A real Ctrl+G must still reach the editor after the reply.
			buffer.process("\x07");
			assert.deepStrictEqual(component.inputs, ["\x07"]);
		} finally {
			buffer.destroy();
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

	it("reports late replies after a timeout and consumes them until DA1", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const { terminal, tui, component } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
			t.mock.timers.tick(5);
			assert.strictEqual((await query).background, undefined);

			terminal.sendInput("\x1b]11;#ffffff\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(late, [{ foreground: undefined, background: WHITE, palette: undefined }]);
			assert.deepStrictEqual(component.inputs, []);

			// Once the reply window after the query has passed, color replies are ordinary input again.
			t.mock.timers.tick(1000);
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, ["\x1b]11;#ffffff\x07"]);
		} finally {
			tui.stop();
		}
	});
});

// Color replies that arrive after the query's DA1 reply, as ConPTY answers DA1 itself (#10256).
describe("TUI.queryTerminalColors replies after DA1", () => {
	function setupWithBuffer(t: TestContext) {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const context = setup();
		const buffer = new StdinBuffer();
		buffer.on("data", (data) => context.terminal.sendInput(data));
		const query = context.tui.queryTerminalColors({ timeoutMs: 100 });
		return { ...context, buffer, query };
	}

	it("drops mintty's header-less OSC 4 replies without typing them or opening the editor", async (t) => {
		const { tui, component, buffer, query } = setupWithBuffer(t);
		try {
			// Captured from mintty (Git Bash on Windows): DA1 first, then OSC 4 replies without `ESC ] 4`.
			buffer.process(`\x1b[?1;0c;0;rgb:0000/0000/0000\x07;1;rgb:d4d4/2c2c/3a3a\x07`);
			assert.deepStrictEqual(await query, { foreground: undefined, background: undefined, palette: undefined });
			// The same replies, split across reads.
			buffer.process(";2");
			t.mock.timers.tick(20);
			buffer.process(";rgb:1c1c/a8a8/0000");
			t.mock.timers.tick(20);
			buffer.process("\x07");
			assert.deepStrictEqual(component.inputs, []);

			// A real Ctrl+G still reaches the editor.
			buffer.process("\x07");
			assert.deepStrictEqual(component.inputs, ["\x07"]);
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});

	it("drops ST-terminated reply tails, also when glued to another reply", async (t) => {
		const { tui, component, buffer, query } = setupWithBuffer(t);
		try {
			// Captured from WezTerm 20240203 on Windows: only the tail of a palette reply arrives.
			buffer.process(`${DA1}a8\x1b\\`);
			await query;
			buffer.process("\x1b[6;21;10t79\x1b\\");
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});

	it("consumes complete color replies that arrive after DA1", async (t) => {
		const { tui, component, buffer, query } = setupWithBuffer(t);
		try {
			// Captured from tmux 3.6 under Windows Terminal: DA1 first, then the color replies.
			buffer.process("\x1b[?1;2;4c");
			await query;
			buffer.process("\x1b]10;rgb:cccc/cccc/cccc\x07\x1b]11;rgb:0c0c/0c0c/0c0c\x07");
			t.mock.timers.tick(500);
			buffer.process("\x1b]4;1;rgb:c5c5/0f0f/1f1f\x07");
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});

	it("delivers text typed in the reply window in order", async (t) => {
		const { tui, component, buffer, query } = setupWithBuffer(t);
		try {
			buffer.process(DA1);
			await query;
			// Text that could be a fragment waits for the next key.
			buffer.process("add");
			assert.deepStrictEqual(component.inputs, []);
			buffer.process("s");
			assert.deepStrictEqual(component.inputs, ["a", "d", "d", "s"]);
			// Or until no terminator follows in time.
			buffer.process("f");
			buffer.process("\x1b[A");
			buffer.process("0");
			assert.deepStrictEqual(component.inputs, ["a", "d", "d", "s", "f", "\x1b[A"]);
			t.mock.timers.tick(300);
			assert.deepStrictEqual(component.inputs, ["a", "d", "d", "s", "f", "\x1b[A", "0"]);

			// After the window, nothing is held.
			t.mock.timers.tick(1000);
			buffer.process("a");
			assert.deepStrictEqual(component.inputs.at(-1), "a");
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});
});
