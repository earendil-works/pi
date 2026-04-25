import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.js";

describe("repairJson", () => {
	it("should return valid JSON unchanged", () => {
		const input = '{"key": "value", "number": 42}';
		expect(repairJson(input)).toBe(input);
	});

	it("should escape raw newlines inside string values", () => {
		const input = '{"text": "line1\nline2"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "line1\\nline2"}');
		expect(JSON.parse(repaired)).toEqual({ text: "line1\nline2" });
	});

	it("should escape raw tabs inside string values", () => {
		const input = '{"text": "col1\tcol2"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "col1\\tcol2"}');
		expect(JSON.parse(repaired)).toEqual({ text: "col1\tcol2" });
	});

	it("should escape raw carriage returns inside string values", () => {
		const input = '{"text": "line1\r\nline2"}';
		const repaired = repairJson(input);
		expect(JSON.parse(repaired)).toEqual({ text: "line1\r\nline2" });
	});

	it("should escape raw backspace characters inside string values", () => {
		const input = '{"text": "before\bafter"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "before\\bafter"}');
	});

	it("should escape raw form feed characters inside string values", () => {
		const input = '{"text": "before\fafter"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "before\\fafter"}');
	});

	it("should escape other control characters as \\uXXXX", () => {
		const input = '{"text": "before\x01after"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "before\\u0001after"}');
		expect(JSON.parse(repaired)).toEqual({ text: "before\x01after" });
	});

	it("should not modify control characters outside strings", () => {
		const input = '{"key": "value"}\n';
		// Newline outside a string is fine in JSON
		expect(repairJson(input)).toBe(input);
	});

	it("should handle backslash before invalid escape characters", () => {
		// Raw backslash before 'a' (not a valid JSON escape) gets doubled
		const input = '{"text": "before\\aafter"}';
		// In the source string, \\a is raw \a. repairJson doubles the backslash → \\a
		// JSON.parse('\\a') = \a
		expect(JSON.parse(repairJson(input))).toEqual({ text: "before\\aafter" });
	});

	it("should handle consecutive control characters", () => {
		const input = '{"text": "a\n\tb"}';
		const repaired = repairJson(input);
		expect(JSON.parse(repaired)).toEqual({ text: "a\n\tb" });
	});

	it("should preserve valid JSON escape sequences", () => {
		const input =
			'{"text": "quote: \\" backslash: \\\\ slash: \\/ backspace: \\b formfeed: \\f newline: \\n cr: \\r tab: \\t"}';
		expect(repairJson(input)).toBe(input);
		expect(JSON.parse(repairJson(input))).toEqual({
			text: 'quote: " backslash: \\ slash: / backspace: \b formfeed: \f newline: \n cr: \r tab: \t',
		});
	});

	it("should preserve valid unicode escapes", () => {
		const input = '{"text": "\\u0048\\u0065\\u006C\\u006C\\u006F"}';
		expect(repairJson(input)).toBe(input);
		expect(JSON.parse(repairJson(input))).toEqual({ text: "Hello" });
	});

	it("should handle empty string", () => {
		expect(repairJson("")).toBe("");
	});

	it("should handle non-string values outside strings", () => {
		const input = '{"num": 42, "bool": true, "null": null}';
		expect(repairJson(input)).toBe(input);
	});

	it("should handle nested JSON strings with control characters", () => {
		const input = '{"outer": "has\nnewline", "nested": {"inner": "also\nhas\nnewlines"}}';
		const repaired = repairJson(input);
		const parsed = JSON.parse(repaired);
		expect(parsed).toEqual({
			outer: "has\nnewline",
			nested: { inner: "also\nhas\nnewlines" },
		});
	});

	it("should handle arrays with control characters in strings", () => {
		const input = '{"items": ["line1\nline2", "normal"]}';
		const repaired = repairJson(input);
		expect(JSON.parse(repaired)).toEqual({
			items: ["line1\nline2", "normal"],
		});
	});

	it("should handle strings containing quotes", () => {
		const input = '{"text": "He said \\"hello\\""}';
		expect(repairJson(input)).toBe(input);
		expect(JSON.parse(repairJson(input))).toEqual({ text: 'He said "hello"' });
	});
});

describe("parseJsonWithRepair", () => {
	it("should parse valid JSON without modification", () => {
		expect(parseJsonWithRepair('{"key": "value"}')).toEqual({ key: "value" });
	});

	it("should parse and repair JSON with control characters", () => {
		const result = parseJsonWithRepair('{"text": "line1\nline2"}');
		expect(result).toEqual({ text: "line1\nline2" });
	});

	it("should throw for irreparable JSON", () => {
		expect(() => parseJsonWithRepair("{invalid")).toThrow();
	});
});

describe("parseStreamingJson", () => {
	it("should return empty object for undefined input", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("should return empty object for empty string", () => {
		expect(parseStreamingJson("")).toEqual({});
	});

	it("should return empty object for whitespace-only input", () => {
		expect(parseStreamingJson("   ")).toEqual({});
	});

	it("should parse complete valid JSON", () => {
		expect(parseStreamingJson('{"key": "value"}')).toEqual({ key: "value" });
	});

	it("should parse incomplete JSON using partial parser", () => {
		// Partial JSON: object with one complete key and one partial
		const result = parseStreamingJson('{"key": "value", "partial":');
		expect(result).toEqual({ key: "value" });
	});

	it("should handle incomplete JSON with repair fallback", () => {
		const result = parseStreamingJson('{"text": "hello');
		expect(result).toHaveProperty("text");
	});
});
