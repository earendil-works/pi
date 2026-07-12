import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("export HTML read ranges", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const helperSource = templateJs.match(/function formatReadLineRange\(offset, limit\) \{[\s\S]*?^ {6}\}/m)?.[0];
	if (!helperSource) throw new Error("formatReadLineRange helper not found in export template");
	const formatReadLineRange = new Function(`${helperSource}; return formatReadLineRange;`)() as (
		offset: unknown,
		limit: unknown,
	) => string;

	it("renders numeric string arguments as an arithmetic range", () => {
		expect(formatReadLineRange("380", "50")).toBe(":380-429");
		expect(formatReadLineRange("580", "50")).toBe(":580-629");
	});

	it("preserves numeric arguments", () => {
		expect(formatReadLineRange(380, 50)).toBe(":380-429");
	});
});
