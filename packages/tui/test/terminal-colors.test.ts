import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, parseOsc11BackgroundColor, type Terminal, TUI } from "../src/index.ts";

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

describe("TUI.queryTerminalBackgroundColor", () => {
	it("writes OSC 11 query and resolves with the parsed RGB reply", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			assert.ok(terminal.writes.includes("\x1b]11;?\x07"));

			terminal.sendInput("\x1b]11;#ffffff\x07");

			assert.deepStrictEqual(await query, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	it("consumes OSC 11 replies before input listeners and focused component dispatch", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });

			terminal.sendInput("\x1b]11;#000000\x07");

			assert.deepStrictEqual(await query, { r: 0, g: 0, b: 0 });
			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("consumes unparseable strict OSC 11 replies and resolves undefined", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });

			terminal.sendInput("\x1b]11;not-a-color\x07");

			assert.strictEqual(await query, undefined);
			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("dispatches non-matching input normally while waiting for an OSC 11 reply", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			let settled = false;
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 }).then((rgb) => {
				settled = true;
				return rgb;
			});

			terminal.sendInput("x");
			await Promise.resolve();

			assert.strictEqual(settled, false);
			assert.deepStrictEqual(listenerInputs, ["x"]);
			assert.deepStrictEqual(component.inputs, ["x"]);

			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(await query, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	it("keeps consuming a late OSC 11 reply after timeout", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1 });
			await wait(5);

			assert.strictEqual(await query, undefined);

			terminal.sendInput("\x1b]11;#ffffff\x07");

			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});
});
