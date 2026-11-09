import assert from "node:assert";
import { describe, it } from "node:test";
import { getGraphemeCellRange, sliceWithWidth } from "../src/utils.ts";

// #9549: slicing splits standalone characters without Intl.Segmenter; clusters must stay intact.
describe("grapheme slicing", () => {
	it("slices box drawing, arrows and CJK by cell", () => {
		const line = "│ a → 中文 ✓ │";
		assert.deepStrictEqual(sliceWithWidth(line, 0, 6, true), { text: "│ a → ", width: 6 });
		assert.deepStrictEqual(sliceWithWidth(line, 6, 4, true), { text: "中文", width: 4 });
		assert.deepStrictEqual(sliceWithWidth(line, 7, 3, true), { text: "文", width: 2 });
		assert.deepStrictEqual(getGraphemeCellRange(line, 7), { start: 6, end: 8 });
	});

	it("keeps clusters that join standalone characters", () => {
		// A ZWJ joins the heart to the preceding emoji; the combining accent joins its base letter.
		const family = "x👨\u200d❤y";
		assert.strictEqual(sliceWithWidth(family, 1, 2, true).text, "👨\u200d❤");
		const accented = "→e\u0301→";
		assert.deepStrictEqual(sliceWithWidth(accented, 1, 1, true), { text: "e\u0301", width: 1 });
		assert.deepStrictEqual(getGraphemeCellRange(accented, 2), { start: 2, end: 3 });
	});
});
