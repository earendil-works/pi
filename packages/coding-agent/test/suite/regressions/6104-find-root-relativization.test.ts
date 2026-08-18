import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { createFindToolDefinition, relativizeFindResultPath } from "../../../src/core/tools/find.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/6104
 *
 * path.resolve() preserves a trailing separator when resolving to a root path,
 * such as POSIX / or Windows I:\\. The find tool used to slice absolute
 * results at searchPath.length + 1, which dropped the first character of the
 * first path segment for root searches. Windows directory results that ended in
 * backslash also gained an extra slash.
 */
describe("issue #6104 find relativizes root search paths", () => {
	describe("Windows drive root", () => {
		const searchRoot = "I:\\";

		it("preserves the first segment and emits one trailing slash for fd directory output", () => {
			expect(relativizeFindResultPath("I:\\AI\\Models\\TextGen\\gemma4\\", searchRoot, win32)).toBe(
				"AI/Models/TextGen/gemma4/",
			);
		});

		it("handles fd output that uses forward slashes under a drive root", () => {
			expect(relativizeFindResultPath("I:/AI/Models/TextGen/gemma4/", searchRoot, win32)).toBe(
				"AI/Models/TextGen/gemma4/",
			);
		});

		it("keeps deeper search paths unchanged", () => {
			expect(relativizeFindResultPath("I:\\AI\\Models\\", "I:\\AI", win32)).toBe("Models/");
		});

		it("does not relativize a sibling directory that shares a name prefix", () => {
			expect(relativizeFindResultPath("I:\\AI\\Models2\\file.txt", "I:\\AI\\Models", win32)).toBe(
				"../Models2/file.txt",
			);
		});

		it("normalizes relative custom-glob results without corrupting them", () => {
			expect(relativizeFindResultPath("AI\\Models\\TextGen\\gemma4\\", searchRoot, win32)).toBe(
				"AI/Models/TextGen/gemma4/",
			);
		});
	});

	describe("POSIX root", () => {
		it("preserves the first segment for files under /", () => {
			expect(relativizeFindResultPath("/home/user/file.txt", "/", posix)).toBe("home/user/file.txt");
		});

		it("preserves the first segment and one trailing slash for directories under /", () => {
			expect(relativizeFindResultPath("/home/user/project/", "/", posix)).toBe("home/user/project/");
		});

		it("preserves backslashes in POSIX filenames", () => {
			expect(relativizeFindResultPath("/home/user/file\\", "/home/user", posix)).toBe("file\\");
		});
	});

	describe("absolute results outside the search path", () => {
		it("falls back to path.relative when the absolute paths do not share a prefix", () => {
			expect(relativizeFindResultPath("/tmp/results/file.txt", "/workspace/project", posix)).toBe(
				"../../tmp/results/file.txt",
			);
		});

		it("keeps a trailing slash on directories resolved through path.relative", () => {
			expect(relativizeFindResultPath("/tmp/results/dir/", "/workspace/project", posix)).toBe(
				"../../tmp/results/dir/",
			);
		});
	});

	describe("through the find tool", () => {
		it("relativizes custom glob results against a root search path", async () => {
			const def = createFindToolDefinition("/", {
				operations: {
					exists: () => true,
					glob: () => ["/home/user/project/", "/home/user/project/file.txt"],
				},
			});
			// The find tool implementation does not touch ctx; pass a minimal stub.
			const ctx = {} as Parameters<typeof def.execute>[4];
			const result = (await def.execute("call-1", { pattern: "**" }, undefined, undefined, ctx)) as {
				content: Array<{ type: string; text?: string }>;
			};
			expect(result.content[0]?.text).toBe("home/user/project/\nhome/user/project/file.txt");
		});
	});
});
