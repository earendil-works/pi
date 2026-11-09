import { describe, expect, it } from "vitest";
import { globToFullPathRegex } from "../src/core/tools/find-glob-regex.ts";

// The generated regexes use syntax shared by Rust's regex crate (fd) and JavaScript, so their
// matching is checked here with RegExp against both Windows and POSIX absolute paths.
function matches(pattern: string, candidate: string): boolean {
	return new RegExp(globToFullPathRegex(pattern)).test(candidate);
}

describe("globToFullPathRegex", () => {
	it("matches '**/' prefixes and middle '**' components across any number of directories", () => {
		const pattern = "**/src/**/*.spec.ts";
		expect(matches(pattern, String.raw`C:\repo\src\a.spec.ts`)).toBe(true);
		expect(matches(pattern, String.raw`C:\repo\src\foo\bar\a.spec.ts`)).toBe(true);
		expect(matches(pattern, "/repo/src/foo/a.spec.ts")).toBe(true);
		expect(matches(pattern, String.raw`C:\repo\src/foo\a.spec.ts`)).toBe(true);
		expect(matches(pattern, String.raw`C:\repo\lib\a.spec.ts`)).toBe(false);
		expect(matches(pattern, String.raw`C:\repo\mysrc\a.spec.ts`)).toBe(false);
	});

	it("keeps '*' and '?' within one path component", () => {
		expect(matches("**/src/*.ts", String.raw`C:\repo\src\a.ts`)).toBe(true);
		expect(matches("**/src/*.ts", String.raw`C:\repo\src\foo\a.ts`)).toBe(false);
		expect(matches("**/src/?.ts", String.raw`C:\repo\src\a.ts`)).toBe(true);
		expect(matches("**/src/?.ts", String.raw`C:\repo\src\ab.ts`)).toBe(false);
		expect(matches("**/a**b/x", String.raw`C:\repo\a1b\x`)).toBe(true);
		expect(matches("**/a**b/x", String.raw`C:\repo\a\b\x`)).toBe(false);
	});

	it("matches entries below a trailing '**' and everything for a lone '**'", () => {
		expect(matches("**/parent/child/**", String.raw`C:\repo\parent\child\a\b.txt`)).toBe(true);
		expect(matches("**/parent/child/**", String.raw`C:\repo\parent\other\b.txt`)).toBe(false);
		expect(matches("**", String.raw`C:\repo\anything`)).toBe(true);
	});

	it("escapes regex metacharacters", () => {
		expect(matches("**/a.b+(c)$/x", String.raw`C:\repo\a.b+(c)$\x`)).toBe(true);
		expect(matches("**/a.b/x", String.raw`C:\repo\aXb\x`)).toBe(false);
	});

	it("supports character classes, negation, and ranges without matching separators", () => {
		expect(matches("**/[ab].ts", String.raw`C:\repo\b.ts`)).toBe(true);
		expect(matches("**/[ab].ts", String.raw`C:\repo\c.ts`)).toBe(false);
		expect(matches("**/[a-c].ts", String.raw`C:\repo\b.ts`)).toBe(true);
		expect(matches("**/[!a].ts", String.raw`C:\repo\b.ts`)).toBe(true);
		expect(matches("**/[!a].ts", String.raw`C:\repo\a.ts`)).toBe(false);
		expect(matches("**/x[!a]y", String.raw`C:\repo\x\y`)).toBe(false);
		expect(matches("**/[-&~^].ts", String.raw`C:\repo\&.ts`)).toBe(true);
		expect(matches("**/[]].ts", String.raw`C:\repo\].ts`)).toBe(true);
	});

	it("supports brace alternation, including nested braces and separators inside braces", () => {
		expect(matches("**/{src,lib}/*.ts", String.raw`C:\repo\lib\a.ts`)).toBe(true);
		expect(matches("**/{src,lib}/*.ts", String.raw`C:\repo\test\a.ts`)).toBe(false);
		expect(matches("**/*.{ts,{m,c}js}", String.raw`C:\repo\a.mjs`)).toBe(true);
		expect(matches("**/{src/a,lib}.ts", String.raw`C:\repo\src\a.ts`)).toBe(true);
	});

	it("treats unclosed classes and braces as literals", () => {
		expect(matches("**/a[b", String.raw`C:\repo\a[b`)).toBe(true);
		expect(matches("**/a{b", String.raw`C:\repo\a{b`)).toBe(true);
	});
});
