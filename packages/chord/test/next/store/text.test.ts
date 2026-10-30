// Text rules (slice 6a §5): code point order, stored text (lone surrogates replaced, NUL refused), prefix bounds.

import { describe, expect, it } from "vitest";
import { compareText, prefixUpperBound, storedText } from "../../../src/next/store/text.ts";

describe("compareText", () => {
	it("orders by code point: a supplementary character after every BMP character, U+E000 to U+FFFF included", () => {
		const sorted = ["\u{10000}", "\uFFFF", "\uE000", "\uD7FF", "z", "a", "", "ab"].sort(compareText);
		expect(sorted).toEqual(["", "a", "ab", "z", "\uD7FF", "\uE000", "\uFFFF", "\u{10000}"]);
		expect(compareText("a", "a")).toBe(0);
		expect(compareText("\u{1F600}", "\u{1F601}")).toBeLessThan(0);
	});

	it("agrees with UTF-8 byte order", () => {
		const encode = (text: string) => [...new TextEncoder().encode(text)];
		const texts = ["\u{1F600}", "\uFF5E", "\u00E9", "e", "\u{10FFFF}", "\uE000", "aa", "a"];
		const byBytes = [...texts].sort((a, b) => {
			const [x, y] = [encode(a), encode(b)];
			for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
			return x.length - y.length;
		});
		expect([...texts].sort(compareText)).toEqual(byBytes);
	});
});

describe("storedText", () => {
	it("keeps well-formed text as it is and replaces a lone surrogate with U+FFFD", () => {
		const text = "a\u{1F600}b";
		expect(storedText(text, "v")).toBe(text);
		expect(storedText("a\uD800b", "v")).toBe("a\uFFFDb");
	});

	it("refuses NUL with invalid/args", () => {
		expect(() => storedText("a\0b", "edits.path")).toThrow(
			expect.objectContaining({ code: "invalid", reason: "args" }),
		);
	});
});

describe("prefixUpperBound", () => {
	it("is the next code point after the last one", () => {
		expect(prefixUpperBound("a/")).toBe("a0");
		expect(prefixUpperBound("a\u{1F600}")).toBe("a\u{1F601}");
		expect(prefixUpperBound("\uFFFF")).toBe("\u{10000}");
	});

	it("skips the surrogates and carries past U+10FFFF", () => {
		expect(prefixUpperBound("\uD7FF")).toBe("\uE000");
		expect(prefixUpperBound("a\u{10FFFF}")).toBe("b");
		expect(prefixUpperBound("\u{10FFFF}\u{10FFFF}")).toBeUndefined();
		expect(prefixUpperBound("")).toBeUndefined();
	});

	it("bounds exactly the strings starting with the prefix, in code point order", () => {
		const texts = ["a", "a/", "a/x", "a/\u{1F600}", "a/\uFFFF", "a0", "a.", "b"];
		for (const prefix of ["a/", "a", "a/\uFFFF"]) {
			const upper = prefixUpperBound(prefix)!;
			const inRange = texts.filter((t) => compareText(t, prefix) >= 0 && compareText(t, upper) < 0);
			expect(inRange).toEqual(texts.filter((t) => t.startsWith(prefix)));
		}
	});
});
