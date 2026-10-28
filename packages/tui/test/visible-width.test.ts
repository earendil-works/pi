import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth } from "../src/utils.ts";

describe("visibleWidth", () => {
	it("measures styled ASCII without counting escape sequences", () => {
		assert.strictEqual(visibleWidth("\x1b[38;5;4mhello\x1b[39m world"), 11);
		assert.strictEqual(visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), 4);
		assert.strictEqual(visibleWidth("\x1b]133;A\x1b\\prompt"), 6);
		assert.strictEqual(visibleWidth("\x1b_pi:c\x07cursor"), 6);
	});

	it("counts tabs as three columns in styled text", () => {
		assert.strictEqual(visibleWidth("\x1b[1ma\tb\x1b[22m"), 5);
	});

	it("measures styled non-ASCII text", () => {
		assert.strictEqual(visibleWidth("\x1b[31m日本\x1b[39m ok"), 7);
		assert.strictEqual(visibleWidth("\x1b[31m─→\x1b[39m"), 2);
	});

	it("treats unterminated escape sequences as zero-width control characters", () => {
		assert.strictEqual(visibleWidth("\x1b[31"), 3);
		assert.strictEqual(visibleWidth("a\x1b"), 1);
	});
});
