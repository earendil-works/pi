import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, type Focusable } from "../src/tui.ts";
import { cellsToAnsi } from "../src/v2/ansi.ts";
import { CellBuffer } from "../src/v2/cell-buffer.ts";
import { EditorStrip } from "../src/v2/editor-strip.ts";
import type { FrameClock } from "../src/v2/frame-scheduler.ts";
import { LegacyEditorStripAdapter } from "../src/v2/legacy.ts";
import { LedgerBandRenderer } from "../src/v2/renderer.ts";
import { DefaultTextLayout } from "../src/v2/text-layout.ts";
import { TextModel } from "../src/v2/text-model.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

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

/** A v1 focusable editor that emits CURSOR_MARKER before the inverse cursor cell when focused, like the real one. */
class FakeV1Editor implements Component, Focusable {
	focused = false;
	text: string;
	cursor: number;
	invalidated = 0;
	constructor(text: string, cursor: number) {
		this.text = text;
		this.cursor = cursor;
	}
	render(_width: number): string[] {
		const before = this.text.slice(0, this.cursor);
		const at = this.text.slice(this.cursor);
		const grapheme = at.length > 0 ? [...at][0]! : " ";
		const rest = at.slice(grapheme.length);
		const marker = this.focused ? CURSOR_MARKER : "";
		// Marker is gated on focus; the inverse fake-cursor cell is drawn regardless (mirrors editor.ts).
		return [`${before}${marker}\x1b[7m${grapheme}\x1b[0m${rest}`];
	}
	invalidate(): void {
		this.invalidated++;
	}
}

function serializeRow(buffer: CellBuffer, row: number): string {
	const cells = Array.from({ length: buffer.width }, (_, column) => buffer.get(row, column));
	return cellsToAnsi(cells, buffer.styles, buffer.links);
}

function withoutSgr(wire: string): string {
	return wire.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("EditorStrip (native TextModel/TextLayout path)", () => {
	it("measures and paints wrapped model lines as text, with no cursor cell", () => {
		const strip = new EditorStrip("editor", new TextModel("hello\nworld"));
		assert.strictEqual(strip.measure(20), 2);
		const buffer = new CellBuffer(20, 2);
		strip.paint(buffer.region(0, 0, 20, 2));
		assert.strictEqual(withoutSgr(serializeRow(buffer, 0)).trimEnd(), "hello");
		assert.strictEqual(withoutSgr(serializeRow(buffer, 1)).trimEnd(), "world");
		// The painted band never carries a cursor; the caret is the renderer's sole hardware CUP.
		assert.doesNotMatch(serializeRow(buffer, 0), /\x1b\[7m/);
	});

	it("reports the caret only when focused, matching DefaultTextLayout.caretCell", () => {
		const model = new TextModel("hello", 3);
		const strip = new EditorStrip("editor", model);
		assert.strictEqual(strip.caret(20), undefined, "no caret when unfocused");
		strip.focused = true;
		const expected = new DefaultTextLayout().caretCell(model, 20);
		assert.deepStrictEqual(strip.caret(20), {
			stripId: "editor",
			row: expected.row,
			column: expected.column,
			visible: true,
		});
		assert.deepStrictEqual({ row: expected.row, column: expected.column }, { row: 0, column: 3 });
	});

	it("drives the renderer's sole hardware caret through setFocusedCaret (single-caret policy)", async () => {
		const width = 20;
		const terminal = new VirtualTerminal(width, 6);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, width, viewportRows: 6, clock });
		const model = new TextModel("ab\ncd", 1);
		const strip = new EditorStrip("editor", model);
		strip.focused = true;
		renderer.addStrip({ id: "editor", strip, policy: { priority: 0 } });

		const layout = new DefaultTextLayout();
		renderer.setFocusedCaret(strip.caret(width));
		renderer.flush();
		await terminal.flush();
		const first = layout.caretCell(model, width);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: first.column, y: first.row });

		// An edit moves the caret; the strip re-derives it from the model and the renderer tracks it.
		model.apply({ type: "move", direction: "down" });
		renderer.setFocusedCaret(strip.caret(width));
		renderer.flush();
		await terminal.flush();
		const second = layout.caretCell(model, width);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: second.column, y: second.row });
		assert.strictEqual(second.row, 1, "caret moved to the second visual row");
		renderer.stop();
	});
});

describe("LegacyEditorStripAdapter (v1 editor -> v2 CaretStrip, plan §7)", () => {
	it("derives the caret from CURSOR_MARKER at the boundary and never lets it reach cells or bytes (§3)", () => {
		const editor = new FakeV1Editor("foobar", 3);
		const adapter = new LegacyEditorStripAdapter("editor", editor);
		adapter.focused = true;

		assert.deepStrictEqual(adapter.caret(40), { stripId: "editor", row: 0, column: 3, visible: true });

		const buffer = new CellBuffer(40, 1);
		adapter.paint(buffer.region(0, 0, 40, 1));
		const wire = serializeRow(buffer, 0);
		assert.ok(!wire.includes(CURSOR_MARKER), "raw marker sequence never reaches serialized bytes");
		assert.ok(!wire.includes("\x1b_"), "no APC introducer leaks");
		assert.ok(!withoutSgr(wire).includes("_pi:c"), "the marker's printable payload never reaches the frame");
		assert.ok(withoutSgr(wire).includes("foobar"), "the editor's text survives");
	});

	it("emits no marker and no caret when unfocused, but still paints the text", () => {
		const editor = new FakeV1Editor("foobar", 3);
		const adapter = new LegacyEditorStripAdapter("editor", editor);
		assert.strictEqual(adapter.focused, false);
		assert.strictEqual(adapter.caret(40), undefined);
		const buffer = new CellBuffer(40, 1);
		adapter.paint(buffer.region(0, 0, 40, 1));
		const wire = serializeRow(buffer, 0);
		assert.ok(!wire.includes(CURSOR_MARKER) && !withoutSgr(wire).includes("_pi:c"));
		assert.ok(withoutSgr(wire).includes("foobar"));
	});

	it("computes the caret column by visible width, honoring wide graphemes before the cursor", () => {
		// "aあb" with the cursor before 'b': visible width of "aあ" is 1 + 2 = 3.
		const adapter = new LegacyEditorStripAdapter("editor", new FakeV1Editor("aあb", 2));
		adapter.focused = true;
		assert.deepStrictEqual(adapter.caret(40), { stripId: "editor", row: 0, column: 3, visible: true });
	});

	it("drives the renderer's sole hardware caret end-to-end without leaking the marker into the viewport", async () => {
		const width = 20;
		const terminal = new VirtualTerminal(width, 6);
		const clock = new ManualClock();
		const renderer = new LedgerBandRenderer<undefined>({ terminal, theme: undefined, width, viewportRows: 6, clock });
		const adapter = new LegacyEditorStripAdapter("editor", new FakeV1Editor("foobar", 3));
		adapter.focused = true;
		renderer.addStrip({ id: "editor", strip: adapter, policy: { priority: 0 } });

		renderer.setFocusedCaret(adapter.caret(width));
		renderer.flush();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 3, y: 0 });
		const viewport = terminal.getViewport();
		assert.ok(viewport[0]!.startsWith("foobar"), "text is painted");
		assert.ok(!viewport.some((line) => line.includes("_pi:c")), "marker payload never reaches the viewport");
		renderer.stop();
	});
});
