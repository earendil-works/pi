import assert from "node:assert";
import { describe, it } from "node:test";
import { parseSgrMouseEvent } from "../src/mouse.js";

describe("parseSgrMouseEvent", () => {
	it("parses left-button press sequences", () => {
		assert.deepStrictEqual(parseSgrMouseEvent("\x1b[<0;12;7M"), {
			kind: "press",
			button: "left",
			row: 6,
			col: 11,
			shift: false,
			alt: false,
			ctrl: false,
			raw: "\x1b[<0;12;7M",
		});
	});

	it("returns undefined for release sequences in v1", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;12;7m"), undefined);
	});

	it("returns undefined for unsupported buttons", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[<64;12;7M"), undefined);
	});

	it("returns undefined for non-mouse input", () => {
		assert.strictEqual(parseSgrMouseEvent("j"), undefined);
	});
});
