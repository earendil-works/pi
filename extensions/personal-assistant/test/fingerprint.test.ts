import { describe, it, expect } from "vitest";
import { normalizeContent, computeFingerprint } from "../extraction.ts";

describe("normalizeContent", () => {
	it("collapses all whitespace to single space", () => {
		expect(normalizeContent("hello   world")).toBe("hello world");
		expect(normalizeContent("a\n\nb\tc")).toBe("a b c");
	});

	it("trims leading and trailing whitespace", () => {
		expect(normalizeContent("  hello  ")).toBe("hello");
	});

	it("lowercases all chars", () => {
		expect(normalizeContent("Hello World")).toBe("hello world");
	});

	it("handles Chinese without breaking characters", () => {
		expect(normalizeContent("中文  测试")).toBe("中文 测试");
	});

	it("returns empty for empty string", () => {
		expect(normalizeContent("")).toBe("");
	});
});

describe("computeFingerprint", () => {
	it("returns 16-char hex string", () => {
		const fp = computeFingerprint("hello");
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
	});

	it("same content → same fingerprint (after normalization)", () => {
		const a = computeFingerprint("Hello World");
		const b = computeFingerprint("hello   world\n");
		expect(a).toBe(b);
	});

	it("different content → different fingerprint", () => {
		expect(computeFingerprint("a")).not.toBe(computeFingerprint("b"));
	});

	it("handles Chinese content", () => {
		const fp = computeFingerprint("中文测试");
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
		const fp2 = computeFingerprint("中文测试 ");
		expect(fp).toBe(fp2); // whitespace normalized
	});
});