// Tests of the terminal's output filter (slice 11 §4): text and drawing sequences pass; the clipboard (OSC 52), titles,
// other control strings, unknown modes and charset changes are dropped; an unterminated sequence ends with its frame;
// a frame over 64 KiB is refused.

import { describe, expect, it } from "vitest";
import { filterOutput, MAX_FRAME } from "../../../src/node/tui/filter.ts";

describe("what passes", () => {
	it("keeps text, cursor moves, erasing, colours, the alternate screen and bracketed paste", () => {
		const frame =
			"\x1b[?1049h\x1b[2J\x1b[H\x1b[1;31mred\x1b[0m\r\n\x1b[38;2;1;2;3mtrue\x1b[39m\x1b[5;10H\x1b[K\x1b[?2004h\x1b[?25l\ttab";
		expect(filterOutput(frame)).toBe(frame);
	});
});

describe("what is dropped", () => {
	it("drops the clipboard, the title and every other control string, keeping the text around them", () => {
		expect(filterOutput("a\x1b]52;c;aGVsbG8=\x07b")).toBe("ab");
		expect(filterOutput("a\x1b]0;evil title\x1b\\b")).toBe("ab");
		expect(filterOutput("a\x1bPq#0;2;0;0;0\x1b\\b")).toBe("ab");
		expect(filterOutput("a\x9d52;c;x\x9cb")).toBe("ab");
	});

	it("drops unknown modes, charset changes, other ESC sequences and control characters", () => {
		expect(filterOutput("\x1b[?1003h\x1b[?9h\x1b(0\x1bc\x07\x00x\x7f")).toBe("x");
		expect(filterOutput("\x1b[99999m")).toBe("");
		expect(filterOutput("\x1b[1;2;3H")).toBe("");
	});

	it("ends an unterminated sequence with its frame (nothing smuggled into the next)", () => {
		expect(filterOutput("ok\x1b]52;c;aGVsbG8=")).toBe("ok");
		expect(filterOutput("then text")).toBe("then text");
	});

	it("refuses a frame over 64 KiB", () => {
		expect(() => filterOutput("x".repeat(MAX_FRAME + 1))).toThrow("64 KiB");
	});
});
