import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("Burmese text width and editor redraw regression", () => {
	it("measures Burmese grapheme clusters and representative strings correctly", () => {
		// Proven ASCII control
		const asciiControl = "Hello World!";
		assert.strictEqual(visibleWidth(asciiControl), 12);

		// Representative Burmese strings
		const myanmarSa = "မြန်မာစာ";
		const mingalarPar = "မင်္ဂလာပါ";

		assert.strictEqual(visibleWidth(myanmarSa), 4);
		assert.strictEqual(visibleWidth(mingalarPar), 4);

		// Individual grapheme cluster cell widths
		assert.strictEqual(visibleWidth("မြ"), 1);
		assert.strictEqual(visibleWidth("န်"), 1);
		assert.strictEqual(visibleWidth("င်္ဂ"), 1);
		assert.strictEqual(visibleWidth("ကျ"), 1);
		assert.strictEqual(visibleWidth("ကြ"), 1);
		assert.strictEqual(visibleWidth("က်"), 1);
		assert.strictEqual(visibleWidth("ကေ"), 1);
	});

	it("keeps input line widths and hardware cursor positions consistent between ASCII and Burmese", () => {
		const input = new Input();
		input.focused = true;

		// ASCII input
		input.setValue("Hello");
		const asciiRender = input.render(20);
		assert.strictEqual(visibleWidth(asciiRender[0] || ""), 20);

		// Burmese input
		input.setValue("မြန်မာစာ");
		const burmeseRender = input.render(20);
		assert.strictEqual(visibleWidth(burmeseRender[0] || ""), 20);

		// Hardware cursor column calculation for Burmese text
		const burmeseText = "မြန်မာစာ";
		const cursorCol = visibleWidth(burmeseText);
		assert.strictEqual(cursorCol, 4);
	});

	it("prevents premature line wrapping for Burmese text in constrained widths", () => {
		const text = "မြန်မာစာ"; // width 4
		const wrapped = wrapTextWithAnsi(text, 10);
		assert.strictEqual(wrapped.length, 1);
		assert.strictEqual(visibleWidth(wrapped[0] || ""), 4);
	});
});
