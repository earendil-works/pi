// Tests of the files index's rules on their own (decision "Files v2"): space names, paths, the folder a path is in.
// The index's tables, queries and changes are tested through `Files` in `files.test.ts`.

import { describe, expect, it } from "vitest";
import { checkPath, checkSpace, parentOf } from "../../../src/node/app/files-index.ts";

describe("names and paths", () => {
	it("takes space names of lower case, digits, '.', '_' and '-', at most 64", () => {
		for (const space of ["shared", "artifacts", "a.b_c-1", "x".repeat(64)])
			expect(() => checkSpace(space)).not.toThrow();
		for (const space of ["", "Shared", "-a", "a/b", "a b", "x".repeat(65)]) {
			expect(() => checkSpace(space)).toThrow(expect.objectContaining({ code: "invalid" }));
		}
	});

	it("takes paths of non-empty segments without '.' or '..'; the root only as a folder", () => {
		for (const path of ["a", "docs/report.md", "a b/ü/.hidden", "x".repeat(1024)]) {
			expect(() => checkPath(path, "file")).not.toThrow();
		}
		for (const path of ["", "/a", "a/", "a//b", ".", "..", "a/./b", "a/../b", "a\0b", "x".repeat(1025)]) {
			expect(() => checkPath(path, "file")).toThrow(expect.objectContaining({ code: "invalid" }));
		}
		expect(() => checkPath("", "folder")).not.toThrow();
	});

	it("names the folder a path is in", () => {
		expect(parentOf("a")).toBe("");
		expect(parentOf("docs/a")).toBe("docs");
		expect(parentOf("docs/sub/a")).toBe("docs/sub");
	});
});
