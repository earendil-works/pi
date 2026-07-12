import assert from "node:assert";
import { describe, it } from "node:test";
import type { BandHost, PaintRegion, Strip, StripSlot } from "../src/v2/band.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import { CompletedLineFrontier } from "../src/v2/ledger.ts";
import { LedgerBandRenderer } from "../src/v2/renderer.ts";
import { Signal } from "../src/v2/signal.ts";
import { plainLine } from "../src/v2/styles.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Deterministic clock: timers only fire when the test advances time. */
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
	advance(ms: number): void {
		this.time += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.time) {
				this.timers.delete(id);
				timer.callback();
			}
		}
	}
}

class TextStrip implements Strip {
	readonly onDirty = new Signal<void>();
	readonly onLayoutDirty = new Signal<void>();
	private lines: string[];
	host: BandHost | undefined;

	constructor(lines: string[] = []) {
		this.lines = lines;
	}
	measure(_width: number): number {
		return this.lines.length;
	}
	paint(region: PaintRegion): void {
		for (let row = 0; row < this.lines.length && row < region.height; row++) {
			region.putText(0, row, plainLine(this.lines[row]!));
		}
	}
	mount(host: BandHost): void {
		this.host = host;
	}
	setLines(lines: string[], layoutDirty = false): void {
		this.lines = lines;
		if (layoutDirty) this.onLayoutDirty.emit();
		else this.onDirty.emit();
	}
}

function slot(id: string, strip: Strip, priority = 0): StripSlot {
	return { id, strip, policy: { priority } };
}

const textRenderer = {
	render: (model: string): ReturnType<typeof plainLine>[] =>
		model
			.replace(/\n$/, "")
			.split("\n")
			.map((line) => plainLine(line)),
};

function makeRenderer(
	terminal: VirtualTerminal,
	clock: ManualClock,
	options: Partial<{ maxCommitLinesPerFrame: number }> = {},
) {
	return new LedgerBandRenderer<undefined>({
		terminal,
		theme: undefined,
		clock,
		maxCommitLinesPerFrame: options.maxCommitLinesPerFrame,
	});
}

describe("LedgerBandRenderer commits", () => {
	it("commits final ledger blocks into scrollback above the band", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock);
		renderer.addStrip(slot("footer", new TextStrip(["footer"])));
		renderer.ledger.addBlock({ id: "a", model: "h0\nh1", renderer: textRenderer, state: "final" });

		renderer.flush();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getViewport(), ["h0", "h1", "footer", "", "", ""]);
		assert.strictEqual(renderer.metrics.committedLines, 2);
		renderer.stop();
	});

	it("streams an open block, committing each completed line while keeping the band coherent", async () => {
		const terminal = new VirtualTerminal(24, 6);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock);
		renderer.addStrip(slot("footer", new TextStrip(["--footer--"])));
		const block = renderer.ledger.addBlock({
			id: "log",
			model: "",
			renderer: textRenderer,
			frontier: new CompletedLineFrontier(),
		});

		block.update("line1\n");
		renderer.flush();
		block.update("line1\nline2\n");
		renderer.flush();
		block.finalize("line1\nline2\nline3");
		renderer.flush();
		await terminal.flush();

		const viewport = terminal.getViewport().map((line) => line.trimEnd());
		assert.deepStrictEqual(viewport, ["line1", "line2", "line3", "--footer--", "", ""]);
		assert.strictEqual(renderer.metrics.committedLines, 3);
		renderer.stop();
	});
});

describe("LedgerBandRenderer band updates", () => {
	it("applies in-place damage without a full repaint when only content changes", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock);
		const footer = new TextStrip(["status: idle"]);
		renderer.addStrip(slot("footer", footer));
		renderer.flush();
		const before = renderer.metrics.fullRepaints;

		footer.setLines(["status: busy"]);
		const result = renderer.flush();
		await terminal.flush();
		assert.strictEqual(result?.fullRepaint, false);
		assert.strictEqual(renderer.metrics.fullRepaints, before);
		assert.deepStrictEqual(terminal.getViewport()[0], "status: busy");
		renderer.stop();
	});

	it("fully repaints and clears rows when the band shrinks", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock);
		const strip = new TextStrip(["a", "b", "c"]);
		renderer.addStrip(slot("strip", strip));
		renderer.flush();

		strip.setLines(["a"], true);
		const result = renderer.flush();
		await terminal.flush();
		assert.strictEqual(result?.fullRepaint, true);
		assert.deepStrictEqual(terminal.getViewport(), ["a", "", "", "", "", ""]);
		renderer.stop();
	});
});

describe("LedgerBandRenderer caret", () => {
	it("places the hardware cursor at the focused strip's band-local caret", async () => {
		const terminal = new VirtualTerminal(24, 6);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock);
		renderer.addStrip(slot("editor", new TextStrip(["prompt> "])));
		renderer.addStrip(slot("footer", new TextStrip(["--footer--"])));
		renderer.setFocusedCaret({ stripId: "editor", row: 0, column: 8, visible: true });
		renderer.flush();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 8, y: 0 });
		renderer.stop();
	});
});

describe("LedgerBandRenderer commit budget", () => {
	it("bounds committed lines per frame and carries the rest forward", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock, { maxCommitLinesPerFrame: 1 });
		renderer.addStrip(slot("footer", new TextStrip(["end"])));
		renderer.ledger.addBlock({ id: "a", model: "0\n1\n2", renderer: textRenderer, state: "final" });

		renderer.flush();
		assert.strictEqual(renderer.metrics.committedLines, 1);
		renderer.flush();
		assert.strictEqual(renderer.metrics.committedLines, 2);
		renderer.flush();
		assert.strictEqual(renderer.metrics.committedLines, 3);
		await terminal.flush();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), ["0", "1", "2", "end"]);
		renderer.stop();
	});
});

describe("LedgerBandRenderer animations", () => {
	it("drives recurring strip animations off the frame clock and cancels cleanly", () => {
		const terminal = new VirtualTerminal(20, 4);
		const clock = new ManualClock();
		const renderer = makeRenderer(terminal, clock);
		let ticks = 0;
		const cancel = renderer.scheduleAnimation(() => {
			ticks++;
		}, 100);
		clock.advance(100);
		clock.advance(100);
		assert.strictEqual(ticks, 2);
		cancel();
		clock.advance(100);
		assert.strictEqual(ticks, 2);
		renderer.stop();
	});
});
