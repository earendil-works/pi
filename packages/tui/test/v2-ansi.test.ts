import assert from "node:assert";
import { describe, it } from "node:test";
import { cellsToAnsi, hardWrapStyledLine, styledLineToAnsi, styleParams, styleToSgr } from "../src/v2/ansi.ts";
import { type Cell, CellBuffer, LinkTable } from "../src/v2/cell-buffer.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine, StyleTable, type TextStyle } from "../src/v2/styles.ts";

function style(overrides: Partial<TextStyle>): TextStyle {
	return { ...DEFAULT_TEXT_STYLE, ...overrides };
}

describe("styleToSgr / styleParams", () => {
	it("emits a bare reset for the default style", () => {
		assert.strictEqual(styleToSgr(DEFAULT_TEXT_STYLE), "\x1b[0m");
		assert.deepStrictEqual(styleParams(DEFAULT_TEXT_STYLE), []);
	});

	it("resets before applying attributes so nothing leaks in", () => {
		assert.strictEqual(styleToSgr(style({ bold: true, italic: true })), "\x1b[0;1;3m");
	});

	it("encodes rgb and indexed colors", () => {
		assert.strictEqual(
			styleToSgr(style({ foreground: { kind: "rgb", red: 255, green: 0, blue: 128 } })),
			"\x1b[0;38;2;255;0;128m",
		);
		assert.strictEqual(styleToSgr(style({ foreground: { kind: "indexed", index: 3 } })), "\x1b[0;33m");
		assert.strictEqual(styleToSgr(style({ foreground: { kind: "indexed", index: 9 } })), "\x1b[0;91m");
		assert.strictEqual(styleToSgr(style({ background: { kind: "indexed", index: 240 } })), "\x1b[0;48;5;240m");
	});
});

describe("styledLineToAnsi", () => {
	it("serializes spans with a trailing reset", () => {
		const line: StyledLine = [
			{ text: "a", style: style({ bold: true }) },
			{ text: "b", style: DEFAULT_TEXT_STYLE },
		];
		assert.strictEqual(styledLineToAnsi(line), "\x1b[0;1ma\x1b[0mb\x1b[0m");
	});

	it("wraps linked spans in OSC-8 sequences", () => {
		const line: StyledLine = [{ text: "x", style: DEFAULT_TEXT_STYLE, link: "https://a" }];
		assert.strictEqual(styledLineToAnsi(line), "\x1b[0m\x1b]8;;https://a\x07x\x1b]8;;\x07\x1b[0m");
	});
});

describe("cellsToAnsi", () => {
	it("coalesces equal styles and skips wide-glyph continuations", () => {
		const buffer = new CellBuffer(6, 1);
		buffer.putText(0, 0, [{ text: "ab", style: style({ bold: true }) }]);
		const runs = buffer.diff(undefined);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(cellsToAnsi(runs[0]!.cells, buffer.styles, buffer.links), "\x1b[0;1mab\x1b[0m");
	});

	it("renders a wide glyph once with its continuation suppressed", () => {
		const buffer = new CellBuffer(6, 1);
		buffer.putText(0, 0, [{ text: "世", style: DEFAULT_TEXT_STYLE }]);
		const runs = buffer.diff(undefined);
		assert.strictEqual(cellsToAnsi(runs[0]!.cells, buffer.styles, buffer.links), "\x1b[0m世\x1b[0m");
	});
});

describe("control-injection sanitization (plan §3)", () => {
	it("strips C0 / DEL / C1 control characters from styled-line span content", () => {
		// ESC + CSI clear-screen, CR, LF, BEL, DEL, and a raw C1 CSI (0x9b) inside otherwise plain text.
		const hostile: StyledLine = [{ text: "A\x1b[2JB\rC\nD\x07E\x7fF\x9bG", style: DEFAULT_TEXT_STYLE }];
		// The escape bytes are removed; their trailing printable payload ("[2J") survives as inert text.
		assert.strictEqual(styledLineToAnsi(hostile), "\x1b[0mA[2JBCDEFG\x1b[0m");
	});

	it("serializes a hostile span identically to its stripped-content equivalent", () => {
		const hostile: StyledLine = [{ text: "safe\x1b[31m\r\n\x07text\x7f\x9b", style: style({ bold: true }) }];
		const stripped: StyledLine = [{ text: "safe[31mtext", style: style({ bold: true }) }];
		assert.strictEqual(styledLineToAnsi(hostile), styledLineToAnsi(stripped));
	});

	it("drops a span whose content is entirely control characters", () => {
		const line: StyledLine = [
			{ text: "\x1b\x00\x7f", style: style({ underline: true }) },
			{ text: "ok", style: DEFAULT_TEXT_STYLE },
		];
		// No SGR/link is emitted for the all-control span; only the surviving span renders.
		assert.strictEqual(styledLineToAnsi(line), "\x1b[0mok\x1b[0m");
	});

	it("strips control characters from OSC-8 link targets so they cannot break out of the sequence", () => {
		// A URL smuggling BEL (would close the OSC-8) then an OSC-0 set-title injection.
		const line: StyledLine = [{ text: "x", style: DEFAULT_TEXT_STYLE, link: "https://a\x07\x1b]0;pwn\x07" }];
		assert.strictEqual(styledLineToAnsi(line), "\x1b[0m\x1b]8;;https://a]0;pwn\x07x\x1b]8;;\x07\x1b[0m");
	});

	it("strips control characters smuggled into cell clusters", () => {
		const styles = new StyleTable();
		const links = new LinkTable();
		const cells: Cell[] = [
			{ cluster: "a", width: 1, styleId: 0, linkId: 0 },
			{ cluster: "b\x1b", width: 1, styleId: 0, linkId: 0 }, // ESC coalesced onto a grapheme
			{ cluster: "\x9b", width: 1, styleId: 0, linkId: 0 }, // all-control cell is skipped
			{ cluster: "c\x07", width: 1, styleId: 0, linkId: 0 },
		];
		assert.strictEqual(cellsToAnsi(cells, styles, links), "\x1b[0mabc\x1b[0m");
	});
});

describe("hardWrapStyledLine", () => {
	it("splits at grapheme boundaries while preserving span style and link", () => {
		const line: StyledLine = [{ text: "abcdef", style: style({ underline: true }), link: "https://x" }];
		const rows = hardWrapStyledLine(line, 4);
		assert.deepStrictEqual(
			rows.map((row) => row.map((span) => span.text)),
			[["abcd"], ["ef"]],
		);
		assert.strictEqual(rows[0]![0]!.link, "https://x");
		assert.strictEqual(rows[0]![0]!.style.underline, true);
	});

	it("never exceeds the target width for wide glyphs", () => {
		const line: StyledLine = [{ text: "世界ab", style: DEFAULT_TEXT_STYLE }];
		const rows = hardWrapStyledLine(line, 3);
		assert.deepStrictEqual(
			rows.map((row) => row.map((span) => span.text).join("")),
			["世", "界a", "b"],
		);
	});

	it("returns a single empty row for empty input", () => {
		assert.deepStrictEqual(hardWrapStyledLine([], 10), [[]]);
	});
});
