import assert from "node:assert";
import { describe, it } from "node:test";
import { styledLineToAnsi } from "../src/v2/ansi.ts";
import { Presenter } from "../src/v2/presenter.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine } from "../src/v2/styles.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

async function present(terminal: VirtualTerminal, presenter: Presenter, frame: Parameters<Presenter["present"]>[0]) {
	const result = presenter.present(frame);
	await terminal.flush();
	return result;
}

describe("Presenter first paint", () => {
	it("draws a bottom-growing band and parks the cursor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const presenter = new Presenter(terminal);
		const result = await present(terminal, presenter, {
			band: { width: 20, height: 3, repaint: ["row0", "row1", "row2"] },
		});
		assert.strictEqual(result.fullRepaint, true);
		assert.deepStrictEqual(terminal.getViewport(), ["row0", "row1", "row2", "", "", ""]);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 0, y: 2 });
		assert.ok(result.bytes.startsWith("\x1b[?2026h"), "frame must open synchronized output");
		assert.ok(result.bytes.endsWith("\x1b[?2026l"), "frame must close synchronized output");
	});
});

describe("Presenter incremental band damage", () => {
	it("rewrites only damaged runs without a full repaint", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const presenter = new Presenter(terminal);
		await present(terminal, presenter, { band: { width: 20, height: 3, repaint: ["row0", "row1", "row2"] } });

		const result = await present(terminal, presenter, {
			band: { width: 20, height: 3, damage: [{ row: 1, column: 0, text: "CHG" }] },
		});
		assert.strictEqual(result.fullRepaint, false);
		assert.deepStrictEqual(terminal.getViewport(), ["row0", "CHG1", "row2", "", "", ""]);
		assert.ok(!result.bytes.includes("\x1b[2J"), "damage frame must not clear the screen");
	});
});

describe("Presenter ledger commits", () => {
	it("pushes committed lines into scrollback above the band", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const presenter = new Presenter(terminal);
		await present(terminal, presenter, { band: { width: 20, height: 2, repaint: ["editor", "footer"] } });

		// Commit three history lines; the band must stay coherent at the bottom.
		await present(terminal, presenter, {
			commitLines: ["hist0", "hist1", "hist2"],
			band: { width: 20, height: 2, repaint: ["editor", "footer"] },
		});

		const scroll = terminal.getScrollBuffer();
		const nonEmpty = scroll.map((line) => line.trimEnd()).filter((line) => line.length > 0);
		assert.deepStrictEqual(nonEmpty, ["hist0", "hist1", "hist2", "editor", "footer"]);
		// Band remains the last two rows of the viewport.
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[viewport.length - 2], "editor");
		assert.strictEqual(viewport[viewport.length - 1], "footer");
	});
});

describe("Presenter band height changes", () => {
	it("clears vacated rows when the band shrinks", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const presenter = new Presenter(terminal);
		await present(terminal, presenter, {
			band: { width: 20, height: 4, repaint: ["b0", "b1", "b2", "b3"] },
		});
		const result = await present(terminal, presenter, {
			band: { width: 20, height: 2, repaint: ["b0", "b1"] },
		});
		assert.strictEqual(result.fullRepaint, true);
		assert.deepStrictEqual(terminal.getViewport(), ["b0", "b1", "", "", "", ""]);
	});

	it("repaints the full band when it grows", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const presenter = new Presenter(terminal);
		await present(terminal, presenter, { band: { width: 20, height: 2, repaint: ["b0", "b1"] } });
		const result = await present(terminal, presenter, {
			band: { width: 20, height: 3, repaint: ["b0", "b1", "b2"] },
		});
		assert.strictEqual(result.fullRepaint, true);
		assert.deepStrictEqual(terminal.getViewport(), ["b0", "b1", "b2", "", "", ""]);
	});
});

describe("Presenter terminal-safety: control injection (plan §3)", () => {
	it("a hostile committed line cannot inject control sequences and matches a sanitized render", async () => {
		// ESC + CSI clear-screen, CR, LF, and DEL smuggled into a committed span.
		const hostile: StyledLine = [{ text: "A\x1b[2JB\rC\nD\x7fE", style: DEFAULT_TEXT_STYLE }];
		const sanitized: StyledLine = [{ text: "A[2JBCDE", style: DEFAULT_TEXT_STYLE }];

		const serialized = styledLineToAnsi(hostile);
		assert.ok(!serialized.includes("\x1b[2J"), "clear-screen escape must not survive serialization");
		assert.ok(!serialized.includes("\r"), "CR must not survive serialization");
		assert.ok(!serialized.includes("\n"), "LF must not survive serialization");

		const render = async (line: StyledLine) => {
			const terminal = new VirtualTerminal(20, 4);
			const presenter = new Presenter(terminal);
			await present(terminal, presenter, { band: { width: 20, height: 1, repaint: ["band"] } });
			await present(terminal, presenter, {
				commitLines: [styledLineToAnsi(line)],
				band: { width: 20, height: 1, repaint: ["band"] },
			});
			return { viewport: terminal.getViewport(), scroll: terminal.getScrollBuffer() };
		};

		const hostileState = await render(hostile);
		const sanitizedState = await render(sanitized);
		assert.deepStrictEqual(hostileState.viewport, sanitizedState.viewport);
		assert.deepStrictEqual(hostileState.scroll, sanitizedState.scroll);

		// The clear-screen never fired: the committed content is present verbatim as inert text.
		const content = hostileState.scroll.map((line) => line.trimEnd()).filter((line) => line.length > 0);
		assert.deepStrictEqual(content, ["A[2JBCDE", "band"]);
	});
});

describe("Presenter final-column autowrap policy (plan §3 DECAWM)", () => {
	it("disables autowrap before content and restores it before closing the frame", async () => {
		const terminal = new VirtualTerminal(8, 4);
		const presenter = new Presenter(terminal);
		const result = await present(terminal, presenter, {
			band: { width: 8, height: 2, repaint: ["12345678", "next"] }, // row 0 is exactly full width
		});
		const off = result.bytes.indexOf("\x1b[?7l");
		const on = result.bytes.indexOf("\x1b[?7h");
		const content = result.bytes.indexOf("12345678");
		const syncEnd = result.bytes.indexOf("\x1b[?2026l");
		assert.ok(off !== -1 && on !== -1, "frame toggles autowrap off then on");
		assert.ok(off < content, "autowrap is disabled before any content is written");
		assert.ok(content < on && on < syncEnd, "autowrap is restored after content and before SYNC_END");
		// Full-width row occupies exactly one line; the next band row is not shifted down.
		assert.deepStrictEqual(terminal.getViewport(), ["12345678", "next", "", ""]);
	});

	it("restores autowrap on cleanup for terminal handback", async () => {
		const terminal = new VirtualTerminal(8, 4);
		const presenter = new Presenter(terminal);
		await present(terminal, presenter, { band: { width: 8, height: 1, repaint: ["hi"] } });
		let cleanupBytes = "";
		const write = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			cleanupBytes += data;
			write(data);
		};
		presenter.cleanup();
		assert.ok(cleanupBytes.includes("\x1b[?7h"), "cleanup restores autowrap for handback");
	});
});

describe("Presenter caret placement", () => {
	it("emits a single caret placement and shows the cursor when focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const presenter = new Presenter(terminal);
		const result = await present(terminal, presenter, {
			band: { width: 20, height: 3, repaint: ["row0", "prompt> ", "row2"] },
			caret: { row: 1, column: 8 },
			showCursor: true,
		});
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 8, y: 1 });
		assert.strictEqual(countOccurrences(result.bytes, "\x1b[?25h"), 1, "exactly one show-cursor");
		assert.strictEqual(countOccurrences(result.bytes, "\x1b[?25l"), 0, "no hide-cursor when focused");
	});

	it("parks and hides the cursor with no focused caret", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const presenter = new Presenter(terminal);
		const result = await present(terminal, presenter, {
			band: { width: 20, height: 3, repaint: ["row0", "row1", "row2"] },
		});
		assert.strictEqual(countOccurrences(result.bytes, "\x1b[?25l"), 1, "exactly one hide-cursor");
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 0, y: 2 });
	});
});
