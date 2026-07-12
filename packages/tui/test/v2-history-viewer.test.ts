import assert from "node:assert";
import { describe, it } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { setKittyProtocolActive } from "../src/keys.ts";
import type { Terminal } from "../src/terminal.ts";
import type { BandHost, PaintRegion, Strip, StripSlot } from "../src/v2/band.ts";
import { plainTextRenderer } from "../src/v2/blocks.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import { HistoryViewer } from "../src/v2/history-viewer.ts";
import { LedgerStore } from "../src/v2/ledger.ts";
import { LedgerBandRenderer } from "../src/v2/renderer.ts";
import { Signal } from "../src/v2/signal.ts";
import { DEFAULT_TEXT_STYLE, plainLine, type StyledLine } from "../src/v2/styles.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Legacy (non-Kitty) input sequences so matchesKey resolves against raw control/letter bytes.
setKittyProtocolActive(false);
// Deterministic, global-independent registry that includes the tui.history.* defaults.
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

const CTRL_R = "\x12"; // tui.history.open
const CTRL_N = "\x0e"; // tui.history.scrollDown
const CTRL_P = "\x10"; // tui.history.scrollUp

class ManualClock implements FrameClock {
	private time = 0;
	private seq = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();
	now(): number {
		return this.time;
	}
	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = ++this.seq;
		this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}
}

class TextStrip implements Strip {
	readonly onDirty = new Signal<void>();
	readonly onLayoutDirty = new Signal<void>();
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	measure(): number {
		return this.lines.length;
	}
	paint(region: PaintRegion): void {
		for (let row = 0; row < this.lines.length && row < region.height; row++) {
			region.putText(0, row, plainLine(this.lines[row]!));
		}
	}
	mount(_host: BandHost): void {}
}

function slot(id: string, strip: Strip): StripSlot {
	return { id, strip, policy: { priority: 0 } };
}

/** Non-empty, right-trimmed lines across the active buffer (scrollback + viewport), in buffer order. */
function bufferLines(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function viewportText(terminal: VirtualTerminal): string {
	return terminal.getViewport().join("\n");
}

/** Records raw bytes written, and reports fixed dimensions. Enough of Terminal for the pager. */
class CaptureTerminal implements Terminal {
	written = "";
	private readonly _columns: number;
	private readonly _rows: number;
	constructor(columns: number, rows: number) {
		this._columns = columns;
		this._rows = rows;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.written += data;
	}
	get columns(): number {
		return this._columns;
	}
	get rows(): number {
		return this._rows;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

describe("v2 full-history viewer", () => {
	it("browses history older than the native replay tail and returns cleanly to live", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock,
			keybindings,
			maxReplayLines: 3,
			historyHint: "ctrl+r",
		});
		renderer.addStrip(slot("footer", new TextStrip(["--live--"])));
		const model = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");
		renderer.ledger.addBlock({ id: "log", model, renderer: plainTextRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();

		// Cap the replay so the older rows leave the terminal's native scrollback tail entirely.
		renderer.requestRecommit();
		renderer.flush();
		await terminal.flush();
		const tail = bufferLines(terminal);
		assert.ok(
			tail.some((line) => line.includes("9 earlier lines not shown") && line.includes("ctrl+r")),
			`expected an earlier-history marker advertising the open key, got ${JSON.stringify(tail)}`,
		);
		for (const kept of ["L9", "L10", "L11"]) assert.ok(tail.includes(kept), `${kept} should be in the native tail`);
		for (const gone of ["L0", "L1", "L8"]) {
			assert.ok(!tail.includes(gone), `${gone} must be beyond the native tail before opening the viewer`);
		}
		const scrollbackBeforeOpen = bufferLines(terminal);

		// Open the viewer via its discoverable keybinding; band frames suspend while it owns the terminal.
		assert.strictEqual(renderer.handleKey(CTRL_R), true, "ctrl+r must be consumed to open the viewer");
		assert.strictEqual(renderer.historyOpen, true);
		assert.strictEqual(renderer.flush(), undefined, "band frames are suspended while the viewer is open");
		await terminal.flush();

		// Opened at the newest content; page up to reach the oldest line, which is beyond the native tail.
		renderer.handleKey(CTRL_P);
		renderer.handleKey("g");
		await terminal.flush();
		const viewport = viewportText(terminal);
		assert.ok(viewport.includes("L0"), `viewer must reach the oldest line; got:\n${viewport}`);
		assert.ok(viewport.includes("/12"), `status line must show total row count; got:\n${viewport}`);

		// Return to live: exit restores the primary screen untouched and repaints the live band.
		renderer.handleKey("q");
		assert.strictEqual(renderer.historyOpen, false);
		renderer.flush();
		await terminal.flush();
		assert.ok(viewportText(terminal).includes("--live--"), "live band must be restored after exit");
		assert.deepStrictEqual(
			bufferLines(terminal),
			scrollbackBeforeOpen,
			"the alt-screen viewer must not disturb the primary-screen scrollback",
		);
		renderer.stop();
	});

	it("reflows on resize while open and stays operable", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, clock, keybindings });
		renderer.addStrip(slot("footer", new TextStrip(["--live--"])));
		// One long line that wraps differently at 30 vs. 12 columns.
		renderer.ledger.addBlock({ id: "wrap", model: "W".repeat(48), renderer: plainTextRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();

		renderer.handleKey(CTRL_R);
		await terminal.flush();
		assert.strictEqual(renderer.historyOpen, true);
		// 48 W's at width 30 → 2 wrapped rows.
		assert.ok(viewportText(terminal).includes("/2"), "status reflects the width-30 wrapped row count");

		terminal.resize(12, 8);
		renderer.resize(12, 8);
		await terminal.flush();
		assert.strictEqual(renderer.historyOpen, true, "resize must not close the viewer");
		// 48 W's at width 12 → 4 wrapped rows.
		assert.ok(viewportText(terminal).includes("/4"), "status must reflect the reflowed width-12 row count");
		renderer.handleKey(CTRL_N); // still navigable after resize
		await terminal.flush();

		renderer.handleKey("q");
		assert.strictEqual(renderer.historyOpen, false);
		renderer.stop();
	});

	it("sanitizes committed history content before it reaches the terminal (plan §3)", () => {
		const terminal = new CaptureTerminal(20, 6);
		const hostile: StyledLine = [{ text: "\x1b[2Jhack\r\ninjected", style: DEFAULT_TEXT_STYLE }];
		const viewer = new HistoryViewer({
			terminal,
			source: { historyLines: () => [hostile] },
			width: 20,
			rows: 6,
			keybindings,
		});
		viewer.openViewer();

		// The pager emits exactly one screen clear itself (on entry); content contributes none.
		const clears = terminal.written.split("\x1b[2J").length - 1;
		assert.strictEqual(clears, 1, "content must not inject an extra screen clear");
		// No raw CR/LF may originate from content; the pager positions rows with CUP only.
		assert.ok(!terminal.written.includes("\n"), "content newlines must be stripped");
		assert.ok(!terminal.written.includes("\r"), "content carriage returns must be stripped");
		// The inert printable remainder still renders.
		assert.ok(terminal.written.includes("hackinjected"), "sanitized text must still be shown");
		viewer.close();
	});

	it("restores terminal modes on every exit path and closes idempotently", () => {
		for (const closeKey of ["q", "\x1b", "\x03"]) {
			const terminal = new CaptureTerminal(20, 6);
			let exits = 0;
			const viewer = new HistoryViewer({
				terminal,
				source: { historyLines: () => [plainLine("row0"), plainLine("row1")] },
				width: 20,
				rows: 6,
				keybindings,
				onExit: () => {
					exits += 1;
				},
			});
			viewer.openViewer();
			assert.ok(terminal.written.includes("\x1b[?1049h"), "must enter the alternate screen");
			assert.ok(terminal.written.includes("\x1b[?7l"), "must disable autowrap while open");

			const beforeExit = terminal.written.length;
			viewer.handleInput(closeKey);
			assert.strictEqual(viewer.isOpen, false, `${JSON.stringify(closeKey)} must close the viewer`);
			const exitBytes = terminal.written.slice(beforeExit);
			assert.ok(exitBytes.includes("\x1b[?1049l"), "must leave the alternate screen on exit");
			assert.ok(exitBytes.includes("\x1b[?7h"), "must restore autowrap (DECAWM) on exit");
			assert.ok(exitBytes.includes("\x1b[?25h"), "must restore cursor visibility (DECTCEM) on exit");

			// Idempotent: a second close writes nothing and does not re-fire onExit.
			const afterExit = terminal.written.length;
			viewer.close();
			viewer.handleInput(closeKey);
			assert.strictEqual(terminal.written.length, afterExit, "a closed viewer must not write again");
			assert.strictEqual(exits, 1, "onExit must fire exactly once");
		}
	});

	it("snapshots the full logical history including the still-open tail block", () => {
		const store = new LedgerStore<undefined>();
		store.addBlock({ id: "done", model: "A0\nA1", renderer: plainTextRenderer, state: "final" });
		// An open (streaming) block: the snapshot shows its current full model, unstable suffix included.
		const live = store.addBlock({ id: "live", model: "B0", renderer: plainTextRenderer });
		const snapshotText = () =>
			store
				.snapshot(80, undefined)
				.map((line) => line.map((span) => span.text).join(""))
				.join("|");
		assert.strictEqual(snapshotText(), "A0|A1|B0");
		// A later streaming update to the open tail is reflected immediately, unstable suffix included.
		live.update("B0\nB1-partial");
		assert.strictEqual(snapshotText(), "A0|A1|B0|B1-partial");
	});

	it("registers tui.history.* purely additively without touching existing bindings", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS);
		// Representative pre-existing bindings resolve to their original defaults (unchanged, not reordered).
		assert.deepStrictEqual(km.getKeys("tui.input.submit"), ["enter"]);
		assert.deepStrictEqual(km.getKeys("tui.select.cancel"), ["escape", "ctrl+c"]);
		assert.deepStrictEqual(km.getKeys("tui.editor.deleteCharForward"), ["delete", "ctrl+d"]);
		// New history bindings are present and resolvable.
		assert.deepStrictEqual(km.getKeys("tui.history.open"), ["ctrl+r"]);
		assert.ok(km.matches(CTRL_R, "tui.history.open"));
		assert.ok(km.matches("g", "tui.history.top"));
	});
});
