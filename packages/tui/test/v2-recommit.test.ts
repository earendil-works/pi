import assert from "node:assert";
import { describe, it } from "node:test";
import type { BandHost, PaintRegion, Strip, StripSlot } from "../src/v2/band.ts";
import { plainTextRenderer } from "../src/v2/blocks.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import { LedgerBandRenderer } from "../src/v2/renderer.ts";
import { Signal } from "../src/v2/signal.ts";
import { plainLine } from "../src/v2/styles.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

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

/** Non-empty, right-trimmed lines across scrollback + viewport, in buffer order. */
function historyLines(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

describe("re-commit scrollback integrity", () => {
	it("reflows committed history at the new width and leaves it duplicate-free in scrollback", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, clock });
		renderer.addStrip(slot("footer", new TextStrip(["footer"])));
		renderer.ledger.addBlock({ id: "wrap", model: "X".repeat(30), renderer: plainTextRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();
		assert.ok(historyLines(terminal).includes("X".repeat(30)), "the 30-char line commits as one row at width 40");

		terminal.resize(20, 8);
		renderer.resize(20, 8);
		renderer.flush();
		await terminal.flush();

		const lines = historyLines(terminal);
		assert.deepStrictEqual(lines, ["X".repeat(20), "X".repeat(10), "footer"]);
		assert.ok(!lines.includes("X".repeat(30)), "the pre-resize unwrapped row must be cleared, not duplicated");
		renderer.stop();
	});

	it("caps replay to maxReplayLines with a single earlier-history marker", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock,
			maxReplayLines: 3,
			historyHint: "press g",
		});
		renderer.addStrip(slot("footer", new TextStrip(["--end--"])));
		renderer.ledger.addBlock({
			id: "log",
			model: "L0\nL1\nL2\nL3\nL4\nL5",
			renderer: plainTextRenderer,
			state: "final",
		});
		renderer.flush();
		await terminal.flush();

		renderer.requestRecommit();
		renderer.flush();
		await terminal.flush();

		const lines = historyLines(terminal);
		assert.deepStrictEqual(renderer.metrics.lastReplay, { replayed: 4, omitted: 3 });
		assert.strictEqual(renderer.metrics.recommits, 1);
		assert.ok(
			lines.some((line) => line.includes("3 earlier lines not shown") && line.includes("press g")),
			`expected an earlier-history marker, got ${JSON.stringify(lines)}`,
		);
		// The replayed tail is present, duplicate-free, and the omitted older rows are gone.
		assert.deepStrictEqual(lines.slice(-4), ["L3", "L4", "L5", "--end--"]);
		for (const gone of ["L0", "L1", "L2"]) assert.ok(!lines.includes(gone), `${gone} must be omitted`);
		renderer.stop();
	});

	it("does not re-commit for a rows-only resize", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, clock });
		renderer.addStrip(slot("footer", new TextStrip(["footer"])));
		renderer.ledger.addBlock({ id: "a", model: "hello", renderer: plainTextRenderer, state: "final" });
		renderer.flush();

		terminal.resize(40, 12);
		renderer.resize(40, 12);
		renderer.flush();
		await terminal.flush();
		assert.strictEqual(renderer.metrics.recommits, 0, "a rows-only resize must not clear scrollback");
		renderer.stop();
	});
});
