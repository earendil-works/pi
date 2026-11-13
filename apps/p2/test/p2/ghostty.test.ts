import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
	BOLD,
	type Frame,
	Ghostty,
	INVERSE,
	ITALIC,
	type MouseInput,
	UNDERLINE,
	type VtTerminal,
} from "../../plugins/terminals/ghostty.ts";

const ghostty = Ghostty.load(
	await readFile(new URL("../../plugins/terminals/vendor/ghostty/ghostty-vt.wasm", import.meta.url)),
);
const encoder = new TextEncoder();

function text(frame: Frame): string[] {
	const rows: string[] = [];
	for (const row of frame.changed)
		rows[row.y] = row.cells
			.map((cell) => cell.text || " ")
			.join("")
			.trimEnd();
	return rows;
}

function terminal(cols = 20, rows = 5, onReply?: (bytes: Uint8Array) => void): Promise<VtTerminal> {
	return ghostty.then((loaded) => loaded.terminal({ cols, rows, scrollback: 1000, ...(onReply ? { onReply } : {}) }));
}

// The web view joins these rows when copying, so a long command copies as one line.
test("ghostty: marks soft-wrapped rows", async () => {
	const vt = await terminal(10, 4);
	vt.write(encoder.encode("0123456789abcdef\r\nshort"));
	const frame = vt.frame(true);
	assert.deepEqual(text(frame).slice(0, 3), ["0123456789", "abcdef", "short"]);
	assert.deepEqual(
		frame.changed.map((row) => row.wrapped),
		[true, false, false, false],
	);
	vt.free();
});

test("ghostty: renders text, styles, colors and the cursor", async () => {
	const vt = await terminal();
	vt.write(encoder.encode("hello\r\n\x1b[1;31mred\x1b[0m \x1b[7mrev\x1b[0m\r\n\x1b[38;2;1;2;3m日本"));
	const frame = vt.frame();
	assert.equal(frame.dirty, "full");
	assert.deepEqual(text(frame).slice(0, 3), ["hello", "red rev", "日 本"]);
	const red = frame.changed[1]?.cells[0];
	assert.equal(red?.flags && red.flags & BOLD, BOLD);
	assert.notEqual(red?.fg, -1);
	assert.equal((frame.changed[1]?.cells[4]?.flags ?? 0) & INVERSE, INVERSE);
	assert.equal(frame.changed[2]?.cells[0]?.fg, 0x010203);
	assert.deepEqual(
		frame.changed[2]?.cells.slice(0, 4).map((cell) => cell.width),
		[2, 0, 2, 0],
	);
	assert.deepEqual({ x: frame.cursor?.x, y: frame.cursor?.y }, { x: 4, y: 2 });
	// Only what changed afterwards.
	assert.equal(vt.frame().dirty, "none");
	vt.write(encoder.encode("\x1b[1;1Hj"));
	const next = vt.frame();
	assert.notEqual(next.dirty, "none");
	// The edited row, plus the row the cursor left.
	assert.deepEqual(
		next.changed.map((row) => row.y),
		[0, 2],
	);
	vt.free();
});

test("ghostty: renders grapheme clusters, underlines, the cursor style and the title", async () => {
	const vt = await terminal();
	// A cluster longer than the cell text buffer (128 bytes): "e" with combining acute accents (2 bytes each), as many as
	// libghostty keeps.
	const long = `e${"\u0301".repeat(100)}`;
	vt.write(encoder.encode(`e\u0301 \x1b[4;3mu\x1b[0m ${long}\x1b[5 q\x1b]2;my title\x07`));
	const frame = vt.frame(true);
	const cells = frame.changed[0]?.cells ?? [];
	assert.equal(cells[0]?.text, "e\u0301");
	assert.equal((cells[2]?.flags ?? 0) & (UNDERLINE | ITALIC), UNDERLINE | ITALIC);
	const kept = cells[4]?.text ?? "";
	assert.ok(encoder.encode(kept).length > 128);
	assert.ok(long.startsWith(kept));
	assert.deepEqual({ style: frame.cursor?.style, blinking: frame.cursor?.blinking }, { style: "bar", blinking: true });
	assert.equal(vt.title(), "my title");
	vt.free();
});

test("ghostty: limits scrollback by lines, not by libghostty's default of about one page", async () => {
	const vt = (await ghostty).terminal({ cols: 80, rows: 24, scrollback: 5000 });
	vt.write(encoder.encode(Array.from({ length: 20_000 }, (_, index) => String(index)).join("\r\n")));
	// libghostty drops whole pages (hundreds of rows at 80 columns), so somewhat fewer lines than the limit remain.
	const { total } = vt.scrollbar();
	assert.ok(total > 3000 && total <= 5000 + 24, `${total} rows`);
	vt.free();
});

test("ghostty: a snapshot reproduces screen, scrollback and modes", async () => {
	const source = await terminal(20, 3);
	source.write(encoder.encode("one\r\ntwo\r\nthree\r\nfour\r\n\x1b[?2004h\x1b[?1h\x1b[1mbold"));
	const copy = await terminal(20, 3);
	copy.write(source.snapshot());
	assert.deepEqual(text(copy.frame(true)), text(source.frame(true)));
	assert.equal(copy.scrollbar().total, source.scrollbar().total);
	assert.equal(copy.mode(2004), true);
	assert.equal(copy.mode(1), true);
	copy.write(encoder.encode("er"));
	assert.equal(copy.frame(true).changed[2]?.cells[5]?.flags, BOLD);
	source.free();
	copy.free();
});

test("ghostty: a snapshot of the alternate screen keeps it active", async () => {
	const source = await terminal(20, 3);
	source.write(encoder.encode("shell\r\n\x1b[?1049h\x1b[2J\x1b[Hfull screen"));
	const copy = await terminal(20, 3);
	copy.write(source.snapshot());
	assert.equal(copy.alternateScreen(), true);
	assert.deepEqual(text(copy.frame(true)), text(source.frame(true)));
	source.free();
	copy.free();
});

test("ghostty: answers queries through onReply", async () => {
	const replies: string[] = [];
	const vt = await terminal(20, 5, (bytes) => replies.push(new TextDecoder().decode(bytes)));
	vt.write(encoder.encode("ab\x1b[6n\x1b[c"));
	assert.equal(replies[0], "\x1b[1;3R");
	// Primary device attributes: CSI ? Ps ; ... c
	assert.match(replies[1]?.slice(1) ?? "", /^\[\?\d+(;\d+)*c$/);
	assert.equal(replies[1]?.[0], "\x1b");
	vt.free();
});

test("ghostty: encodes keys and pastes in the terminal's modes", async () => {
	const vt = await terminal();
	const key = (code: string, key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
		new TextDecoder().decode(vt.encodeKey({ code, key, ...mods }) ?? new Uint8Array());
	assert.equal(key("Enter", "Enter"), "\r");
	assert.equal(key("Backspace", "Backspace"), "\x7f");
	assert.equal(key("ArrowUp", "ArrowUp"), "\x1b[A");
	assert.equal(key("KeyC", "c", { ctrl: true }), "\x03");
	assert.equal(key("KeyA", "a"), "a");
	assert.equal(key("KeyA", "A", { shift: true }), "A");
	assert.equal(key("KeyB", "b", { alt: true }), "\x1bb");
	vt.write(encoder.encode("\x1b[?1h"));
	assert.equal(key("ArrowUp", "ArrowUp"), "\x1bOA");
	assert.equal(new TextDecoder().decode(vt.encodePaste("a\nb")), "a\rb");
	vt.write(encoder.encode("\x1b[?2004h"));
	assert.equal(new TextDecoder().decode(vt.encodePaste("x\x1by")), "\x1b[200~x y\x1b[201~");
	vt.free();
});

test("ghostty: scrolls the viewport through scrollback", async () => {
	const vt = await terminal(10, 2);
	vt.write(encoder.encode("1\r\n2\r\n3\r\n4"));
	assert.deepEqual(text(vt.frame(true)), ["3", "4"]);
	vt.scroll(-2);
	assert.deepEqual(text(vt.frame(true)), ["1", "2"]);
	assert.equal(vt.scrollbar().offset, 0);
	vt.scroll("bottom");
	assert.deepEqual(text(vt.frame(true)), ["3", "4"]);
	vt.free();
});

test("ghostty: answers light/dark queries and color queries with the configured colors", async () => {
	const loaded = await ghostty;
	const replies: string[] = [];
	let scheme: "light" | "dark" | undefined = "light";
	const vt = loaded.terminal({
		cols: 20,
		rows: 5,
		scrollback: 0,
		colors: { foreground: 0x1d1b19, background: 0xfbfaf8 },
		onReply: (bytes) => replies.push(new TextDecoder().decode(bytes)),
		colorScheme: () => scheme,
	});
	vt.write(encoder.encode("\x1b[?996n\x1b]11;?\x07"));
	assert.deepEqual(replies, ["\x1b[?997;2n", "\x1b]11;rgb:fbfb/fafa/f8f8\x07"]);
	scheme = "dark";
	vt.setColors({ foreground: 0xe6e6e6, background: 0x141414 });
	vt.write(encoder.encode("\x1b[?996n\x1b]10;?\x07"));
	assert.deepEqual(replies.slice(2), ["\x1b[?997;1n", "\x1b]10;rgb:e6e6/e6e6/e6e6\x07"]);
	vt.free();
});

test("ghostty: encodes mouse events in the program's mouse mode", async () => {
	const vt = await terminal(20, 5);
	const mouse = (input: Omit<MouseInput, "x" | "y" | "width" | "height" | "cellWidth" | "cellHeight">) => {
		const bytes = vt.encodeMouse({ ...input, x: 20, y: 20, width: 160, height: 80, cellWidth: 8, cellHeight: 16 });
		return bytes ? new TextDecoder().decode(bytes) : undefined;
	};
	assert.equal(vt.mouseTracking(), false);
	assert.equal(mouse({ action: "press", button: "wheelUp" }), undefined);
	vt.write(encoder.encode("\x1b[?1000h\x1b[?1006h"));
	assert.equal(vt.mouseTracking(), true);
	// SGR: wheel up 64, down 65, left button 0 (M press, m release), at column 3 (20 / 8, 1-based) and row 2.
	assert.equal(mouse({ action: "press", button: "wheelUp" }), "\x1b[<64;3;2M");
	assert.equal(mouse({ action: "press", button: "wheelDown" }), "\x1b[<65;3;2M");
	assert.equal(mouse({ action: "press", button: "left" }), "\x1b[<0;3;2M");
	assert.equal(mouse({ action: "release", button: "left" }), "\x1b[<0;3;2m");
	// Normal tracking (1000) reports no motion; button-event tracking (1002) reports drags.
	assert.equal(mouse({ action: "motion", button: "left" }), undefined);
	vt.write(encoder.encode("\x1b[?1002h"));
	assert.equal(mouse({ action: "motion", button: "left" }), "\x1b[<32;3;2M");
	vt.free();
});
