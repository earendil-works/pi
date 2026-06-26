import { describe, it, expect } from "vitest";
import { normalizeTags } from "../tag-alias.ts";

describe("normalizeTags", () => {
	it("trims whitespace and drops empty entries", () => {
		expect(normalizeTags([" 代码规范 ", "", "code-style"])).toEqual([
			"代码规范",
			"code-style",
		]);
	});

	it("folds tag aliases to canonical and dedupes", () => {
		const aliases = {
			"代码规范": "code-style",
			"coding-rule": "code-style",
		};
		expect(normalizeTags(["代码规范", "coding-rule", "code-style"], aliases)).toEqual([
			"code-style",
		]);
	});

	it("dedupes with no aliases (undefined)", () => {
		expect(normalizeTags(["a", "a", "b"])).toEqual(["a", "b"]);
	});

	it("skips alias folding when aliases is null", () => {
		expect(normalizeTags(["a", "a", "b"], null)).toEqual(["a", "b"]);
	});

	it("skips alias folding when aliases is an empty object", () => {
		expect(normalizeTags(["a", "b"], {})).toEqual(["a", "b"]);
	});

	it("skips alias folding and dedupes when aliases is a non-object string", () => {
		const bogus = "not-an-object" as unknown as Record<string, string>;
		expect(normalizeTags(["a", "a", "b"], bogus)).toEqual(["a", "b"]);
	});

	it("returns [] for empty input", () => {
		expect(normalizeTags([])).toEqual([]);
	});

	it("returns [] when every entry is blank", () => {
		expect(normalizeTags([" ", ""])).toEqual([]);
	});

	it("resolves alias chains with cycle protection", () => {
		const aliases = { a: "b", b: "c" };
		expect(normalizeTags(["a"], aliases)).toEqual(["c"]);
	});

	it("breaks a real cycle (a→b→a) by stopping at the revisited node", () => {
		const aliases = { a: "b", b: "a" };
		expect(normalizeTags(["a"], aliases)).toEqual(["b"]);
	});

	it("caps alias chain depth at 10 and returns the 10th node", () => {
		const aliases = {
			a: "b", b: "c", c: "d", d: "e", e: "f", f: "g", g: "h", h: "i", i: "j", j: "k", k: "l",
		};
		expect(normalizeTags(["a"], aliases)).toEqual(["k"]);
	});
});
