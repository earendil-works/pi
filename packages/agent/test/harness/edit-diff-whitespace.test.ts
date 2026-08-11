import { describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	fuzzyFindText,
	normalizeForFuzzyMatch,
} from "../../src/harness/tools/edit-diff.ts";

describe("normalizeForFuzzyMatch", () => {
	it("collapses interior runs of ASCII spaces", () => {
		expect(normalizeForFuzzyMatch("a    b")).toBe("a b");
	});

	it("collapses tabs and mixed whitespace runs", () => {
		expect(normalizeForFuzzyMatch("a\t\tb")).toBe("a b");
		expect(normalizeForFuzzyMatch("hello \t world")).toBe("hello world");
	});

	it("trims leading whitespace from each line", () => {
		expect(normalizeForFuzzyMatch("    const x = 1;")).toBe("const x = 1;");
		expect(normalizeForFuzzyMatch("  a    b")).toBe("a b");
	});

	it("collapses runs of special unicode spaces", () => {
		expect(normalizeForFuzzyMatch("a\u00A0\u00A0b")).toBe("a b");
		expect(normalizeForFuzzyMatch("a\u3000\u3000b")).toBe("a b");
	});
});

describe("fuzzyFindText whitespace equivalence", () => {
	it("matches when only the whitespace length differs", () => {
		const result = fuzzyFindText("const a    = 1;\n", "const a = 1;\n");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("matches when oldText has extra interior spaces vs the file", () => {
		const result = fuzzyFindText("const a = 1;\n", "const a    = 1;\n");
		expect(result.found).toBe(true);
	});

	it("matches when the indentation depth differs", () => {
		const result = fuzzyFindText("const a = 1;\n", "    const a = 1;\n");
		expect(result.found).toBe(true);
	});

	it("matches tab/space mixing", () => {
		const result = fuzzyFindText("hello world\n", "hello \t world\n");
		expect(result.found).toBe(true);
	});

	it("still rejects genuinely different text", () => {
		expect(fuzzyFindText("const a = 1;\n", "const b = 2;\n").found).toBe(false);
	});

	it("still rejects text that differs in non-whitespace content", () => {
		expect(fuzzyFindText("const a = 1;\n", "const a = 1; // change\n").found).toBe(false);
	});
});

describe("applyEditsToNormalizedContent with whitespace differences", () => {
	it("applies an edit whose oldText differs only in whitespace length", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"const a    = 1;\nconst b = 2;\n",
			[{ oldText: "const a = 1;", newText: "const a = 10;" }],
			"test.ts",
		);
		expect(newContent).toBe("const a = 10;\nconst b = 2;\n");
	});

	it("still raises a duplicate error when whitespace collapse makes oldText ambiguous", () => {
		expect(() =>
			applyEditsToNormalizedContent("x  = 1\nx = 1\n", [{ oldText: "x = 1", newText: "y = 1" }], "test.ts"),
		).toThrow(/unique/);
	});
});
