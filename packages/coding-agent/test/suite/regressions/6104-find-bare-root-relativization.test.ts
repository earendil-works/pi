import { describe, expect, it } from "vitest";
import { relativizeSearchResult } from "../../../src/core/tools/find.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/6104
 *
 * `path.resolve` strips a trailing separator from every path except a bare root
 * (e.g. "/", "C:\"), where it is kept. The find tool relativized results with
 * `slice(searchPath.length + 1)`, assuming a separator always follows the search
 * root — so for a bare root it dropped the first character of the first segment.
 * On Windows the trailing-slash guard also ran before `toPosixPath`, turning a
 * "\"-terminated path into a doubled "//".
 *
 * The bare-root case cannot be exercised through a temp directory, so this tests
 * the extracted relativization helper directly. The "/" cases run on any POSIX
 * host (the confirmed Linux reproduction); the fix's POSIX-first ordering handles
 * the Windows "\" separator by construction.
 */
describe("issue #6104 find relativization from a bare root", () => {
	it("preserves the full first segment when the search root is the filesystem root", () => {
		// Previously returned "I/Models/gemma4/" — the first character of "AI" was eaten.
		expect(relativizeSearchResult("/AI/Models/gemma4/", "/")).toBe("AI/Models/gemma4/");
		expect(relativizeSearchResult("/AI/notes.txt", "/")).toBe("AI/notes.txt");
	});

	it("keeps a single trailing slash for a directory result from a bare root", () => {
		expect(relativizeSearchResult("/dir/", "/")).toBe("dir/");
	});

	it("still strips the separator for non-root search paths", () => {
		expect(relativizeSearchResult("/deeper/dir/sub/", "/deeper")).toBe("dir/sub/");
		expect(relativizeSearchResult("/deeper/file.txt", "/deeper")).toBe("file.txt");
	});
});
