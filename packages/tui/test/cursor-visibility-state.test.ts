import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { type Component, CURSOR_MARKER, type TUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	hideCursorCalls = 0;
	showCursorCalls = 0;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return true;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		else if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.hideCursorCalls += 1;
		this.write(HIDE_CURSOR);
	}

	showCursor(): void {
		this.showCursorCalls += 1;
		this.write(SHOW_CURSOR);
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(_active: boolean): void {}

	clearWrites(): void {
		this.writes.length = 0;
	}
}

class CursorComponent implements Component {
	frame = 0;
	showCursor = true;
	cursorOffset = 5;

	render(): string[] {
		const draft = "draft";
		const cursor = this.showCursor ? CURSOR_MARKER : "";
		return [
			`streamed chunk ${this.frame}`,
			`> ${draft.slice(0, this.cursorOffset)}${cursor}${draft.slice(this.cursorOffset)}`,
		];
	}

	invalidate(): void {}
}

interface RendererCase {
	name: string;
	create(terminal: Terminal): TUI;
}

const rendererCases: RendererCase[] = [
	{
		name: "regular renderer",
		create: (terminal) => new TuiMainScreen(terminal, true),
	},
	{
		name: "fullscreen renderer",
		create: (terminal) => new TuiAltScreen(terminal, true),
	},
];

const defaultRendererCases: RendererCase[] = [
	{
		name: "regular renderer",
		create: (terminal) => new TuiMainScreen(terminal),
	},
	{
		name: "fullscreen renderer",
		create: (terminal) => new TuiAltScreen(terminal),
	},
];

function countSequence(terminal: RecordingTerminal, sequence: string): number {
	return terminal.writes.reduce((count, write) => count + write.split(sequence).length - 1, 0);
}

function renderNextFrame(tui: TUI, component: CursorComponent): void {
	component.frame += 1;
	tui.renderNow();
}

for (const rendererCase of rendererCases) {
	describe(rendererCase.name, () => {
		it("emits cursor visibility only when the state changes", () => {
			const terminal = new RecordingTerminal();
			const tui = rendererCase.create(terminal);
			const component = new CursorComponent();
			tui.addChild(component);
			tui.start();
			tui.renderNow();

			try {
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 1);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 1);
				assert.strictEqual(terminal.hideCursorCalls, tui.mode === "regular" ? 1 : 0);
				assert.strictEqual(terminal.showCursorCalls, tui.mode === "regular" ? 1 : 0);

				terminal.clearWrites();
				tui.renderNow(true);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 1);

				terminal.clearWrites();
				renderNextFrame(tui, component);
				renderNextFrame(tui, component);
				renderNextFrame(tui, component);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);

				terminal.clearWrites();
				component.showCursor = false;
				renderNextFrame(tui, component);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 1);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);

				if (tui.mode === "fullscreen") {
					const transitionWrite = terminal.writes.find((write) => write.includes(HIDE_CURSOR));
					assert.ok(transitionWrite?.startsWith(BEGIN_SYNCHRONIZED_OUTPUT));
					assert.ok(transitionWrite?.endsWith(END_SYNCHRONIZED_OUTPUT));
				}

				terminal.clearWrites();
				renderNextFrame(tui, component);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);

				terminal.clearWrites();
				component.showCursor = true;
				renderNextFrame(tui, component);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 1);
			} finally {
				tui.stop();
			}
		});

		it("does not re-emit visibility when the cursor moves during streaming", () => {
			const terminal = new RecordingTerminal();
			const tui = rendererCase.create(terminal);
			const component = new CursorComponent();
			tui.addChild(component);
			tui.start();
			tui.renderNow();

			try {
				terminal.clearWrites();
				for (const cursorOffset of [3, 0, 4, 1]) {
					component.cursorOffset = cursorOffset;
					renderNextFrame(tui, component);
				}

				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);
			} finally {
				tui.stop();
			}
		});

		it("applies hardware cursor setting changes once", () => {
			const terminal = new RecordingTerminal();
			const tui = rendererCase.create(terminal);
			const component = new CursorComponent();
			tui.addChild(component);
			tui.start();
			tui.renderNow();

			try {
				terminal.clearWrites();
				const hideCursorCalls = terminal.hideCursorCalls;
				tui.setShowHardwareCursor(false);
				tui.renderNow();
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 1);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);
				assert.strictEqual(terminal.hideCursorCalls, hideCursorCalls + 1);

				terminal.clearWrites();
				tui.setShowHardwareCursor(true);
				tui.renderNow();
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 1);

				terminal.clearWrites();
				renderNextFrame(tui, component);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);
			} finally {
				tui.stop();
			}
		});

		it("reasserts cursor visibility after restart", () => {
			const terminal = new RecordingTerminal();
			const tui = rendererCase.create(terminal);
			const component = new CursorComponent();
			tui.addChild(component);
			tui.start();
			tui.renderNow();
			tui.stop({ preserveScreen: true });
			terminal.clearWrites();

			tui.start();
			tui.renderNow();
			try {
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 1);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 1);
			} finally {
				tui.stop();
			}
		});
	});
}

describe("default hidden hardware cursor", () => {
	for (const rendererCase of defaultRendererCases) {
		it(`does not re-emit hide while ${rendererCase.name} streams`, () => {
			const terminal = new RecordingTerminal();
			const tui = rendererCase.create(terminal);
			const component = new CursorComponent();
			tui.addChild(component);
			tui.start();
			tui.renderNow();

			try {
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 1);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);

				terminal.clearWrites();
				renderNextFrame(tui, component);
				renderNextFrame(tui, component);
				renderNextFrame(tui, component);
				assert.strictEqual(countSequence(terminal, HIDE_CURSOR), 0);
				assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 0);
			} finally {
				tui.stop();
			}
		});
	}
});

describe("fullscreen renderer lifecycle", () => {
	it("restores cursor visibility after leaving the alternate screen", () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal, true);
		const component = new CursorComponent();
		tui.addChild(component);
		tui.start();
		tui.renderNow();
		terminal.clearWrites();

		tui.stop({ preserveScreen: true });

		const exitWrite = terminal.writes.find((write) => write.includes(EXIT_ALT_SCREEN));
		assert.ok(exitWrite?.includes(`${EXIT_ALT_SCREEN}${SHOW_CURSOR}`));
		assert.ok(exitWrite?.startsWith(BEGIN_SYNCHRONIZED_OUTPUT));
		assert.ok(exitWrite?.endsWith(END_SYNCHRONIZED_OUTPUT));
		assert.strictEqual(countSequence(terminal, SHOW_CURSOR), 2);
		assert.strictEqual(terminal.showCursorCalls, 1);
		assert.strictEqual(countSequence(terminal, ENTER_ALT_SCREEN), 0);
	});
});
