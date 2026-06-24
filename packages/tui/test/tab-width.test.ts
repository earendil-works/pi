import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, sliceWithWidth, visibleWidth } from "../src/utils.ts";

describe("tab width accounting", () => {
	it("keeps slice helper widths consistent with visible width", () => {
		const text = "out 192M\t.pi/skill-tests/results-ha";
		const slice = sliceWithWidth(text, 0, 10, true);

		assert.strictEqual(slice.text, "out 192M");
		assert.strictEqual(slice.width, 8);
		assert.strictEqual(visibleWidth(slice.text), slice.width);
	});

	it("keeps overlay segment widths consistent with visible width", () => {
		const text = "out 192M\t.pi/skill-tests/results-ha";
		const segments = extractSegments(text, 10, 13, 10, true);

		assert.strictEqual(segments.before, "out 192M");
		assert.strictEqual(segments.beforeWidth, 8);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);

		const tabFits = extractSegments(text, 11, 13, 10, true);
		assert.strictEqual(tabFits.before, "out 192M\t");
		assert.strictEqual(tabFits.beforeWidth, 11);
		assert.strictEqual(visibleWidth(tabFits.before), tabFits.beforeWidth);
	});
});
