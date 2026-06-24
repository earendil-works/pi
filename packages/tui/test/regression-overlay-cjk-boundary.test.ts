import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import { extractSegments, sliceByColumn, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

type TuiComposite = {
	compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string;
};

function compositeLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const tui = new TUI(new VirtualTerminal(totalWidth, 10)) as unknown as TuiComposite;
	return tui.compositeLineAt(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
}

describe("overlay CJK boundary regression", () => {
	it("excludes a wide grapheme from before when overlay starts inside it", () => {
		const segments = extractSegments("abcd让EFGH", 5, 9, 11, true);

		assert.strictEqual(segments.before, "abcd");
		assert.strictEqual(segments.beforeWidth, 4);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
		assert.strictEqual(segments.after, "H");
		assert.strictEqual(segments.afterWidth, 1);
	});

	it("keeps ASCII before-segment behavior at the same boundary", () => {
		const segments = extractSegments("abcdG EFGH", 5, 9, 11, true);

		assert.strictEqual(segments.before, "abcdG");
		assert.strictEqual(segments.beforeWidth, 5);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
	});

	it("composites an overlay at the requested column when it starts inside a wide grapheme", () => {
		const out = compositeLineAt("abcd让EFGH", "│XX│", 5, 4, 20);
		const prefix = sliceByColumn(out, 0, 5, true);
		const overlay = sliceByColumn(out, 5, 4, true);

		assert.strictEqual(out.includes("让"), false);
		assert.strictEqual(visibleWidth(out), 20);
		assert.strictEqual(visibleWidth(prefix), 5);
		assert.strictEqual(visibleWidth(overlay), 4);
		assert.strictEqual(overlay.includes("│XX│"), true);
	});

	it("composites an overlay when it starts at a wide grapheme boundary", () => {
		const out = compositeLineAt("abcd让EFGH", "│XX│", 4, 4, 20);
		const overlay = sliceByColumn(out, 4, 4, true);

		assert.strictEqual(out.includes("让"), false);
		assert.strictEqual(visibleWidth(out), 20);
		assert.strictEqual(visibleWidth(overlay), 4);
		assert.strictEqual(overlay.includes("│XX│"), true);
	});
});
