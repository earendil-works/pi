import { describe, expect, it } from "vitest";
import { sliceHead, sliceTail, truncateLine } from "../src/core/tools/truncate.ts";

const EMOJI = "\u{1F600}"; // two UTF-16 code units: \uD83D\uDE00

function hasLoneSurrogate(text: string): boolean {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

// https://github.com/earendil-works/pi/issues/7121
describe("surrogate-safe slicing", () => {
	it("truncateLine does not cut an emoji in half at the limit", () => {
		const line = `${"a".repeat(499)}${EMOJI}tail`;
		const { text, wasTruncated } = truncateLine(line, 500);
		expect(wasTruncated).toBe(true);
		expect(text).toBe(`${"a".repeat(499)}... [truncated]`);
		expect(hasLoneSurrogate(text)).toBe(false);
	});

	it("truncateLine keeps an emoji that ends exactly at the limit", () => {
		const line = `${"a".repeat(498)}${EMOJI}tail`;
		expect(truncateLine(line, 500).text).toBe(`${"a".repeat(498)}${EMOJI}... [truncated]`);
	});

	it("sliceHead and sliceTail never split a pair", () => {
		const text = `${EMOJI}x${EMOJI}`;
		for (let units = 0; units <= text.length + 1; units++) {
			const head = sliceHead(text, units);
			const tail = sliceTail(text, units);
			expect(hasLoneSurrogate(head)).toBe(false);
			expect(hasLoneSurrogate(tail)).toBe(false);
			expect(text.startsWith(head)).toBe(true);
			expect(text.endsWith(tail)).toBe(true);
			expect(head.length).toBeGreaterThanOrEqual(Math.min(units, text.length) - 1);
			expect(tail.length).toBeGreaterThanOrEqual(Math.min(units, text.length) - 1);
		}
	});

	it("sliceHead and sliceTail match slice on text without surrogates", () => {
		expect(sliceHead("abcdef", 3)).toBe("abc");
		expect(sliceTail("abcdef", 3)).toBe("def");
		expect(sliceHead("abc", 10)).toBe("abc");
		expect(sliceTail("abc", 10)).toBe("abc");
		expect(sliceHead("abc", 0)).toBe("");
		expect(sliceTail("abc", 0)).toBe("");
	});
});
