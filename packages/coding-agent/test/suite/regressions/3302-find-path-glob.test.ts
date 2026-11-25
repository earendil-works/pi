import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/3302
 *
 * The `find` tool advertises glob patterns like `src/**\/*.spec.ts`, but the
 * default fd-backed implementation used `fd --glob <pattern>` without
 * `--full-path`, which makes fd match only against the basename. Any pattern
 * containing a `/` therefore silently returned no matches.
 *
 * The fix switches fd into full-path mode when the pattern contains a `/`
 * and prepends `**\/` so the pattern can match against the absolute candidate
 * path that fd feeds to the matcher.
 */
describe("issue #3302 find returns no results for path-based glob patterns", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-3302-"));
		mkdirSync(join(tempRoot, "some", "parent", "child"), { recursive: true });
		mkdirSync(join(tempRoot, "src", "foo", "bar"), { recursive: true });
		writeFileSync(join(tempRoot, "some", "parent", "child", "file.ext"), "");
		writeFileSync(join(tempRoot, "some", "parent", "child", "test.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "foo", "bar", "example.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "direct.spec.ts"), "");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runFind(pattern: string): Promise<string[]> {
		const def = createFindToolDefinition(tempRoot);
		// The find tool implementation does not touch ctx; pass a minimal stub.
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		if (text === "No files found matching pattern") return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["));
	}

	it("basename pattern still matches (regression-safe)", async () => {
		const files = await runFind("*.spec.ts");
		expect(files.sort()).toEqual([
			"some/parent/child/test.spec.ts",
			"src/direct.spec.ts",
			"src/foo/bar/example.spec.ts",
		]);
	});

	it("directory-prefixed pattern with ** tail matches subtree", async () => {
		const files = await runFind("some/parent/child/**");
		// Matches files (and possibly directories) under the subtree. Assert the two files are present.
		expect(files).toContain("some/parent/child/file.ext");
		expect(files).toContain("some/parent/child/test.spec.ts");
		// Like fd's glob, 'dir/**' matches entries below 'dir', not 'dir' itself.
		expect(files).not.toContain("some/parent/child/");
	});

	it("leading ** wildcard with path segments matches", async () => {
		const files = await runFind("**/parent/child/*");
		expect(files.sort()).toContain("some/parent/child/file.ext");
		expect(files.sort()).toContain("some/parent/child/test.spec.ts");
	});

	it("src/**/*.spec.ts matches direct and nested spec files", async () => {
		const files = await runFind("src/**/*.spec.ts");
		expect(files.sort()).toEqual(["src/direct.spec.ts", "src/foo/bar/example.spec.ts"]);
	});

	it("src/*.spec.ts does not cross directories", async () => {
		const files = await runFind("src/*.spec.ts");
		expect(files).toEqual(["src/direct.spec.ts"]);
	});

	// https://github.com/earendil-works/pi/issues/9262: on Windows, `\` is a path separator.
	// On POSIX it is a glob escape character, so these cases are Windows-only.
	it.runIf(process.platform === "win32")("Windows backslash patterns match like forward-slash patterns", async () => {
		expect((await runFind(String.raw`src\**\*.spec.ts`)).sort()).toEqual([
			"src/direct.spec.ts",
			"src/foo/bar/example.spec.ts",
		]);
		expect(await runFind(String.raw`src\*.spec.ts`)).toEqual(["src/direct.spec.ts"]);
		expect((await runFind(String.raw`**\parent\child\*`)).sort()).toEqual([
			"some/parent/child/file.ext",
			"some/parent/child/test.spec.ts",
		]);
		expect((await runFind(String.raw`src\**/*.spec.ts`)).sort()).toEqual([
			"src/direct.spec.ts",
			"src/foo/bar/example.spec.ts",
		]);
	});

	it("path patterns support braces, classes, and literal regex characters", async () => {
		writeFileSync(join(tempRoot, "src", "a&b (1).ts"), "");
		expect((await runFind("{src,some}/**/[et]*.spec.ts")).sort()).toEqual([
			"some/parent/child/test.spec.ts",
			"src/foo/bar/example.spec.ts",
		]);
		expect(await runFind("src/[!x]&b (1).ts")).toEqual(["src/a&b (1).ts"]);
	});

	it("path patterns stop at the result limit", async () => {
		const def = createFindToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = await def.execute("call-1", { pattern: "src/**/*.spec.ts", limit: 1 }, undefined, undefined, ctx);
		expect(result.details?.resultLimitReached).toBe(1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.split("\n")[0]).toMatch(/^src\/(direct|foo\/bar\/example)\.spec\.ts$/);
	});

	it.runIf(process.platform !== "win32")("POSIX backslash still escapes glob characters", async () => {
		writeFileSync(join(tempRoot, "src", "*.ts"), "");
		writeFileSync(join(tempRoot, "src", "other.ts"), "");
		expect(await runFind(String.raw`src/\*.ts`)).toEqual(["src/*.ts"]);
	});
});
