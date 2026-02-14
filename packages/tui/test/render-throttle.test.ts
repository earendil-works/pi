import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class OneLine implements Component {
	private text = "";

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		const line = this.text.length > width ? this.text.slice(0, width) : this.text.padEnd(width, " ");
		return [line];
	}

	invalidate(): void {}
}

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

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tick = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("TUI render throttling", () => {
	it("throttles stream renders to avoid one render per tick", async () => {
		const vt = new VirtualTerminal(40, 5);
		const terminal = new CountingTerminal(vt);
		const ui = new TUI(terminal, { streamMinIntervalMs: 50, toolProgressMinIntervalMs: 50 });
		const line = new OneLine();

		ui.addChild(line);
		ui.start();
		await vt.flush();

		terminal.writes = 0;

		for (let i = 0; i < 20; i++) {
			line.setText(`v${i}`);
			ui.requestRenderWithReason("stream");
			await sleep(5);
		}

		// Allow trailing-edge throttled renders to flush.
		await sleep(120);
		await tick();
		await vt.flush();

		// Without throttling this would be ~20+ renders; we expect a small handful.
		assert.ok(terminal.writes <= 8, `expected <= 8 writes, got ${terminal.writes}`);
		ui.stop();
	});

	it("does not throttle input renders", async () => {
		const vt = new VirtualTerminal(40, 5);
		const terminal = new CountingTerminal(vt);
		const ui = new TUI(terminal, { streamMinIntervalMs: 50, toolProgressMinIntervalMs: 50 });
		const line = new OneLine();

		ui.addChild(line);
		ui.start();
		await vt.flush();

		terminal.writes = 0;

		for (let i = 0; i < 10; i++) {
			line.setText(`k${i}`);
			ui.requestRenderWithReason("input");
			await tick();
			await vt.flush();
		}

		assert.ok(terminal.writes >= 8, `expected many writes, got ${terminal.writes}`);
		ui.stop();
	});
});
