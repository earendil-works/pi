import { describe, expect, it } from "vitest";

import { parseHandoffFileSelections } from "../src/handoff-file-selection.js";

describe("parseHandoffFileSelections", () => {
	it("parses XML file tags from anywhere", () => {
		const input = "prefix <file>src/a.ts</file> middle <file>src/b.ts:10-20</file> tail";
		const result = parseHandoffFileSelections(input);
		expect(result).toEqual(["src/a.ts", "src/b.ts:10-20"]);
	});

	it("parses container tags with newlines", () => {
		const input = "<handoff_files>\n<file>src/a.ts</file>\n<file>src/b.ts</file>\n</handoff_files>";
		const result = parseHandoffFileSelections(input);
		expect(result).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("deduplicates and trims file entries", () => {
		const input = "<file> src/a.ts </file><file>src/a.ts</file><file>src/b.ts</file>";
		const result = parseHandoffFileSelections(input);
		expect(result).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("parses self-closing file tags with path attribute", () => {
		const input = '<file path="src/a.ts" /><file path="src/b.ts:5-9"/>';
		const result = parseHandoffFileSelections(input);
		expect(result).toEqual(["src/a.ts", "src/b.ts:5-9"]);
	});

	it("returns empty array when no file tags exist", () => {
		const input = "No files listed here.";
		const result = parseHandoffFileSelections(input);
		expect(result).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(parseHandoffFileSelections("\n\n")).toEqual([]);
	});
});
