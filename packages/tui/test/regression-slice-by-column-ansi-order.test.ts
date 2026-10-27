import assert from "node:assert";
import { describe, it } from "node:test";
import { sliceByColumn } from "../src/utils.ts";

// https://github.com/earendil-works/pi/issues/10169
describe("sliceByColumn ANSI order regression", () => {
	it("keeps a reset at the slice start after earlier style codes", () => {
		const line = "\x1b[32mfoo\x1b[39m bar";
		assert.strictEqual(sliceByColumn(line, 3, 4, true), "\x1b[32m\x1b[39m bar");
	});

	it("does not leak color into text after a highlighted token", () => {
		const line = "Another \x1b[35malpha\x1b[39m line with \x1b[35mbeta\x1b[39m later.";
		const after = sliceByColumn(line, 13, 100, true);
		assert.strictEqual(after, "\x1b[35m\x1b[39m line with \x1b[35mbeta\x1b[39m later.");
	});
});
