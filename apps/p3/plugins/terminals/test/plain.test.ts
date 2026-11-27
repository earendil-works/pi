// A terminal's output as the agent reads it (plain.ts): escape sequences (CSI, OSC ended by BEL or ST, two-byte) and
// control characters taken out, tab and newline kept, CRLF as a newline; a sequence cut at the start of the kept
// output leaves its tail.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plain } from "../plain.ts";

describe("plain text of a terminal's output", () => {
	it("drops escape sequences and control characters, keeps tabs and newlines", () => {
		assert.equal(plain("\u001b[1;31mred\u001b[0m\tok\r\n"), "red\tok\n");
		assert.equal(plain("\u001b]0;title\u0007a\u001b]8;;http://x\u001b\\b\u001b(Bc"), "abc");
		assert.equal(plain("x\u0008\u007fy\rz"), "xyz");
	});

	it("leaves the tail of a sequence cut at the start", () => {
		assert.equal(plain("31mred"), "31mred");
	});
});
