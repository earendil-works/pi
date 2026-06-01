import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, visibleWidth } from "../src/utils.ts";
import { TUI } from "../src/tui.ts";

const dummyTerminal = {
	columns: 80,
	rows: 24,
	write() {},
	hideCursor() {},
	showCursor() {},
	start() {},
	stop() {},
};

describe("overlay CJK boundary regression", () => {
	it("does not keep a wide grapheme in before when overlay starts inside it", () => {
		const { before, beforeWidth } = extractSegments("abcd让EFGH", 5, 9, 11, true);
		assert.strictEqual(before.includes("让"), false);
		assert.strictEqual(beforeWidth, 4);
		assert.strictEqual(before, "abcd");
	});

	it("composites overlay without leaking wide char before overlay (col 5)", () => {
		const tui = new TUI(dummyTerminal);
		const out = tui.compositeLineAt("abcd让EFGH", "│XX│", 5, 4, 20);
		assert.strictEqual(out.includes("让"), false);
		assert.strictEqual(visibleWidth(out), 20);
	});

	it("composites overlay at wide char start (col 4)", () => {
		const tui = new TUI(dummyTerminal);
		const out = tui.compositeLineAt("abcd让EFGH", "│XX│", 4, 4, 20);
		assert.strictEqual(out.includes("让"), false);
		assert.strictEqual(visibleWidth(out), 20);
	});

	it("keeps ASCII control behavior when overlay starts at col 5", () => {
		const { before, beforeWidth } = extractSegments("abcdG EFGH", 5, 9, 11, true);
		assert.strictEqual(before, "abcdG");
		assert.strictEqual(beforeWidth, 5);
	});
});
