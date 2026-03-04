import { describe, expect, it } from "vitest";
import { fixThinkingSpill, normalizeExcessiveWhitespace, normalizePunctuationSpacing } from "./thinking-spill.js";

describe("fixThinkingSpill", () => {
	it("strips a duplicated thinking prefix from the response text", () => {
		const result = fixThinkingSpill("THINKING", "THINKING\n\nANSWER");
		expect(result.thinking).toBe("THINKING");
		expect(result.text).toBe("ANSWER");
	});

	it("strips a duplicated thinking suffix from the response text", () => {
		const result = fixThinkingSpill("THINKING", "ANSWER\n\nTHINKING");
		expect(result.thinking).toBe("THINKING");
		expect(result.text).toBe("ANSWER");
	});

	it("drops thinking on exact duplicates when configured", () => {
		const result = fixThinkingSpill("DUP", "DUP", { exactDuplicateStrategy: "dropThinking" });
		expect(result.thinking).toBe("");
		expect(result.text).toBe("DUP");
	});

	it("drops text on exact duplicates when configured", () => {
		const result = fixThinkingSpill("DUP", "DUP", { exactDuplicateStrategy: "dropText" });
		expect(result.thinking).toBe("DUP");
		expect(result.text).toBe("");
	});
});

describe("normalizeExcessiveWhitespace", () => {
	it("strips shared leading spaces from all lines", () => {
		expect(normalizeExcessiveWhitespace(" ONE\n TWO\n")).toBe("ONE\nTWO\n");
	});

	it("strips shared tab indentation from all lines", () => {
		expect(normalizeExcessiveWhitespace("\tONE\n\t\tTWO\n")).toBe("ONE\n\tTWO\n");
	});

	it("preserves relative indentation after dedenting tab-indented blocks", () => {
		expect(normalizeExcessiveWhitespace("\tone\n\t  two\n")).toBe("one\n  two\n");
	});

	it("does not dedent when only a single line has indentation", () => {
		expect(normalizeExcessiveWhitespace("NONE\n  INDENT\n")).toBe("NONE\n  INDENT\n");
	});

	it("does not dedent mixed tab/space indentation without a common prefix", () => {
		expect(normalizeExcessiveWhitespace("\tONE\n  TWO\n")).toBe("\tONE\n  TWO\n");
	});
});

describe("normalizePunctuationSpacing", () => {
	it("joins newline + space punctuation continuations", () => {
		expect(normalizePunctuationSpacing("Hey\n ! Doing well")).toBe("Hey! Doing well");
	});

	it("removes plain spaces before punctuation", () => {
		expect(normalizePunctuationSpacing("Hello !")).toBe("Hello!");
	});

	it("preserves markdown image syntax", () => {
		expect(normalizePunctuationSpacing("See below\n![alt](img.png)")).toBe("See below\n![alt](img.png)");
	});
});
