// Terminal output for the agent: the output ring's absolute offsets and overflow, and plain text as a terminal shows
// it line by line (escape sequences removed, carriage-return overwrites, backspaces, erase in line).
import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputRing, plainText } from "../../plugins/terminals/plain.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

test("the output ring keeps the last bytes at absolute offsets and counts what it lost", () => {
	const ring = new OutputRing(8);
	ring.append(bytes("abc"));
	assert.deepEqual([ring.start, ring.end], [0, 3]);
	assert.deepEqual({ ...ring.since(1), bytes: text(ring.since(1).bytes) }, { bytes: "bc", skipped: 0 });
	ring.append(bytes("defgh"));
	ring.append(bytes("ij"));
	assert.deepEqual([ring.start, ring.end], [2, 10]);
	// Reading from 0: the first two bytes are gone.
	assert.deepEqual({ ...ring.since(0), bytes: text(ring.since(0).bytes) }, { bytes: "cdefghij", skipped: 2 });
	assert.equal(text(ring.since(7).bytes), "hij");
	assert.equal(text(ring.since(10).bytes), "");
	// A chunk larger than the ring keeps its tail.
	ring.append(bytes("0123456789AB"));
	assert.deepEqual([ring.start, ring.end], [14, 22]);
	assert.equal(text(ring.since(14).bytes), "456789AB");
	assert.equal(ring.since(12).skipped, 2);
});

test("plain text: escape sequences go, overwrites and backspaces apply", () => {
	// Colors (CSI), a title (OSC with BEL and with ST), a DCS string, charset selection, a keypad mode.
	assert.equal(
		plainText("\x1b[1;31mred\x1b[0m \x1b]0;title\x07\x1b]2;t\x1b\\x\x1bPq#0\x1b\\y\x1b(Bz\x1b=!"),
		"red xyz!",
	);
	// A progress bar keeps its final state; CRLF is a newline.
	assert.equal(plainText("10%\r50%\r100%\r\ndone\r\n"), "100%\ndone\n");
	// Overwriting a longer line keeps its tail unless the line is erased.
	assert.equal(plainText("downloading\rdone"), "doneloading");
	assert.equal(plainText("downloading\r\x1b[Kdone"), "done");
	assert.equal(plainText("abc\x1b[2Kx"), "   x");
	assert.equal(plainText("abc\b\bX"), "aXc");
	assert.equal(plainText("\b\bab"), "ab");
	// Other control characters go; tabs stay; trailing spaces are trimmed, except on the last line (a prompt).
	assert.equal(plainText("a\x07b\x00c\td   \n$ "), "abc\td\n$ ");
	// C1 forms of CSI and OSC.
	assert.equal(plainText("a\x9b31mb\x9d0;t\x9cc"), "abc");
	// A sequence cut off at the end leaves nothing behind.
	assert.equal(plainText("ok\x1b[3"), "ok");
	assert.equal(plainText("ok\x1b]0;unterminated"), "ok");
});
