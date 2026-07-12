import assert from "node:assert";
import { describe, it } from "node:test";
import type { BandHost, PaintRegion, Strip, StripSlot } from "../src/v2/band.ts";
import { plainTextRenderer } from "../src/v2/blocks.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import type { PresentResult } from "../src/v2/presenter.ts";
import { LedgerBandRenderer } from "../src/v2/renderer.ts";
import { Signal } from "../src/v2/signal.ts";
import { plainLine } from "../src/v2/styles.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const AUTOWRAP_OFF = "\x1b[?7l";
const AUTOWRAP_ON = "\x1b[?7h";
const HIDE_CURSOR = "\x1b[?25l";

class ManualClock implements FrameClock {
	private seq = 0;
	now(): number {
		return 0;
	}
	setTimeout(_callback: () => void, _delayMs: number): unknown {
		return ++this.seq;
	}
	clearTimeout(_handle: unknown): void {}
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

/** Drive a chunked replay to completion, collecting every physical frame's bytes. */
function drainReplay(renderer: LedgerBandRenderer<undefined>): PresentResult[] {
	const results: PresentResult[] = [];
	const first = renderer.flush();
	if (first) results.push(first);
	while (renderer.replayInProgress) {
		const next = renderer.flush();
		if (next) results.push(next);
	}
	return results;
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

describe("chunked re-commit replay", () => {
	it("splits replay across frames at row boundaries, duplicate-free and lossless", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock: new ManualClock(),
			maxReplayLinesPerFrame: 2,
		});
		renderer.addStrip(slot("footer", new TextStrip(["--end--"])));
		const rows = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"];
		renderer.ledger.addBlock({ id: "log", model: rows.join("\n"), renderer: plainTextRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();

		const framesBefore = renderer.metrics.frames;
		renderer.requestRecommit();
		const first = renderer.flush();
		assert.ok(renderer.replayInProgress, "8 rows at chunk size 2 must span more than one frame");
		const results = first ? [first] : [];
		while (renderer.replayInProgress) {
			const next = renderer.flush();
			if (next) results.push(next);
		}
		await terminal.flush();

		assert.strictEqual(results.length, 4, "8 rows / 2 per frame = 4 chunk frames");
		assert.strictEqual(renderer.metrics.frames - framesBefore, 4);
		assert.strictEqual(renderer.metrics.recommits, 1);
		assert.deepStrictEqual(historyLines(terminal), [...rows, "--end--"]);
		renderer.stop();
	});

	it("each chunk frame is a self-contained synchronized transaction with the §3 DECAWM envelope and one caret", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock: new ManualClock(),
			maxReplayLinesPerFrame: 2,
		});
		renderer.addStrip(slot("footer", new TextStrip(["--end--"])));
		renderer.ledger.addBlock({
			id: "log",
			model: ["R0", "R1", "R2", "R3", "R4"].join("\n"),
			renderer: plainTextRenderer,
			state: "final",
		});
		renderer.flush();
		await terminal.flush();

		renderer.requestRecommit();
		const results = drainReplay(renderer);
		await terminal.flush();
		assert.ok(results.length >= 2, "replay must chunk across frames");
		for (const { bytes } of results) {
			assert.ok(bytes.startsWith(SYNC_BEGIN + AUTOWRAP_OFF), "opens sync + autowrap-off");
			assert.ok(bytes.endsWith(AUTOWRAP_ON + SYNC_END), "restores autowrap + closes sync");
			assert.strictEqual(occurrences(bytes, SYNC_BEGIN), 1, "exactly one synchronized-update open");
			assert.strictEqual(occurrences(bytes, SYNC_END), 1, "exactly one synchronized-update close");
			assert.strictEqual(occurrences(bytes, AUTOWRAP_OFF), 1, "one DECAWM-off per frame");
			assert.strictEqual(occurrences(bytes, AUTOWRAP_ON), 1, "one DECAWM-on per frame");
			// Footer is unfocused, so each frame parks and hides exactly one caret.
			assert.strictEqual(occurrences(bytes, HIDE_CURSOR), 1, "exactly one caret decision per frame");
		}
		// The first chunk clears screen + scrollback; later chunks must not re-clear.
		assert.ok(results[0]!.bytes.includes("\x1b[2J") && results[0]!.bytes.includes("\x1b[3J"), "first chunk clears");
		for (const later of results.slice(1)) {
			assert.ok(!later.bytes.includes("\x1b[2J"), "later chunks push into scrollback without re-clearing");
		}
		renderer.stop();
	});

	it("cap omits an atomic multi-row block whole rather than splitting it", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock: new ManualClock(),
			maxReplayLines: 5,
			historyHint: "press g",
		});
		renderer.addStrip(slot("footer", new TextStrip(["--end--"])));
		// Oldest block is atomic and 4 rows; it cannot be partially dropped, so it goes whole.
		renderer.ledger.addBlock({
			id: "img",
			model: ["A0", "A1", "A2", "A3"].join("\n"),
			renderer: plainTextRenderer,
			state: "final",
			atomic: true,
		});
		renderer.ledger.addBlock({ id: "tail", model: "B0\nB1", renderer: plainTextRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();

		renderer.requestRecommit();
		drainReplay(renderer);
		await terminal.flush();

		assert.deepStrictEqual(renderer.metrics.lastReplay, { replayed: 3, omitted: 4 });
		const lines = historyLines(terminal);
		assert.ok(
			lines.some((line) => line.includes("4 earlier lines not shown") && line.includes("press g")),
			`expected a single earlier-history marker, got ${JSON.stringify(lines)}`,
		);
		assert.deepStrictEqual(lines.slice(-3), ["B0", "B1", "--end--"]);
		for (const gone of ["A0", "A1", "A2", "A3"]) assert.ok(!lines.includes(gone), `${gone} must be omitted whole`);
		renderer.stop();
	});

	it("cap sheds only the overflow rows of the same block when it is not atomic", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock: new ManualClock(),
			maxReplayLines: 5,
		});
		renderer.addStrip(slot("footer", new TextStrip(["--end--"])));
		renderer.ledger.addBlock({
			id: "log",
			model: ["A0", "A1", "A2", "A3"].join("\n"),
			renderer: plainTextRenderer,
			state: "final",
		});
		renderer.ledger.addBlock({ id: "tail", model: "B0\nB1", renderer: plainTextRenderer, state: "final" });
		renderer.flush();
		await terminal.flush();

		renderer.requestRecommit();
		drainReplay(renderer);
		await terminal.flush();

		// Same 6-row shape as the atomic case, but only the single overflow row is dropped.
		assert.deepStrictEqual(renderer.metrics.lastReplay, { replayed: 6, omitted: 1 });
		const lines = historyLines(terminal);
		assert.ok(lines[0]!.includes("1 earlier line not shown"), `expected the marker at the head, got ${lines[0]}`);
		assert.deepStrictEqual(lines.slice(1), ["A1", "A2", "A3", "B0", "B1", "--end--"]);
		assert.ok(!lines.includes("A0"), "only the oldest overflow row is dropped");
		renderer.stop();
	});

	it("cancels and restarts on a resize arriving mid-replay: no duplication, no loss, no stale-epoch rows", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock: new ManualClock(),
			maxReplayLinesPerFrame: 1,
		});
		renderer.addStrip(slot("footer", new TextStrip(["END"])));
		renderer.ledger.addBlock({
			id: "line",
			model: "0123456789ABCDE",
			renderer: plainTextRenderer,
			state: "final",
		});
		renderer.flush();
		await terminal.flush();

		// Epoch 1: resize to width 10 → two rows; write only the first chunk, leaving replay in flight.
		terminal.resize(10, 8);
		renderer.resize(10, 8);
		renderer.flush();
		await terminal.flush();
		assert.ok(renderer.replayInProgress, "epoch 1 replay is mid-flight");

		// Epoch 2 arrives mid-replay: resize to width 5. The stale epoch-1 tail must never be written.
		terminal.resize(5, 8);
		renderer.resize(5, 8);
		while (renderer.replayInProgress) renderer.flush();
		await terminal.flush();

		assert.strictEqual(renderer.metrics.recommits, 2, "the mid-replay resize started a second re-commit");
		const lines = historyLines(terminal);
		assert.deepStrictEqual(lines, ["01234", "56789", "ABCDE", "END"], "reflowed at width 5, duplicate-free");
		assert.ok(!lines.includes("0123456789"), "the epoch-1 width-10 row was cleared, never left behind");
		renderer.stop();
	});

	it("keeps hostile history content sanitized through every chunked replay frame (§3)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const renderer = new LedgerBandRenderer<undefined>({
			terminal,
			theme: undefined,
			clock: new ManualClock(),
			maxReplayLinesPerFrame: 1,
		});
		renderer.addStrip(slot("footer", new TextStrip(["END"])));
		// Control-injection spans: ESC (would start SGR), BEL, and NUL embedded in committed history.
		renderer.ledger.addBlock({
			id: "hostile",
			model: "a\x1b[31mb\nc\x07d\ne\x00f",
			renderer: plainTextRenderer,
			state: "final",
		});
		renderer.flush();
		await terminal.flush();

		renderer.requestRecommit();
		const results = drainReplay(renderer);
		await terminal.flush();

		// If the ESC survived, xterm would consume `\x1b[31m` as SGR and the row would read "ab"; because
		// the §3 serializer strips it, the bracket text is inert and visible. BEL/NUL are stripped likewise.
		assert.deepStrictEqual(historyLines(terminal), ["a[31mb", "cd", "ef", "END"]);
		for (const { bytes } of results) {
			assert.ok(!bytes.includes("\x00"), "NUL never reaches the wire");
			assert.ok(!bytes.includes("\x07"), "BEL never reaches the wire");
		}
		renderer.stop();
	});
});
