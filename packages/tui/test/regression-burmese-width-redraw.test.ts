import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
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

		// Standalone combining mark behavior
		assert.strictEqual(visibleWidth("ာ"), 0);
	});

	it("keeps input line widths and hardware cursor marker position consistent between ASCII and Burmese", () => {
		const input = new Input();
		input.focused = true;

		// ASCII input - cursor at end ("Hello")
		// Prompt prefix is "> " (width 2)
		input.setValue("Hello");
		input.handleInput("\x1b[F");
		const asciiRender = input.render(20);
		assert.strictEqual(visibleWidth(asciiRender[0] || ""), 20);

		const asciiLine = asciiRender[0] || "";
		const asciiMarkerIdx = asciiLine.indexOf(CURSOR_MARKER);
		assert.notStrictEqual(asciiMarkerIdx, -1);
		// "> " (2) + "Hello" (5) = 7
		assert.strictEqual(visibleWidth(asciiLine.slice(0, asciiMarkerIdx)), 7);

		// Burmese input - cursor at end ("မြန်မာစာ")
		input.setValue("မြန်မာစာ");
		input.handleInput("\x1b[F");
		const burmeseRender = input.render(20);
		assert.strictEqual(visibleWidth(burmeseRender[0] || ""), 20);

		const burmeseLine = burmeseRender[0] || "";
		const burmeseMarkerIdx = burmeseLine.indexOf(CURSOR_MARKER);
		assert.notStrictEqual(burmeseMarkerIdx, -1);
		// "> " (2) + "မြန်မာစာ" (4) = 6
		assert.strictEqual(visibleWidth(burmeseLine.slice(0, burmeseMarkerIdx)), 6);

		// Burmese input - cursor in middle (after "မြန်မာ")
		input.setValue("မြန်မာစာ");
		input.handleInput("\x1b[F"); // move to end
		input.handleInput("\x1b[D"); // move left 1 char
		input.handleInput("\x1b[D"); // move left 1 char ("မြန်မာ")
		const midRender = input.render(20);
		const midLine = midRender[0] || "";
		const midMarkerIdx = midLine.indexOf(CURSOR_MARKER);
		assert.notStrictEqual(midMarkerIdx, -1);
		// "> " (2) + "မြန်မာ" (3) = 5
		assert.strictEqual(visibleWidth(midLine.slice(0, midMarkerIdx)), 5);
	});

	it("prevents premature line wrapping for Burmese text in constrained widths", () => {
		const text = "မြန်မာစာ"; // width 4
		const wrapped = wrapTextWithAnsi(text, 10);
		assert.strictEqual(wrapped.length, 1);
		assert.strictEqual(visibleWidth(wrapped[0] || ""), 4);
	});
});
