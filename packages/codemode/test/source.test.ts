import { describe, expect, it } from "vitest";
import { CodemodeSourceError, parseCodemodeSource } from "../src/source.ts";

describe("parseCodemodeSource", () => {
	it("returns plain code unchanged", () => {
		expect(parseCodemodeSource("return 1")).toEqual({ code: "return 1", options: {} });
		expect(parseCodemodeSource("")).toEqual({ code: "", options: {} });
		expect(parseCodemodeSource("// just a comment\nreturn 1")).toEqual({
			code: "// just a comment\nreturn 1",
			options: {},
		});
	});

	it("parses the options line and keeps line numbers", () => {
		expect(parseCodemodeSource('// @options {"timeout": 30}\nconst a = 1;\nreturn a')).toEqual({
			code: "\nconst a = 1;\nreturn a",
			options: { timeout: 30 },
		});
		expect(parseCodemodeSource('  // @options{"timeout":1.5}\r\nreturn 1').options).toEqual({ timeout: 1.5 });
		expect(parseCodemodeSource("// @options {}\nreturn 1")).toEqual({ code: "\nreturn 1", options: {} });
	});

	it("only treats the first line as options", () => {
		const input = 'return 1\n// @options {"timeout": 1}';
		expect(parseCodemodeSource(input)).toEqual({ code: input, options: {} });
		expect(parseCodemodeSource("// @optionsx {}\nreturn 1").options).toEqual({});
	});

	it("rejects invalid options", () => {
		const cases: [string, RegExp][] = [
			["// @options {timeout: 1}\nreturn 1", /must be a JSON object/],
			["// @options [1]\nreturn 1", /must be a JSON object/],
			['// @options {"yield": 1}\nreturn 1', /Unknown @options key "yield"/],
			['// @options {"timeout": 0}\nreturn 1', /positive number of seconds/],
			['// @options {"timeout": "30"}\nreturn 1', /positive number of seconds/],
			['// @options {"timeout": 30}', /must be followed by code/],
			['// @options {"timeout": 30}\n  \n', /must be followed by code/],
		];
		for (const [input, message] of cases) {
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			expect(() => parseCodemodeSource(input), input).toThrow(message);
		}
	});
});
